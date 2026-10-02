/**
 * `rounds` 分析器单测（`src/analysis/rounds.ts`）
 * 重点：两种利润口径不混、金额用整数分累加（浮点会飘）、未完成轮按 roundId 判、最长卡轮 Top N。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { roundsAnalysis } = require('../../../dist/analysis/rounds');
const { parseWindow } = require('../../../dist/common/time');

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ev = (ts, event, symbol = 'ETHFDUSD', data = {}, roundId) => ({ ts, event, symbol, roundId, data, instance: 'a', date: ts.slice(0, 10), lineNo: 2 });

function fakeSource(events, opts = {}) {
  return {
    instances: () => ['a'],
    shards: () => [],
    availableDays: () => [...new Set(events.map((e) => e.date))],
    scan: async (filter, cb) => {
      let n = 0;
      for (const e of events) {
        const ms = Date.parse(e.ts);
        if (ms < filter.window.fromMs || ms >= filter.window.toMs) continue;
        if (filter.symbol && !String(e.symbol ?? '').toUpperCase().startsWith(filter.symbol.toUpperCase())) continue;
        n++;
        cb(e);
      }
      return { shards: opts.shards ?? 1, events: n, badLines: 0, missingDays: opts.missingDays ?? [], provisional: opts.provisional ?? false };
    },
  };
}

const run = async (events, opts = {}, params = {}) =>
  roundsAnalysis().run({ source: fakeSource(events, opts), now: NOW, window: parseWindow(params.window ?? '昨天', NOW), params });

const rowOf = (result, symbol) => result.sections.find((s) => s.heading === '按币种').rows.find((r) => r[0] === symbol);

const SCENARIO = [
  ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', { bidPrice: 100 }, 'R001'),
  ev('2026-10-01T01:05:00.000Z', 'ROUND_FIRST_FILL', 'ETHFDUSD', { buyPrice: 100, accCost: 50 }, 'R001'),
  ev('2026-10-01T01:06:00.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0, buyPrice: 100, accCost: 50 }, 'R001'),
  ev('2026-10-01T02:00:00.000Z', 'SELL_FILLED', 'ETHFDUSD', { price: 101, qty: 0.5, profit: 0.5, totalProfit: 0.5 }, 'R001'),
  ev('2026-10-01T02:01:00.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 0.55, durationHours: 1.02, isCrashMode: false }, 'R001'),
  ev('2026-10-01T03:00:00.000Z', 'NEW_ROUND', 'BTCFDUSD', {}, 'R002'),
  ev('2026-10-01T04:00:00.000Z', 'CRASH_ENTERED', 'BTCFDUSD', { dropPercent: 0.05 }, 'R002'),
  ev('2026-10-01T05:00:00.000Z', 'ORDER_FILLED', 'BTCFDUSD', { orderInfo: {} }, 'R002'),
];

test('按币种聚合：轮次/买卖/深跌/两种利润分开列', async () => {
  const result = await run(SCENARIO);
  assert.match(result.title, /轮次与成交 · 昨天/);
  assert.match(result.summary, /新轮 2 \/ 完成 1 \/ 未完成 1/);
  assert.match(result.summary, /止盈利润合计 0\.50/);

  assert.deepEqual(rowOf(result, 'ETHFDUSD'), ['ETHFDUSD', '1', '1', '0', '1', '1', '0', '0', '0.50', '0.55']);
  assert.deepEqual(rowOf(result, 'BTCFDUSD'), ['BTCFDUSD', '1', '0', '1', '0', '0', '1', '1', '0.00', '0.00']);

  const note = result.sections.find((s) => s.heading === '按币种').note;
  assert.match(note, /不要相加/, '两种利润口径必须写清不能相加');
});

test('概览合计：未完成轮按 roundId 判断（不是简单计数差）', async () => {
  const result = await run(SCENARIO);
  const overview = Object.fromEntries(result.sections.find((s) => s.heading === '概览').rows.map((r) => [r[0], r[1]]));
  assert.equal(overview['新轮 / 完成轮 / 未完成'], '2 / 1 / 1');
  assert.equal(overview['止盈利润合计'], '0.50');
  assert.equal(overview['整轮利润合计'], '0.55');
});

test('金额用整数分累加：0.1 + 0.2 必须是 0.30（浮点会给出 0.30000000000000004）', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'SELL_FILLED', 'ETHFDUSD', { profit: 0.1 }),
    ev('2026-10-01T02:00:00.000Z', 'SELL_FILLED', 'ETHFDUSD', { profit: 0.2 }),
  ];
  const result = await run(events);
  assert.equal(rowOf(result, 'ETHFDUSD')[8], '0.30');
  assert.match(result.summary, /止盈利润合计 0\.30/);
});

test('最长卡轮 Top N 按 durationHours 排序，N 可通过参数控制', async () => {
  const events = [1, 5, 3].map((h, i) =>
    ev(`2026-10-01T0${i + 1}:00:00.000Z`, 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 1, durationHours: h }, `R00${i}`));
  const all = await run(events);
  const section = all.sections.find((s) => s.heading.startsWith('最长卡轮'));
  assert.deepEqual(section.rows.map((r) => r[2]), ['5.00', '3.00', '1.00']);

  const top2 = await run(events, {}, { top: '2' });
  assert.equal(top2.sections.find((s) => s.heading.startsWith('最长卡轮')).rows.length, 2);
});

test('symbol 过滤与缺天/未封存如实上报', async () => {
  const ethOnly = await run(SCENARIO, {}, { symbol: 'eth' });
  assert.equal(ethOnly.sections.find((s) => s.heading === '按币种').rows.length, 1);
  assert.match(ethOnly.title, /ETH/);

  const withGaps = await run(SCENARIO, { missingDays: ['2026-09-29'], provisional: true });
  assert.match(withGaps.warnings.join('\n'), /缺 1 天的本地数据: 2026-09-29/);
  assert.equal(withGaps.provisional, true);
});

test('空窗口：summary 说清"没有事件"，且不产生假的 0 轮结论', async () => {
  const result = await run([]);
  assert.match(result.summary, /没有轮次\/成交事件/);
  assert.match(result.warnings.join('\n'), /窗口内没有任何轮次\/成交类事件/);
  assert.deepEqual(result.sections.find((s) => s.heading === '按币种').rows, []);
});

test('缺 roundId 时退化为"新轮 - 完成轮"（旧数据也要能算，不抛）', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}),
    ev('2026-10-01T02:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}),
    ev('2026-10-01T03:00:00.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 0.1, durationHours: 1 }),
  ];
  const result = await run(events);
  assert.equal(rowOf(result, 'ETHFDUSD')[3], '1', '2 个新轮 - 1 个完成 = 1 个未完成');
});
