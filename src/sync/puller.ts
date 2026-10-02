/**
 * 拉取器：把 OSS 上的天分片拉到本地，幂等、可中断、失败不炸。
 *
 * 流程（对应 `DESIGN.md` §五）：
 *   取跨进程锁 → list(prefix) → planPull（纯函数决定拉什么）→ 逐个下载到 .tmp → 校验 → 原子 rename
 *   → 更新水位线 → 淘汰过期/超限分片 → 落盘状态 → 释放锁
 *
 * 三条不可动摇的取舍：
 * - **校验不过绝不入库**：宁可这轮没数据，也不能把"行数不符/解压失败"的分片当正常数据喂给分析器。
 * - **原子 rename**：分析器看到的永远是完整文件（同卷 rename 是原子的）。
 * - **单并发 + 串行**：进程内由调度器保证，跨进程由 `sync.lock` 保证（手动 `sync` 撞上常驻同步时拒绝而非互相踩）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../config';
import { ILogger } from '../common/logger';
import { ObjectStore } from '../oss/store';
import { readShard } from '../ndjson/shard';
import { buildShardKey, parseShardKey } from '../ndjson/types';
import { acquireLock, releaseLock } from './lock';
import { DeferredShard, listLocalShards, loadState, planPull, saveState, selectShardsToPrune, SyncState } from './state';

export interface PullDeps {
  store: ObjectStore;
  config: AppConfig;
  logger: ILogger;
  /** 注入时钟（可测性） */
  now?: () => Date;
  /** 注入锁令牌（测试用；默认 pid+时间） */
  lockToken?: string;
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
  /** 因失败退避被推迟的分片（必须可见） */
  deferred: DeferredShard[];
  /** 本轮检测到的数据口径（whitelistVersion）变更 */
  whitelistChanges: string[];
  /** 因为"已有同步在进行"而整体跳过 */
  refusedByLock: boolean;
}

/** 锁的过期时长：硬杀进程留下的锁最多挡 30 分钟（同步间隔 60 分钟 ⇒ 不会卡死） */
export const LOCK_STALE_MS = 30 * 60_000;

export function statePathOf(config: AppConfig): string {
  return path.join(config.runtime.stateDir, 'sync-state.json');
}

export function lockPathOf(config: AppConfig): string {
  return path.join(config.runtime.stateDir, 'sync.lock');
}

export function shardPathOf(config: AppConfig, instance: string, date: string): string {
  return path.join(config.runtime.dataDir, instance, `${date}.jsonl.gz`);
}

export function tmpPathOf(config: AppConfig, instance: string, date: string): string {
  return path.join(config.runtime.dataDir, '.tmp', instance, `${date}.jsonl.gz`);
}

/** 取跨进程锁后跑一次同步；拿不到锁就**明确拒绝**（不排队、不硬闯） */
export async function runSync(deps: PullDeps, opts: { force?: boolean } = {}): Promise<PullResult> {
  const { config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const lockPath = lockPathOf(config);
  const token = deps.lockToken ?? `${process.pid}-${now().getTime()}`;

  const lock = acquireLock(lockPath, { now: now(), staleMs: LOCK_STALE_MS, token });
  if (!lock.ok) {
    logger.warn('已有同步正在进行，本轮跳过（跨进程互斥，不排队）', {
      holderPid: lock.holder?.pid ?? null,
      holderSince: lock.holder?.acquiredAt ?? null,
    });
    return {
      listed: 0, pulled: [], skipped: 0, ignored: 0, failed: [], bytes: 0, pruned: [],
      warnings: [], recomputed: [], deferred: [], whitelistChanges: [], refusedByLock: true,
    };
  }

  try {
    return await syncOnce(deps, opts);
  } finally {
    releaseLock(lockPath, token);
  }
}

async function syncOnce(deps: PullDeps, opts: { force?: boolean }): Promise<PullResult> {
  const { store, config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const warnings: string[] = [];
  const whitelistChanges: string[] = [];

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
  if (plan.deferred.length > 0) {
    logger.warn('有分片处于失败退避期，本轮不重试（换内容会立刻重试）', {
      count: plan.deferred.length,
      sample: plan.deferred.slice(0, 5).map((d) => ({ key: d.key, failures: d.count, retryInMs: d.retryAfterMs })),
    });
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
    deferred: plan.deferred,
    whitelistChanges,
    refusedByLock: false,
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

      const whitelistVersion = stats.header?.whitelistVersion;
      if (whitelistVersion) {
        const previous = newestWhitelistVersion(state, config.oss.prefix, parsed.instance, meta.key);
        if (previous && previous !== whitelistVersion) {
          const detail = `${parsed.instance}: ${previous} → ${whitelistVersion}（自 ${parsed.date}）`;
          whitelistChanges.push(detail);
          logger.warn('数据口径（白名单版本）发生变化 —— 跨这次变更前后的统计不可直接比较', { detail });
        }
      }

      state.objects[meta.key] = {
        etag: meta.etag,
        size: meta.size,
        dataLines: stats.dataLines,
        final: stats.header?.final ?? false,
        pulledAt: now().toISOString(),
        warnings: stats.warnings,
        whitelistVersion,
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
      const count = (state.suspects[meta.key]?.count ?? 0) + 1;
      state.suspects[meta.key] = { count, etag: meta.etag, lastErrorAt: now().toISOString() };
      result.failed.push({ key: meta.key, error: detail });
      logger.error('拉取/校验失败（将按退避重试，换内容立即重试）', { key: meta.key, attempts: count, detail });
      if (count >= 3) {
        logger.error('该分片连续失败 ≥3 次，需要人看一眼（上传侧生成 or 本地环境？）', { key: meta.key, attempts: count });
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
    deferred: result.deferred.length,
    whitelistChanges: result.whitelistChanges,
  };
  saveState(statePath, state);

  logger.info('同步完成', {
    listed: result.listed,
    pulled: result.pulled.length,
    skipped: result.skipped,
    ignored: result.ignored,
    failed: result.failed.length,
    deferred: result.deferred.length,
    bytes: result.bytes,
    pruned: result.pruned.length,
  });
  return result;
}

/** 同一实例下"最新的另一份分片"记录的口径版本（用于识别口径变更） */
export function newestWhitelistVersion(state: SyncState, prefix: string, instance: string, excludeKey: string): string | undefined {
  const scoped = `${prefix}${instance}/`;
  const keys = Object.keys(state.objects)
    .filter((k) => k.startsWith(scoped) && k !== excludeKey)
    .sort();
  for (let i = keys.length - 1; i >= 0; i--) {
    const version = state.objects[keys[i]].whitelistVersion;
    if (version) return version;
  }
  return undefined;
}

/** 删除临时文件：失败也不抛（它只是垃圾） */
export function safeUnlink(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 故意吞掉
  }
}
