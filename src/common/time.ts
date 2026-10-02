/**
 * 时间窗口解析（纯函数）。
 *
 * 全部按**契约时区 Asia/Shanghai** 计算：分片按本地日分桶，分析窗口若用 UTC 会与分片错位。
 * 支持的写法（与机器人指令表一致）：
 *   近1h / 近24h / 近7d      今天 / 昨天
 *   2026-10-01               2026-10-01~2026-10-03（含首尾两天）
 * 默认窗口 = 昨天（当天的分片还没封存，看它容易得到"暂定"结论）。
 */
import { SHARD_TZ_OFFSET_MINUTES } from '../ndjson/types';

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

export function parseWindow(text: string | undefined, now: Date, fallback: string = DEFAULT_WINDOW): Window {
  const raw = (text ?? '').trim() === '' ? fallback : text!.trim();
  const nowMs = now.getTime();
  const build = (label: string, fromMs: number, toMs: number): Window => ({ label, fromMs, toMs, days: enumerateDays(fromMs, toMs) });

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
    const from = dayStartMs(range[1]);
    const to = dayStartMs(range[2]) + DAY_MS;
    if (!(to > from)) throw new WindowParseError(raw);
    return build(raw, from, to);
  }

  if (DATE_RE.test(raw)) {
    const from = dayStartMs(raw);
    return build(raw, from, from + DAY_MS);
  }

  throw new WindowParseError(raw);
}

/** 窗口是否包含某时刻 */
export function inWindow(window: Window, tsMs: number): boolean {
  return tsMs >= window.fromMs && tsMs < window.toMs;
}

/** 窗口时长（小时，报告里用） */
export function windowHours(window: Window): number {
  return (window.toMs - window.fromMs) / 3_600_000;
}
