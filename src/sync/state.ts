/**
 * 同步状态（水位线）+ 拉取计划（纯函数）。
 *
 * 幂等的**唯一判据是 ETag**：上传侧"当天分片反复重算覆盖"是设计意图，
 * 所以"内容变了"必须能被识别 → ETag 变了就重拉 + 按天整体重建（我们不做行级增量合并，
 * 天分片是自洽快照，整份替换天然不会出现"半新半旧"）。
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
}

export interface SyncState {
  version: 1;
  /** key → 已入库的对象状态 */
  objects: Record<string, ObjectState>;
  /** key → 连续失败次数（连续 3 轮触发告警用） */
  suspects: Record<string, number>;
  lastRun: RunSummary | null;
}

export function emptyState(): SyncState {
  return { version: 1, objects: {}, suspects: {}, lastRun: null };
}

/**
 * 读状态：文件缺失/损坏都**不抛**（宁可从头拉一遍，也不能因为状态文件坏了就起不来）。
 * 损坏时返回 warnings，由调用方记日志。
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
    const state: SyncState = {
      version: 1,
      objects: raw.objects as Record<string, ObjectState>,
      suspects: (raw.suspects as Record<string, number>) ?? {},
      lastRun: raw.lastRun ?? null,
    };
    return { state, warnings };
  } catch (err) {
    warnings.push(`状态文件解析失败（按空状态处理）：${err instanceof Error ? err.message : String(err)}`);
    return { state: emptyState(), warnings };
  }
}

/** 原子写（tmp + rename），键排序保证 diff 稳定；父目录自动建 */
export function saveState(filePath: string, state: SyncState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sorted: SyncState = {
    version: 1,
    objects: {},
    suspects: {},
    lastRun: state.lastRun,
  };
  for (const key of Object.keys(state.objects).sort()) sorted.objects[key] = state.objects[key];
  for (const key of Object.keys(state.suspects).sort()) sorted.suspects[key] = state.suspects[key];
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

export type SkipReason = 'etag-unchanged' | 'too-fresh' | 'suspect-limit';
export type IgnoreReason = 'key-not-matching-contract';

export interface PullPlan {
  toPull: ObjectMeta[];
  skipped: Array<{ key: string; reason: SkipReason }>;
  ignored: Array<{ key: string; reason: IgnoreReason; detail: string }>;
  /** 本轮识别出的"被重算覆盖"的键（ETag 变了）——用于日志/告警，不是失败 */
  recomputed: string[];
}

export interface PlanOptions {
  prefix: string;
  minAgeSeconds: number;
  now: Date;
  force?: boolean;
  /** 连续失败达到这个次数就不再重试（防病态对象把每轮都拖住） */
  maxSuspects?: number;
}

/**
 * 决定这一轮拉什么（纯函数，单测主战场）。
 *
 * 顺序即优先级：
 * 1. 键不匹配契约 → ignored（**绝不猜、绝不拉**）
 * 2. ETag 相同 → skipped（幂等；`force` 时忽略此条）
 * 3. `LastModified` 太新（不足 minAgeSeconds）→ skipped（防竞态读半成品）
 * 4. 连续失败达上限 → skipped（suspect-limit）
 */
export function planPull(metas: ObjectMeta[], state: SyncState, opts: PlanOptions): PullPlan {
  const plan: PullPlan = { toPull: [], skipped: [], ignored: [], recomputed: [] };
  const maxSuspects = opts.maxSuspects ?? 3;

  for (const meta of metas) {
    const parsed = parseShardKey(meta.key, opts.prefix);
    if (!parsed) {
      plan.ignored.push({ key: meta.key, reason: 'key-not-matching-contract', detail: `前缀 ${opts.prefix} 下不符合 snapshot/<instance>/<date>.jsonl.gz` });
      continue;
    }

    const known = state.objects[meta.key];
    if (known && known.etag === meta.etag && !opts.force) {
      plan.skipped.push({ key: meta.key, reason: 'etag-unchanged' });
      continue;
    }
    if (known && known.etag !== meta.etag) plan.recomputed.push(meta.key);

    if (meta.lastModifiedMs !== null) {
      const ageSeconds = (opts.now.getTime() - meta.lastModifiedMs) / 1000;
      if (!opts.force && ageSeconds < opts.minAgeSeconds) {
        plan.skipped.push({ key: meta.key, reason: 'too-fresh' });
        continue;
      }
    }

    const suspects = state.suspects[meta.key] ?? 0;
    if (suspects >= maxSuspects && !opts.force) {
      plan.skipped.push({ key: meta.key, reason: 'suspect-limit' });
      continue;
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
  const ascending = [...shards].sort((a, b) => a.date.localeCompare(b.date));
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
