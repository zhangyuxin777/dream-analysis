/**
 * 时间窗口解析（纯函数）。
 *
 * 全部按**契约时区 Asia/Shanghai** 计算：分片按本地日分桶，分析窗口若用 UTC 会与分片错位。
 * 支持的写法（与机器人指令表一致）：
 *   近1h / 近24h / 近7d      今天 / 昨天
 *   2026-10-01               2026-10-01~2026-10-03（含首尾两天）
 * 默认窗口 = 昨天（当天的分片还没封存，看它容易得到"暂定"结论）。
 */
import { SHARD_TZ_OFFSET_MINUTES, isRealDate } from '../ndjson/types';

/**
 * 单次分析允许的最大窗口（30 天）。
 * **单一口径**：`analysis/types.ts` 从这里 re-export（别在两处各写一个数）。
 * 超限必须在**枚举天数之前**拦住 —— 否则 `近100000d` 会先把十万个字符串堆进数组（实测 OOM 路径）。
 */
export const MAX_WINDOW_HOURS = 24 * 30;

export interface Window {
  /** 原始写法（用于报告标题） */
  label: string;
  /** 半开区间 [fromMs, toMs) */
  fromMs: number;
  toMs: number;
  /** 覆盖的本地日（升序；用于判"缺哪天的数据"） */
  days: string[];
}

export const DEFAULT_WINDOW = '昨天';
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class WindowParseError extends Error {
  constructor(public readonly input: string) {
    super(
      `无法解析的窗口写法: "${input}"\n支持: 近1h / 近24h / 近7d / 今天 / 昨天 / 2026-10-01 / 2026-10-01~2026-10-03`,
    );
    this.name = 'WindowParseError';
  }
}

export class WindowTooLongError extends Error {
  constructor(public readonly hours: number, public readonly maxHours: number) {
    super(`窗口太长（${hours.toFixed(0)}h > ${maxHours}h）—— 分批分析，别一次扫太多分片`);
    this.name = 'WindowTooLongError';
  }
}

/** 某时刻所属的本地日（Asia/Shanghai） */
export function shanghaiDayOf(ms: number): string {
  return new Date(ms + SHARD_TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** 某本地日的 00:00 对应的 UTC 毫秒 */
export function dayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - SHARD_TZ_OFFSET_MINUTES * 60_000;
}

/** 列举 [fromMs, toMs) 覆盖到的本地日（升序、去重） */
export function enumerateDays(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  if (!(toMs > fromMs)) return out;
  let cursor = dayStartMs(shanghaiDayOf(fromMs));
  const lastDayStart = dayStartMs(shanghaiDayOf(toMs - 1));
  while (cursor <= lastDayStart) {
    out.push(shanghaiDayOf(cursor));
    cursor += DAY_MS;
  }
  return out;
}

/** 显示用（本地时间，精确到分） */
export function formatShanghai(ms: number): string {
  return new Date(ms + SHARD_TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}

export interface ParseWindowOptions {
  /** 允许的最大窗口小时数（默认 `MAX_WINDOW_HOURS`）；超限抛 `WindowTooLongError` */
  maxHours?: number;
}

export function parseWindow(
  text: string | undefined,
  now: Date,
  fallback: string = DEFAULT_WINDOW,
  opts: ParseWindowOptions = {},
): Window {
  const raw = (text ?? '').trim() === '' ? fallback : text!.trim();
  const nowMs = now.getTime();
  const maxHours = opts.maxHours ?? MAX_WINDOW_HOURS;

  // ★ 先算区间，**在枚举天数之前**判长度 —— 否则"近100000d"会先堆出十万个字符串
  const build = (label: string, fromMs: number, toMs: number): Window => {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new WindowParseError(raw);
    const hours = (toMs - fromMs) / 3_600_000;
    if (hours > maxHours) throw new WindowTooLongError(hours, maxHours);
    return { label, fromMs, toMs, days: enumerateDays(fromMs, toMs) };
  };

  const rel = /^近(\d+)([hd])$/i.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0) throw new WindowParseError(raw);
    const span = n * (rel[2].toLowerCase() === 'h' ? 3_600_000 : DAY_MS);
    return build(raw, nowMs - span, nowMs);
  }

  const today = shanghaiDayOf(nowMs);
  if (raw === '今天') return build(raw, dayStartMs(today), nowMs);
  if (raw === '昨天') {
    const start = dayStartMs(today) - DAY_MS;
    return build(raw, start, start + DAY_MS);
  }

  const range = /^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/.exec(raw);
  if (range) {
    requireRealDate(range[1], raw);
    requireRealDate(range[2], raw);
    return build(raw, dayStartMs(range[1]), dayStartMs(range[2]) + DAY_MS);
  }

  if (DATE_RE.test(raw)) {
    requireRealDate(raw, raw);
    const from = dayStartMs(raw);
    return build(raw, from, from + DAY_MS);
  }

  throw new WindowParseError(raw);
}

/** 格式对但日子不存在（2026-02-30）必须拦下：`Date.parse` 会**静默进位**成 03-02，用户拿到的是另一天的数字 */
function requireRealDate(date: string, raw: string): void {
  if (!isRealDate(date)) throw new WindowParseError(raw);
}

/** 窗口是否包含某时刻 */
export function inWindow(window: Window, tsMs: number): boolean {
  return tsMs >= window.fromMs && tsMs < window.toMs;
}

/** 窗口时长（小时，报告里用） */
export function windowHours(window: Window): number {
  return (window.toMs - window.fromMs) / 3_600_000;
}
