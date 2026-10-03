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
      return {
        shards: opts.shards ?? 1,
        events: n,
        badLines: 0,
        missingDays: opts.missingDays ?? [],
        provisional: opts.provisional ?? false,
        failedShards: opts.failedShards ?? [],
        shardWarnings: opts.shardWarnings ?? [],
      };
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

test('带 id 与不带 id 混在同一窗口：未完成轮不能被少算（跨版本日志的混合场景）', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001'), // 新轮带 id
    ev('2026-10-01T03:00:00.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 1, durationHours: 2 }), // 完成轮不带 id
    ev('2026-10-01T04:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}), // 另一个新轮也不带 id
    ev('2026-10-01T05:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}), // 再来一个
  ];
  const result = await run(events);
  const row = rowOf(result, 'ETHFDUSD');
  assert.equal(row[1], '3', '新轮 3（1 个带 id + 2 个不带）');
  assert.equal(row[2], '1', '完成 1（不带 id）');
  assert.equal(row[3], '2', '未完成 = 带 id 没完成的 1 + 不带 id 的 2-1=1 ⇒ 2（早期实现会算成 1）');
});

test('未完成轮也要能看出"卡了多久"（只看已结束的轮会把"哪一轮卡住"答反）', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001'), // 窗口内最早 → 已运行最久
    ev('2026-10-01T10:00:00.000Z', 'NEW_ROUND', 'BTCFDUSD', {}, 'R002'),
    ev('2026-10-01T04:00:00.000Z', 'ROUND_COMPLETED', 'SOLFDUSD', { profit: 1, durationHours: 30 }, 'R003'),
  ];
  const result = await run(events, {}, { window: '2026-10-01' });
  const aging = result.sections.find((s) => s.heading.startsWith('未完成轮'));
  // 窗口 2026-10-01（上海日）= [09-30T16:00Z, 10-01T16:00Z)；它已结束（NOW=10-02T12:00Z）⇒ 按窗口结束算
  assert.deepEqual(aging.rows[0], ['ETHFDUSD', 'R001', '15.0']);
  assert.deepEqual(aging.rows[1].slice(0, 2), ['BTCFDUSD', 'R002']);
  assert.match(aging.note, /已运行 = 窗口结束 −/);
});

test('窗口还没结束时，"已运行"按**此刻**算（不能把还没发生的时间算进去）', async () => {
  const events = [ev('2026-10-02T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001')];
  // 窗口 = 2026-10-02（结束于 10-02T16:00Z，晚于 NOW=12:00Z）⇒ 参考时刻必须是 NOW
  const result = await run(events, {}, { window: '2026-10-02' });
  const aging = result.sections.find((s) => s.heading.startsWith('未完成轮'));
  assert.deepEqual(aging.rows[0], ['ETHFDUSD', 'R001', '11.0'], '按窗口结束算会得到 15.0h —— 那是未来时间');
  assert.match(aging.note, /按"此刻"算/);
});

test('★真数据实测：带仓重启会给同一轮换后缀（R596-190959 → R596-191307-RCV），不能被算成"永远未完成"', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'XRPFDUSD', {}, 'R596-190959'),
    ev('2026-10-01T01:13:07.000Z', 'ROUND_FIRST_FILL', 'XRPFDUSD', {}, 'R596-191307-RCV'), // 同 counter，后缀变了
    ev('2026-10-01T02:00:00.000Z', 'ROUND_COMPLETED', 'XRPFDUSD', { profit: 1, durationHours: 1 }, 'R596-191307-RCV'),
    ev('2026-10-01T03:00:00.000Z', 'NEW_ROUND', 'XRPFDUSD', {}, 'R597-030000'), // 真在开着的轮
  ];
  const result = await run(events);
  const row = rowOf(result, 'XRPFDUSD');
  assert.equal(row[1], '2', '新轮 2');
  assert.equal(row[2], '1', '完成 1（按 counter 认出来了，不能被改名骗过）');
  assert.equal(row[3], '1', '未完成 1 —— 只有 R597 真在开；按整串比会算成 2');

  const aging = result.sections.find((s) => s.heading.startsWith('未完成轮'));
  assert.equal(aging.rows.length, 1, '被骗过的话这里会凭空多一行已经结束的轮');
  assert.match(aging.rows[0][1], /R597/);
});

