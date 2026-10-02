/**
 * 展示用格式化（纯函数，便于单测）。
 * 口径统一放这里，避免"状态页和报告页各写一套"导致同一份数据两个样子。
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 人类可读字节数（1 位小数；1024 进制） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** 毫秒 → `350ms` / `1.2s` / `2m3s` */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s}s`;
}

/** 千分位计数 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toLocaleString('en-US');
}
