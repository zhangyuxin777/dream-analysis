/**
 * 同步状态（水位线）+ 拉取计划（纯函数）。
 *
 * 幂等的**唯一判据是 ETag**：上传侧"当天分片反复重算覆盖"是设计意图，
 * 所以"内容变了"必须能被识别 → ETag 变了就重拉 + 按天整体重建（我们不做行级增量合并，
 * 天分片是自洽快照，整份替换天然不会出现"半新半旧"）。
 *
 * 失败处理的关键取舍（P5 review 之后改的，别再改回去）：
 * **失败不是拉黑，是退避**。早期实现是"连续失败 3 次 ⇒ 永不重试"，
 * 但失败原因绝大多数在**我们这侧**（403/网络/磁盘满/凭据轮换）或**上传侧已修好**（ETag 会变），
 * 永久拉黑会把自己关掉 —— 而且 `final:true` 的历史天 ETag 永不变，那一天就永久缺失。
 * 现在：① ETag 一变立刻允许重试 ② 未变时按 30min×2^n（上限 6h）冷却 ③ 冷却中的分片进 `deferred`，在日志与 status 里可见。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ObjectMeta } from '../oss/store';
import { parseShardKey } from '../ndjson/types';

export interface ObjectState {
  etag: string;
  size: number;
  /** 校验通过的数据行数 */
  dataLines: number;
  /** 上传侧 header 的 final（false = 当天未封存） */
  final: boolean;
  pulledAt: string;
  warnings: string[];
  /** 上传侧的白名单版本（口径变更要能在报告里标注） */
  whitelistVersion?: string;
}

/** 失败记录：**带 ETag 与时间**，才能既"换内容就重试"又"同内容退避" */
export interface SuspectState {
  count: number;
  etag: string;
  lastErrorAt: string;
}

/**
 * **淘汰墓碑**：本地按保留期/磁盘上限删掉的分片，记下删时的 ETag。
 *
 * 为什么必须有：淘汰曾经连水位线条目一起删 ⇒ 桶里仍在的老对象下一轮又变成"本地没有" ⇒
 * **重新下载 → 再淘汰 → 再下载**（每小时一轮、无限循环，日志看起来还完全正常）。
 * 上传侧的 OSS 没有生命周期清理，所以这个循环一旦开始就永不停止（实测：修之前一定会重拉）。
 *
 * 墓碑不是拉黑：**ETag 变了（上传侧重算/封存）照样重拉** ✓
 */
export interface PrunedTombstone {
  /** 淘汰那一刻该对象的 ETag（空串 = 当时不知道，退化为"总是允许重拉"） */
  etag: string;
  prunedAt: string;
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  listed: number;
  pulled: number;
  skipped: number;
  ignored: number;
  failed: number;
  bytes: number;
  errors: string[];
  /** 因退避冷却被推迟的分片数 */
  deferred?: number;
  /** 本次检测到的口径（whitelistVersion）变更说明 */
  whitelistChanges?: string[];
  /** 本轮是否因为"另一个同步正在进行"而整体跳过 */
  refusedByLock?: boolean;
  /** 本轮淘汰掉的本地分片数（持久化下来，status 才看得出"最近还在不在淘汰"） */
  pruned?: number;
}

export interface SyncState {
  version: 1;
  /** key → 已入库的对象状态 */
  objects: Record<string, ObjectState>;
  /** key → 失败退避状态 */
  suspects: Record<string, SuspectState>;
  /** key → 已淘汰墓碑（同 ETag 不再重拉） */
  pruned: Record<string, PrunedTombstone>;
  lastRun: RunSummary | null;
}

export function emptyState(): SyncState {
  return { version: 1, objects: {}, suspects: {}, pruned: {}, lastRun: null };
}

/**
 * 读状态：文件缺失/损坏都**不抛**（宁可从头拉一遍，也不能因为状态文件坏了就起不来）。
 * 兼容旧格式：`suspects` 曾是裸数字，读到数字时迁移成 SuspectState（etag 空 = 视为不同内容，允许立刻重试）。
 */
