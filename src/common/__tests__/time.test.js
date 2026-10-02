/**
 * 时间窗口单测（`src/common/time.ts`）—— 表驱动。
 * 全部按契约时区 Asia/Shanghai；这些边界搞错，分析窗口就会与分片错位一整天。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWindow,
  shanghaiDayOf,
  dayStartMs,
  enumerateDays,
  windowHours,
  formatShanghai,
  WindowParseError,
} = require('../../../dist/common/time');

// 北京时间 2026-10-02 20:00
const NOW = new Date('2026-10-02T12:00:00.000Z');
const ISO = (ms) => new Date(ms).toISOString();

test('shanghaiDayOf / dayStartMs：本地日边界（UTC 16:00 = 上海次日 00:00）', () => {
  assert.equal(shanghaiDayOf(Date.parse('2026-10-01T15:59:59.000Z')), '2026-10-01');
  assert.equal(shanghaiDayOf(Date.parse('2026-10-01T16:00:00.000Z')), '2026-10-02');
  assert.equal(ISO(dayStartMs('2026-10-02')), '2026-10-01T16:00:00.000Z');
});

test('enumerateDays：跨越本地日边界，按升序', () => {
  assert.deepEqual(enumerateDays(dayStartMs('2026-10-01'), dayStartMs('2026-10-02')), ['2026-10-01']);
  assert.deepEqual(enumerateDays(dayStartMs('2026-10-01'), dayStartMs('2026-10-03')), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(enumerateDays(dayStartMs('2026-10-01'), dayStartMs('2026-10-01')), [], '空区间不给天');
});

test('parseWindow：相对窗口', () => {
  assert.deepEqual(pick(parseWindow('近1h', NOW)), { label: '近1h', from: '2026-10-02T11:00:00.000Z', to: '2026-10-02T12:00:00.000Z', days: ['2026-10-02'] });
  assert.deepEqual(pick(parseWindow('近24h', NOW)).days, ['2026-10-01', '2026-10-02']);
  // 7 天窗口会碰到 8 个本地日 —— 这是"按天覆盖"的真实含义，别以为算错了
  assert.deepEqual(pick(parseWindow('近7d', NOW)).days, [
    '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
  ]);
});

test('parseWindow：今天 / 昨天（昨天是完整的本地日）', () => {
  const today = parseWindow('今天', NOW);
  assert.equal(ISO(today.fromMs), '2026-10-01T16:00:00.000Z');
  assert.equal(ISO(today.toMs), '2026-10-02T12:00:00.000Z');
  assert.deepEqual(today.days, ['2026-10-02']);

  const yesterday = parseWindow('昨天', NOW);
  assert.equal(ISO(yesterday.fromMs), '2026-09-30T16:00:00.000Z');
  assert.equal(ISO(yesterday.toMs), '2026-10-01T16:00:00.000Z');
  assert.deepEqual(yesterday.days, ['2026-10-01']);
  assert.equal(windowHours(yesterday), 24);
});

test('parseWindow：单日与区间（区间含首尾两天）', () => {
  const day = parseWindow('2026-10-01', NOW);
  assert.deepEqual(day.days, ['2026-10-01']);
  assert.equal(ISO(day.fromMs), '2026-09-30T16:00:00.000Z');

  const range = parseWindow('2026-10-01~2026-10-03', NOW);
  assert.deepEqual(range.days, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(windowHours(range), 72);
  assert.equal(range.label, '2026-10-01~2026-10-03');
});

test('parseWindow：缺省与非法输入', () => {
  assert.equal(parseWindow(undefined, NOW).label, '昨天', '默认窗口 = 昨天（当天未封存，看它容易得到暂定结论）');
  assert.equal(parseWindow('   ', NOW).label, '昨天');
  assert.equal(parseWindow('', NOW, '近24h').label, '近24h');

  for (const bad of ['上周', '近0h', '近h', '10-01', '2026-10-03~2026-10-01', '2026-13-01~2026-13-02']) {
    assert.throws(() => parseWindow(bad, NOW), WindowParseError, `应判非法: ${bad}`);
  }
  assert.throws(() => parseWindow('近0h', NOW), /支持: 近1h/);
});

test('formatShanghai：显示用本地时间', () => {
  assert.equal(formatShanghai(Date.parse('2026-10-02T12:34:56.000Z')), '2026-10-02 20:34');
});

function pick(w) {
  return { label: w.label, from: ISO(w.fromMs), to: ISO(w.toMs), days: w.days };
}