test('★真数据实测：roundId 只在 (实例,币种) 内唯一 —— 跨币种撞名不能互相污染', async () => {
  const hour = 3_600_000;
  const t0 = Date.parse('2026-10-01T00:00:00.000Z');
  // 同一实例两个币种的计数器都从 1 起 ⇒ 字符串完全同名（真数据里 BTC=168…/XRP=595…/ETH=001…，各自独立计数）
  const events = [
    { ...ev(new Date(t0).toISOString(), 'NEW_ROUND', 'ETHFDUSD', {}, 'R001-000000'), instance: 'a' },
    { ...ev(new Date(t0 + 8 * hour).toISOString(), 'NEW_ROUND', 'BTCFDUSD', {}, 'R001-000000'), instance: 'a' },
  ];
  const result = await run(events, {}, { window: '2026-10-01' });
  const aging = result.sections.find((s) => s.heading.startsWith('未完成轮'));
  const eth = aging.rows.find((r) => r[0] === 'ETHFDUSD');
  const btc = aging.rows.find((r) => r[0] === 'BTCFDUSD');
  assert.ok(eth && btc, '两个币种各一行：' + JSON.stringify(aging.rows));
  assert.notEqual(eth[2], btc[2], '只按 roundId 建键时，后出现的轮会套用别人的首现时刻（两条时长会相同）');
});

test('★主仓实证：空仓重启会复用计数器（R001 再来一次）—— 两轮绝不能被并成一轮', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001-010000'),
    ev('2026-10-01T02:00:00.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 1, durationHours: 1 }, 'R001-010000'),
    // 空仓重启：主仓 spot-worker.ts L735-757 `if (!state.isInGaming)` 直接 return（round 不恢复）
    // ⇒ 下一次开轮又是 R001（换个时间戳）
    ev('2026-10-01T05:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001-050000'),
  ];
  const result = await run(events, {}, { window: '2026-10-01' });
  const row = rowOf(result, 'ETHFDUSD');
  assert.equal(row[1], '2', '新轮 2（同一计数器下两轮）');
  assert.equal(row[2], '1', '完成 1（精确匹配到第一轮）');
  assert.equal(row[3], '1', '未完成 1 —— 第二轮真在开。把身份降级成计数器会并成一轮、报成 0（静默假阴性）');

  const aging = result.sections.find((s) => s.heading.startsWith('未完成轮'));
  assert.equal(aging.rows.length, 1);
  assert.match(aging.rows[0][1], /R001-050000/, '显示的必须是**真在开**那一轮的名字');
  assert.equal(aging.rows[0][2], '11.0', '该轮首现 05:00Z，窗口结束 10-01T16:00Z（已过 ⇒ 按窗口结束算）⇒ 11h');
});

test('改名兜底：只有完成事件带 -RCV、中间没有别的非开轮事件时，也要认领那一轮', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R010-010000'),
    ev('2026-10-01T06:00:00.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 2, durationHours: 5 }, 'R010-061230-RCV'),
  ];
  const result = await run(events);
  const row = rowOf(result, 'ETHFDUSD');
  assert.equal(row[2], '1', '完成 1（靠 -RCV 兜底认领）');
  assert.equal(row[3], '0', '未完成 0 —— 不带 -RCV 的"整串匹配不上"就不许认领，否则计数器复用会被误判');
});

test('counterOfRoundId / isRecoveredRoundId：改名标记与计数器的解析', () => {
  const { counterOfRoundId, isRecoveredRoundId } = require('../../../dist/analysis/rounds');
  assert.equal(counterOfRoundId('R596-190959'), 'R596');
  assert.equal(counterOfRoundId('R596-191307-RCV'), 'R596');
  assert.equal(counterOfRoundId('R000-ERR-RCV'), 'R000');
  assert.equal(isRecoveredRoundId('R596-191307-RCV'), true);
  assert.equal(isRecoveredRoundId('R596-190959'), false);
  assert.equal(isRecoveredRoundId('R001'), false);
});

test('分片读不出来 / 带数据告警时，轮数结论必须打折说明', async () => {
  const result = await run(SCENARIO, {
    failedShards: [{ key: 'snapshot/a/2026-09-30.jsonl.gz', errors: ['文件不存在'] }],
    shardWarnings: [{ key: 'snapshot/a/2026-10-01.jsonl.gz', warnings: ['行数不符'] }],
  });
  const warning = result.warnings.join('\n');
  assert.match(warning, /1 个分片\*\*读不出来\*\*/);
  assert.match(warning, /轮数与利润可能偏低/);
});
