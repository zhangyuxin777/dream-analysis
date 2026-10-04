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
  assert.deepEqual(aging.rows[0].slice(0, 3), ['ETHFDUSD', 'R001', '15.0']);
  assert.equal(aging.rows[0][3], '否', '全程没有买入成交 ⇒ 未建仓');
  assert.equal(aging.rows[0][4], '-', '没有买入时间戳就不编造"末笔买入后"');
  assert.equal(aging.rows[0][5], '窗口内最新');
  assert.deepEqual(aging.rows[1].slice(0, 2), ['BTCFDUSD', 'R002']);
  assert.match(aging.note, /已运行 = 窗口结束 −/);
});

test('窗口还没结束时，"已运行"按**此刻**算（不能把还没发生的时间算进去）', async () => {
  const events = [ev('2026-10-02T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001')];
  // 窗口 = 2026-10-02（结束于 10-02T16:00Z，晚于 NOW=12:00Z）⇒ 参考时刻必须是 NOW
  const result = await run(events, {}, { window: '2026-10-02' });
  const aging = result.sections.find((s) => s.heading.startsWith('未完成轮'));
  assert.deepEqual(aging.rows[0].slice(0, 3), ['ETHFDUSD', 'R001', '11.0'], '按窗口结束算会得到 15.0h —— 那是未来时间');
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

test('★第三轮 P5 的 Critical：不带 -RCV 的"整串认不出"的完成事件，**不许**认领同计数器的另一轮', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001-010000'),
    // 空仓重启后开的另一轮，完成事件是它的（它自己的 NEW_ROUND 不在窗口里 / 或就是没采到）
    ev('2026-10-01T05:00:00.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 1, durationHours: 1 }, 'R001-050000'),
  ];
  const result = await run(events);
  const row = rowOf(result, 'ETHFDUSD');
  assert.equal(row[2], '1', '完成数照记（但配不上开轮记录）');
  assert.equal(row[3], '1', '未完成必须仍是 1：报告 note 的定义是"开了新轮但没看到 ROUND_COMPLETED"；'
    + '宽松认领会把它报成已完成（静默假阴性，正是这张表最该避免的错）');
  const aging = result.sections.find((s) => s.heading.startsWith('未完成轮'));
  assert.match(aging.rows[0][1], /R001-010000/, 'aging 里显示的必须是**那条真没配上完成**的记录，而不是完成事件的名字');
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

test('恢复错误态 id（R000-ERR-RCV）带 -RCV 但不是改名：不许认领，且要报出来', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R596-190959'),
    ev('2026-10-01T02:00:00.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 1, durationHours: 1 }, 'R000-ERR-RCV'),
  ];
  const result = await run(events);
  const row = rowOf(result, 'ETHFDUSD');
  assert.equal(row[2], '1', '完成数照记（它是条完成事件）');
  assert.equal(row[3], '1', '不许认领：错误态 id 的计数器信息已丢，归因不可靠');
  const warning = result.warnings.join('\n');
  assert.match(warning, /恢复错误态/);
  assert.match(warning, /计数器信息已丢失/);
});

test('isRecoveredRoundId / isErrorRoundId：错误态 id 不算改名', () => {
  const { isRecoveredRoundId, isErrorRoundId } = require('../../../dist/analysis/rounds');
  assert.equal(isRecoveredRoundId('R596-191307-RCV'), true, '带仓重启的改名');
  assert.equal(isRecoveredRoundId('R000-ERR-RCV'), false, '恢复抛异常落的常量 id，不是改名');
  assert.equal(isRecoveredRoundId('R596-190959'), false);
  assert.equal(isErrorRoundId('R000-ERR-RCV'), true);
  assert.equal(isErrorRoundId('R596-191307-RCV'), false);
});

test('★真数据（R004 形态）：零成交、被偏离复位掐断的轮**不许**冒充"最卡"，且要标出真相', async () => {
  const ev2 = (ts, event, symbol, data, roundId) => ({ ts, event, symbol, roundId, instance: 'a', localDate: ts.slice(0, 10), seq: 1, data });
  const events = [
    // ① 08:37 开轮，一路没成交（无 BUY_FILLED）
    ev2('2026-10-01T00:37:13.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R004-083713'),
    // ② 同实例后面又开了两轮（说明它已被顶掉），其中一轮真建了仓
    ev2('2026-10-01T09:03:22.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R005-170322'),
    ev2('2026-10-01T09:54:37.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0, buyPrice: 2683.81, accCost: 224.36 }, 'R005-170322'),
    // ③ R004 收到的是"偏离复位"（不是正常卖出）
    ev2('2026-10-01T09:03:21.000Z', 'RESET_CANCEL_SUCCESS', 'ETHFDUSD', { reason: 'PRICE_DEVIATION' }, 'R004-083713'),
  ];
  const result = await run(events, {}, { window: '2026-10-01' });
  const aging = result.sections.find((s) => s.heading.startsWith('未完成轮'));

  // R005 已建仓 ⇒ 必须排在前面（即使 R004 的"已运行"更久）
  assert.equal(aging.rows[0][1], 'R005-170322', '已建仓的轮优先：' + JSON.stringify(aging.rows));
  assert.equal(aging.rows[0][3], '是');

  const r004 = aging.rows.find((r) => r[1] === 'R004-083713');
  assert.ok(r004, '零成交的轮也要列出来（它是"没接到货"，不是卡单，不能藏）');
  assert.equal(r004[3], '否', '没成交 ⇒ 未建仓');
  assert.match(r004[5], /复位掐断\(PRICE_DEVIATION\)/, '要从 RESET_CANCEL_SUCCESS.reason 认出掐断，不能只说"未完成"');
  assert.match(aging.heading, /已建仓的在前/);
  assert.match(aging.note, /空等\/被复位掐断/);
});

test('★补仓时长：已结束的轮要能看出"慢在补仓还是慢在等"', async () => {
  const ev2 = (ts, event, symbol, data, roundId) => ({ ts, event, symbol, roundId, instance: 'a', localDate: ts.slice(0, 10), seq: 1, data });
  const events = [
    ev2('2026-10-01T00:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R003-000200'),
    ev2('2026-10-01T00:07:54.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0 }, 'R003-000200'),
    ev2('2026-10-01T02:39:40.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 9 }, 'R003-000200'), // 补仓到 02:39
    ev2('2026-10-01T08:37:11.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 7.72, durationHours: 5.95 }, 'R003-000200'),
  ];
  const result = await run(events, {}, { window: '2026-10-01' });
  const worst = result.sections.find((s) => s.heading.startsWith('最长卡轮'));
  assert.deepEqual(worst.headers, ['币种', '轮次', '等待(h)', '补仓(h)', '整轮利润', '深跌']);
  const row = worst.rows[0];
  assert.equal(row[2], '5.95', '等待 = ROUND_COMPLETED.durationHours（末次买入→卖出）');
  assert.equal(row[3], '2.53', '补仓 = 首笔 00:07:54 → 末笔 02:39:40 = 2.53h（自己 join BUY_FILLED）');
  assert.match(worst.note, /末次买入→卖出/, '口径必须写清（曾经写成"首笔买入→卖出"，错 30%）');
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
