/**
 * 数据契约类型 + 键解析（对应 `DESIGN.md` §三）。
 *
 * **这里是契约的唯一代码表达**：改这里 = 改契约，必须同步 `DESIGN.md` 与上传侧。
 */

/** 一行事件（`localDate` / `seq` 由上传侧补，消费侧靠它们做行级唯一键） */
export interface EventRecord {
  ts: string;
  event: string;
  symbol?: string;
  roundId?: string;
  data?: Record<string, unknown>;
  localDate?: string;
  seq?: number;
}

/** 天分片首行 header */
export interface DayShardHeader {
  type: 'meta';
  schema: number;
  instance: string;
  host?: string;
  date: string;
  generatedAt?: string;
  /** false = 当天未封存（会被反复重写）；true = 已封存（跨日后不再变） */
  final: boolean;
  /** 数据行数（是否含 header 行由配置 `sync.countIncludesHeader` 决定） */
  count?: number;
  firstTs?: string;
  lastTs?: string;
  /** 白名单版本（口径变更时消费侧要在报告里标注；上传侧尚未提供时缺省） */
  whitelistVersion?: string;
}

/** 分片键解析结果 */
export interface ShardKey {
  instance: string;
  date: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 实例名/日期等只允许安全字符（防止键里混入奇怪字符导致路径穿越或匹配歧义） */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 按配置的前缀构造分片键正则。
 * 前缀会做转义（`snapshot/` 里的 `/` 不该被当成分隔符语义），因此这里手工拼装而不直接 `new RegExp(prefix)`。
 */
export function buildShardKeyRe(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}([^/]+)/(\\d{4}-\\d{2}-\\d{2})\\.jsonl\\.gz$`);
}

/**
 * 解析分片键；**不匹配返回 null**（调用方必须"忽略 + warn"，不许猜）。
 * 同时校验片段合法性：实例名必须是安全字符、日期必须是合法日期（`2026-13-45` 不接受）。
 */
export function parseShardKey(key: string, prefix: string): ShardKey | null {
  const m = buildShardKeyRe(prefix).exec(key);
  if (!m) return null;
  const instance = m[1];
  const date = m[2];
  if (!SAFE_SEGMENT_RE.test(instance)) return null;
  if (!DATE_RE.test(date)) return null;
  if (!isRealDate(date)) return null;
  return { instance, date };
}

/** `2026-02-30` 这种"格式对但日子不存在"的也要拦下 */
export function isRealDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 反拼分片键（消费侧拼本地路径、单测都靠它，避免两处手写格式） */
export function buildShardKey(prefix: string, instance: string, date: string): string {
  return `${prefix}${instance}/${date}.jsonl.gz`;
}

/** header 形状校验（外部数据一律先校验再用） */
export function isShardHeader(v: unknown): v is DayShardHeader {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  if (h.type !== 'meta') return false;
  if (typeof h.schema !== 'number') return false;
  if (typeof h.instance !== 'string' || h.instance === '') return false;
  if (typeof h.date !== 'string' || !DATE_RE.test(h.date)) return false;
  if (typeof h.final !== 'boolean') return false;
  if (h.count !== undefined && (typeof h.count !== 'number' || h.count < 0)) return false;
  return true;
}

/** 事件行形状校验（只要求最小必要字段，其余原样保留） */
export function isEventRecord(v: unknown): v is EventRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.ts !== 'string' || r.ts === '') return false;
  if (typeof r.event !== 'string' || r.event === '') return false;
  if (r.symbol !== undefined && typeof r.symbol !== 'string') return false;
  if (Number.isNaN(Date.parse(r.ts))) return false;
  return true;
}
