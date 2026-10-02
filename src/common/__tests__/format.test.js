/**
 * 格式化单测（`src/common/format.ts`）
 * 按"阈值两侧夹逼"写：只测 1024 与 1025 的区别不够，要取恰好等于与刚超过两个点。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatBytes, formatDurationMs, formatCount } = require('../../../dist/common/format');

test('formatBytes：阈值两侧（1023 / 1024 / 1536 / 1MB 边界）', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B', '不足 1KB 走字节');
  assert.equal(formatBytes(1024), '1.0 KB', '恰好 1KB 进位');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 - 1), '1024.0 KB', '差 1 字节时还在 KB 档');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB', '恰好 1MB 进位');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
});

test('formatBytes：非法输入不抛（n/a）', () => {
  assert.equal(formatBytes(-1), 'n/a');
  assert.equal(formatBytes(NaN), 'n/a');
});

test('formatDurationMs：阈值两侧（999 / 1000 / 59999 / 60000）', () => {
  assert.equal(formatDurationMs(999), '999ms');
  assert.equal(formatDurationMs(1000), '1.0s');
  assert.equal(formatDurationMs(59999), '60.0s', '不足 1 分钟仍走秒');
  assert.equal(formatDurationMs(60000), '1m0s');
  assert.equal(formatDurationMs(123000), '2m3s');
});

test('formatCount：千分位', () => {
  assert.equal(formatCount(4210), '4,210');
  assert.equal(formatCount(0), '0');
});