export function loadState(filePath: string): { state: SyncState; warnings: string[] } {
  const warnings: string[] = [];
  if (!fs.existsSync(filePath)) return { state: emptyState(), warnings };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SyncState>;
    if (raw.version !== 1 || typeof raw.objects !== 'object' || raw.objects === null) {
      warnings.push('状态文件版本/结构不符，按空状态处理');
      return { state: emptyState(), warnings };
    }
    const suspects: Record<string, SuspectState> = {};
    for (const [key, value] of Object.entries((raw.suspects as Record<string, unknown>) ?? {})) {
      if (typeof value === 'number') {
        suspects[key] = { count: value, etag: '', lastErrorAt: new Date(0).toISOString() };
        warnings.push(`suspects 里有旧格式条目（${key}），已迁移`);
      } else if (value && typeof value === 'object') {
        const s = value as Partial<SuspectState>;
        suspects[key] = {
          count: Number(s.count ?? 0),
          etag: String(s.etag ?? ''),
          lastErrorAt: String(s.lastErrorAt ?? new Date(0).toISOString()),
        };
      }
    }
    const pruned: Record<string, PrunedTombstone> = {};
    for (const [key, value] of Object.entries((raw.pruned as Record<string, unknown>) ?? {})) {
      if (value && typeof value === 'object') {
        const p = value as Partial<PrunedTombstone>;
        pruned[key] = { etag: String(p.etag ?? ''), prunedAt: String(p.prunedAt ?? new Date(0).toISOString()) };
      }
    }
    return {
      state: { version: 1, objects: raw.objects as Record<string, ObjectState>, suspects, pruned, lastRun: raw.lastRun ?? null },
      warnings,
    };
  } catch (err) {
    warnings.push(`状态文件解析失败（按空状态处理）：${err instanceof Error ? err.message : String(err)}`);
    return { state: emptyState(), warnings };
  }
}

