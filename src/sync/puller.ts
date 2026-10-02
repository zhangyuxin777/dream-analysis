/**
 * 拉取器：把 OSS 上的天分片拉到本地，幂等、可中断、失败不炸。
 *
 * 流程（对应 `DESIGN.md` §五）：
 *   list(prefix) → planPull（纯函数决定拉什么）→ 逐个下载到 .tmp → 校验 → 原子 rename → 更新水位线
 *   → 淘汰过期/超限分片 → 落盘状态
 *
 * 三条不可动摇的取舍：
 * - **校验不过绝不入库**：宁可这轮没数据，也不能把"行数不符/解压失败"的分片当正常数据喂给分析器。
 * - **原子 rename**：分析器看到的永远是完整文件（同卷 rename 是原子的）。
 * - **单并发 + 串行**：`dream-002` 上还有实盘，拉取不许抢 IO。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../config';
import { ILogger } from '../common/logger';
import { ObjectStore } from '../oss/store';
import { readShard } from '../ndjson/shard';
import { buildShardKey, parseShardKey } from '../ndjson/types';
import { listLocalShards, loadState, planPull, saveState, selectShardsToPrune, SyncState } from './state';

export interface PullDeps {
  store: ObjectStore;
  config: AppConfig;
  logger: ILogger;
  /** 注入时钟（可测性） */
  now?: () => Date;
}

export interface PullResult {
  listed: number;
  pulled: string[];
  skipped: number;
  ignored: number;
  failed: Array<{ key: string; error: string }>;
  bytes: number;
  pruned: string[];
  warnings: string[];
  recomputed: string[];
}

export function statePathOf(config: AppConfig): string {
  return path.join(config.runtime.stateDir, 'sync-state.json');
}

export function shardPathOf(config: AppConfig, instance: string, date: string): string {
  return path.join(config.runtime.dataDir, instance, `${date}.jsonl.gz`);
}

export function tmpPathOf(config: AppConfig, instance: string, date: string): string {
  return path.join(config.runtime.dataDir, '.tmp', instance, `${date}.jsonl.gz`);
}

export async function runSync(deps: PullDeps, opts: { force?: boolean } = {}): Promise<PullResult> {
  const { store, config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const warnings: string[] = [];

  fs.mkdirSync(config.runtime.dataDir, { recursive: true });
  fs.mkdirSync(config.runtime.stateDir, { recursive: true });

  const statePath = statePathOf(config);
  const loaded = loadState(statePath);
  const state: SyncState = loaded.state;
  for (const w of loaded.warnings) {
    warnings.push(w);
    logger.warn('状态文件有问题', { detail: w });
  }

  const metas = await store.list(config.oss.prefix);
  const plan = planPull(metas, state, {
    prefix: config.oss.prefix,
    minAgeSeconds: config.sync.minAgeSeconds,
    now: now(),
    force: opts.force,
  });

  if (plan.ignored.length > 0) {
    logger.warn('有对象不符合数据契约，已忽略（不猜、不拉）', {
      count: plan.ignored.length,
      sample: plan.ignored.slice(0, 5).map((i) => i.key),
      detail: plan.ignored[0].detail,
    });
  }
  if (plan.recomputed.length > 0) {
    logger.info('检测到被重算覆盖的分片（ETag 变了），将整份重建', { count: plan.recomputed.length, sample: plan.recomputed.slice(0, 5) });
  }

  const result: PullResult = {
    listed: metas.length,
    pulled: [],
    skipped: plan.skipped.length,
    ignored: plan.ignored.length,
    failed: [],
    bytes: 0,
    pruned: [],
    warnings,
    recomputed: plan.recomputed,
  };

  // 逐份串行处理（并发 1）
  for (const meta of plan.toPull) {
    const parsed = parseShardKey(meta.key, config.oss.prefix);
    if (!parsed) continue; // planPull 已保证，这里只是类型收窄
    const tmp = tmpPathOf(config, parsed.instance, parsed.date);
    try {
      await store.getTo(meta.key, tmp);
      const stats = await readShard(tmp, { countIncludesHeader: config.sync.countIncludesHeader });
      if (!stats.ok) {
        throw new Error(`分片校验失败：${stats.errors.join('；')}`);
      }
      const finalPath = shardPathOf(config, parsed.instance, parsed.date);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.renameSync(tmp, finalPath);

      state.objects[meta.key] = {
        etag: meta.etag,
        size: meta.size,
        dataLines: stats.dataLines,
        final: stats.header?.final ?? false,
        pulledAt: now().toISOString(),
        warnings: stats.warnings,
      };
      delete state.suspects[meta.key];
      result.pulled.push(meta.key);
      result.bytes += meta.size;
      logger.info('已拉取分片', {
        key: meta.key,
        size: meta.size,
        dataLines: stats.dataLines,
        final: stats.header?.final ?? null,
        warnings: stats.warnings.length,
      });
      if (stats.warnings.length > 0) {
        logger.warn('分片校验有告警（仍入库）', { key: meta.key, warnings: stats.warnings.slice(0, 5) });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const count = (state.suspects[meta.key] ?? 0) + 1;
      state.suspects[meta.key] = count;
      result.failed.push({ key: meta.key, error: detail });
      logger.error('拉取/校验失败', { key: meta.key, attempts: count, detail });
      if (count >= 3) {
        logger.error('该分片连续失败 ≥3 次，需要人看一眼（上传侧生成有问题？）', { key: meta.key, attempts: count });
      }
      safeUnlink(tmp);
    }
  }

  // 淘汰：先按保留天数，再按磁盘上限（从最旧开始）
  const doomed = selectShardsToPrune(listLocalShards(config.runtime.dataDir), {
    retentionDays: config.sync.retentionDays,
    maxDiskGB: config.sync.maxDiskGB,
    now: now(),
  });
  for (const shard of doomed) {
    safeUnlink(shard.filePath);
    delete state.objects[buildShardKey(config.oss.prefix, shard.instance, shard.date)];
    delete state.suspects[buildShardKey(config.oss.prefix, shard.instance, shard.date)];
    result.pruned.push(shard.filePath);
  }
  if (doomed.length > 0) logger.info('已淘汰本地旧分片', { count: doomed.length, sample: doomed.slice(0, 5).map((s) => `${s.instance}/${s.date}`) });

  state.lastRun = {
    startedAt,
    finishedAt: now().toISOString(),
    listed: result.listed,
    pulled: result.pulled.length,
    skipped: result.skipped,
    ignored: result.ignored,
    failed: result.failed.length,
    bytes: result.bytes,
    errors: result.failed.map((f) => `${f.key}: ${f.error}`),
  };
  saveState(statePath, state);

  logger.info('同步完成', {
    listed: result.listed,
    pulled: result.pulled.length,
    skipped: result.skipped,
    ignored: result.ignored,
    failed: result.failed.length,
    bytes: result.bytes,
    pruned: result.pruned.length,
  });
  return result;
}

/** 删除临时文件：失败也不抛（它只是垃圾） */
export function safeUnlink(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 故意吞掉
  }
}