/** 原子写（tmp + rename），键排序保证 diff 稳定；父目录自动建 */
export function saveState(filePath: string, state: SyncState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sorted: SyncState = { version: 1, objects: {}, suspects: {}, pruned: {}, lastRun: state.lastRun };
  for (const key of Object.keys(state.objects).sort()) sorted.objects[key] = state.objects[key];
  for (const key of Object.keys(state.suspects).sort()) sorted.suspects[key] = state.suspects[key];
  for (const key of Object.keys(state.pruned ?? {}).sort()) sorted.pruned[key] = state.pruned[key];
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** 退避时长：30min × 2^(n-1)，上限 6h（n = 连续失败次数） */
export function suspectCooldownMs(count: number): number {
  const base = 30 * 60_000;
  const cap = 6 * 3600_000;
  const exponent = Math.max(0, Math.min(10, count - 1));
  return Math.min(base * Math.pow(2, exponent), cap);
}

export type SkipReason = 'etag-unchanged' | 'too-fresh' | 'suspect-cooldown' | 'pruned';
export type IgnoreReason = 'key-not-matching-contract';

export interface DeferredShard {
  key: string;
  count: number;
  retryAfterMs: number;
}

export interface PullPlan {
  toPull: ObjectMeta[];
  skipped: Array<{ key: string; reason: SkipReason }>;
  ignored: Array<{ key: string; reason: IgnoreReason; detail: string }>;
  /** 本轮识别出的"被重算覆盖"的键（ETag 变了）—— 用于日志，不是失败 */
  recomputed: string[];
  /** 因失败退避被推迟的分片（**必须可见**：静默推迟等于静默停同步） */
  deferred: DeferredShard[];
}

export interface PlanOptions {
  prefix: string;
  minAgeSeconds: number;
  now: Date;
  force?: boolean;
}

/**
 * 决定这一轮拉什么（纯函数，单测主战场）。
 *
 * 顺序即优先级：
 * 1. 键不匹配契约 → ignored（**绝不猜、绝不拉**）
 * 2. ETag 相同 → skipped（幂等；`force` 时忽略此条）
 * 3. `LastModified` 太新（不足 minAgeSeconds）→ skipped（防竞态读半成品）
 * 4. 上一次失败且**内容未变**、冷却未到 → skipped + deferred（换内容则立刻重试）
 */
export function planPull(metas: ObjectMeta[], state: SyncState, opts: PlanOptions): PullPlan {
  const plan: PullPlan = { toPull: [], skipped: [], ignored: [], recomputed: [], deferred: [] };

  for (const meta of metas) {
    const parsed = parseShardKey(meta.key, opts.prefix);
    if (!parsed) {
      plan.ignored.push({
        key: meta.key,
        reason: 'key-not-matching-contract',
        detail: `前缀 ${opts.prefix} 下不符合 <prefix><instance>/<date>.jsonl.gz`,
      });
      continue;
    }

    const known = state.objects[meta.key];
    if (known && known.etag === meta.etag && !opts.force) {
      plan.skipped.push({ key: meta.key, reason: 'etag-unchanged' });
      continue;
    }
    if (known && known.etag !== meta.etag) plan.recomputed.push(meta.key);

    // 已淘汰过的（本地按保留期删掉了、但桶里还在）：见 PrunedTombstone 注释。两种情形分开处理：
    // ① 墓碑**没有** ETag（淘汰时水位线丢了/状态文件损坏过）：一律 skip。
    //    若放行，桶里那老对象每轮都会被重下再淘汰 —— 正是本次要修的循环原地复活。
    // ② 墓碑有 ETag：**只挡"内容没变"**。ETag 变了（上传侧重算/补数）⇒ 放行一次，
    //    重下后同一轮又会被淘汰、墓碑用新 ETag 重建 ⇒ 每次远端变更最多多下一次，不会循环。
    //    （不能一律 skip：那会让"上传侧补数了这一天"被永久忽略，且与本文件承诺的"ETag 变了就重拉"矛盾。）
    const tombstone = state.pruned?.[meta.key];
    if (tombstone && !opts.force) {
      if (tombstone.etag === '' || tombstone.etag === meta.etag) {
        plan.skipped.push({ key: meta.key, reason: 'pruned' });
        continue;
      }
      plan.recomputed.push(meta.key); // 淘汰过但远端翻新了 ⇒ 再拉一次（随后会被重新淘汰）
    }

    if (meta.lastModifiedMs !== null) {
      const ageSeconds = (opts.now.getTime() - meta.lastModifiedMs) / 1000;
      if (!opts.force && ageSeconds < opts.minAgeSeconds) {
        plan.skipped.push({ key: meta.key, reason: 'too-fresh' });
        continue;
      }
    }

    const suspect = state.suspects[meta.key];
    if (suspect && !opts.force) {
      // 内容没变才退避；ETag 变了 = 上传侧重算过，立刻给一次机会
      const sameContent = suspect.etag !== '' && suspect.etag === meta.etag;
      if (sameContent) {
        const cooldown = suspectCooldownMs(suspect.count);
        const waited = opts.now.getTime() - Date.parse(suspect.lastErrorAt);
        if (!Number.isFinite(waited) || waited < cooldown) {
          plan.skipped.push({ key: meta.key, reason: 'suspect-cooldown' });
          plan.deferred.push({
            key: meta.key,
            count: suspect.count,
            retryAfterMs: Number.isFinite(waited) ? Math.max(0, cooldown - waited) : cooldown,
          });
          continue;
        }
      }
    }

    plan.toPull.push(meta);
  }

  return plan;
}

/** 本地已落地的天分片（按日期升序） */
export interface LocalShard {
  instance: string;
  date: string;
  filePath: string;
  size: number;
}

/** 扫描本地 `data/<instance>/<date>.jsonl.gz` */
export function listLocalShards(dataDir: string): LocalShard[] {
  const out: LocalShard[] = [];
  if (!fs.existsSync(dataDir)) return out;
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const instanceDir = path.join(dataDir, entry.name);
    for (const f of fs.readdirSync(instanceDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.jsonl.gz')) continue;
      const date = f.name.replace(/\.jsonl\.gz$/, '');
      const filePath = path.join(instanceDir, f.name);
      out.push({ instance: entry.name, date, filePath, size: fs.statSync(filePath).size });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.instance.localeCompare(b.instance) : a.date.localeCompare(b.date)));
}

/**
 * 选出该淘汰的本地分片（纯函数）：先按保留天数，再按磁盘上限，**从最旧开始删**。
 * 两条规则都保留"至少留一份"的底线（全删光会让下次同步变成全量重拉，且删了就查不了历史）。
 */
export function selectShardsToPrune(
  shards: LocalShard[],
  opts: { retentionDays: number; maxDiskGB: number; now: Date },
): LocalShard[] {
  // 显式 (日期, 实例)：同一天多实例时"先淘汰哪个实例"也必须确定，不依赖调用方给的顺序
  const ascending = [...shards].sort((a, b) => (a.date === b.date ? a.instance.localeCompare(b.instance) : a.date.localeCompare(b.date)));
  const doomed = new Set<string>();
  const cutoffMs = opts.now.getTime() - opts.retentionDays * 24 * 3600 * 1000;

  for (const s of ascending) {
    const ts = Date.parse(`${s.date}T00:00:00+08:00`);
    if (Number.isFinite(ts) && ts < cutoffMs) doomed.add(s.filePath);
  }

  const budget = opts.maxDiskGB * 1024 * 1024 * 1024;
  let total = ascending.reduce((sum, s) => sum + (doomed.has(s.filePath) ? 0 : s.size), 0);
  for (const s of ascending) {
    if (total <= budget) break;
    if (doomed.has(s.filePath)) continue;
    doomed.add(s.filePath);
    total -= s.size;
  }

  // 底线：至少留一份（留下的那份不算"被淘汰"）
  const survivors = ascending.filter((s) => !doomed.has(s.filePath));
  if (survivors.length === 0 && ascending.length > 0) {
    const last = ascending[ascending.length - 1];
    doomed.delete(last.filePath);
  }

  return ascending.filter((s) => doomed.has(s.filePath));
}
