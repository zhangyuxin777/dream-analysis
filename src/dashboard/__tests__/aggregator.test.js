/**
 * dashboard 聚合器单测（`src/dashboard/aggregator.ts`）
 * 口径与 `docs/legacy/build_summary.py` 一致，重点钉死三条隐含知识：
 * 轮号重号切段、-RCV 恢复链并入同段（accCost 链上差额）、市价从持仓估值反推。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateDashboard, summarizeInstance, beijingIsoOf, beijingDayOfMs } = require('../../../dist/dashboard/aggregator');

const NOW_MS = Date.parse('2026-10-05T12:00:00Z');

/** 造事件（ts 为 UTC ISO；北京 = UTC+8） */
const ev = (ts, event, symbol = '', data = {}, roundId = '', seq = 0) => ({
  ts, event, symbol, roundId, data, seq, instance: 'a', date: ts.slice(0, 10), lineNo: 2,
});

/** 账户观测快照（total=100000，FDUSD 可用 900 锁定 100；ETH 持仓 1.2、市值 240 → 市价 200） */
const obs = (ts, total = 100000) => ev(ts, 'ACCOUNT_OBSERVED', '', {
  totalValue: total,
  balances: [
    { asset: 'FDUSD', qtyFree: 900, qtyLocked: 100, value: 1000 },
    { asset: 'ETH', qtyFree: 1.2, qtyLocked: 0, value: 240 },
  ],
});

function fakeSource(eventsByInstance) {
  return {
    instances: () => Object.keys(eventsByInstance).sort(),
    shards: () => [],
    availableDays: (inst) => [...new Set((eventsByInstance[inst] ?? []).map((e) => e.date))],
    scan: async (filter, cb) => {
      let n = 0;
      for (const e of eventsByInstance[filter.instance] ?? []) {
        const ms = Date.parse(e.ts);
        if (ms < filter.window.fromMs || ms >= filter.window.toMs) continue;
        n++;
        cb(e);
      }
      return { shards: 1, events: n, badLines: 0, missingDays: [], provisional: false, failedShards: [], shardWarnings: [] };
    },
  };
}

test('北京时间换算：ISO 带 +08:00，日期归属正确', () => {
  const ms = Date.parse('2026-10-01T16:30:00Z');
  assert.equal(beijingIsoOf(ms), '2026-10-02T00:30:00.000+08:00');
  assert.equal(beijingDayOfMs(ms), '2026-10-02');
});

test('空实例：全字段可空不炸', () => {
  const s = summarizeInstance('a', [], NOW_MS);
  assert.equal(s.range.from, null);
  assert.equal(s.stats.lastEquity, null);
  assert.equal(s.stats.equityDelta, null);
  assert.equal(s.datasetEnd, beijingIsoOf(NOW_MS));
});

test('完成轮 + 卡单 + 重号切段 + RCV 链合并 + 深跌 + 入金', async () => {
  const T = (h, day = '2026-10-03') => `2026-10-0${day.slice(-1)}T${String(h).padStart(2, '0')}:00:00Z`;
  const events = [
    obs('2026-10-03T00:00:00Z', 100000),
    // 轮 1：两轮买入后完成（含一次轮内复位）
    ev('2026-10-03T01:00:00Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001'),
    ev('2026-10-03T01:01:00Z', 'BUY_FILLED', 'ETHFDUSD', { buyPrice: 100, accCost: 50 }, 'R001', 1),
    ev('2026-10-03T01:02:00Z', 'WORKER_DEVIATION_RESET', 'ETHFDUSD', { reason: 'x' }, 'R001', 2),
    ev('2026-10-03T01:03:00Z', 'BUY_FILLED', 'ETHFDUSD', { buyPrice: 100, accCost: 150 }, 'R001', 3),
    ev('2026-10-03T02:00:00Z', 'ROUND_COMPLETED', 'ETHFDUSD', {
      profit: 1.5, durationHours: 2, accCost: 150, avgBuyPrice: 100, sellPrice: 101, isCrashMode: false,
    }, 'R001', 4),
    // 轮 2：买入未完成 → 卡单（含一次降档）
    ev('2026-10-03T03:00:00Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R002'),
    ev('2026-10-03T03:01:00Z', 'BUY_FILLED', 'ETHFDUSD', { buyPrice: 100, accCost: 80 }, 'R002', 1),
    ev('2026-10-03T03:02:00Z', 'DYNAMIC_PROFIT_REDUCED', 'ETHFDUSD', {}, 'R002', 2),
    // 深跌进出一对
    ev('2026-10-03T04:00:00Z', 'CRASH_ENTERED', 'ETHFDUSD', { dropPercent: 0.05 }, 'R002', 3),
    ev('2026-10-03T05:00:00Z', 'CRASH_EXITED', 'ETHFDUSD', { durationSec: 3600 }, 'R002', 4),
    // 孤立复位段：有复位无买入 → resetKilled
    ev('2026-10-03T06:00:00Z', 'NEW_ROUND', 'BTCFDUSD', {}, 'R009'),
    ev('2026-10-03T06:01:00Z', 'WORKER_DEVIATION_RESET', 'BTCFDUSD', { reason: 'y' }, 'R009', 1),
    // 权益跳升 4% → 入金
    obs('2026-10-03T07:00:00Z', 104500),
    // 轮 3：恢复接管链（-RCV 无独立 BUY_FILLED 起点，accCost 链上差额算花费）
    ev('2026-10-03T08:00:00Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R003-111111'),
    ev('2026-10-03T08:01:00Z', 'BUY_FILLED', 'ETHFDUSD', { buyPrice: 100, accCost: 80 }, 'R003-111111', 1),
    ev('2026-10-03T08:02:00Z', 'STARTUP_RECOVERY_DONE', 'ETHFDUSD', { round: 3, accCost: 80, accSz: 0.8 }, 'R003-222222-RCV', 2),
    ev('2026-10-03T08:03:00Z', 'BUY_FILLED', 'ETHFDUSD', { buyPrice: 100, accCost: 120 }, 'R003-222222-RCV', 3),
  ];
  const s = summarizeInstance('a', events.map((e) => ({
    tsMs: Date.parse(e.ts), seq: e.seq ?? 0, event: e.event, symbol: e.symbol,
    roundId: e.roundId, data: e.data,
  })), NOW_MS);

  // 资金曲线与入金
  assert.equal(s.equity.length, 2);
  assert.equal(s.equity[0].idlePct, 0.9);
  assert.deepEqual(s.equity[0].coins.ETH, { qty: 1.2, value: 240, price: 200 }, '快照里要带出每币种持仓明细（单币种资金曲线的价格来源）');
  assert.equal(s.deposits.length, 1);
  assert.equal(s.deposits[0].amount, 4500);

  // 完成轮：利润/时长/复位计数
  assert.equal(s.completedRounds.length, 1);
  assert.deepEqual(
    { symbol: s.completedRounds[0].symbol, roundNo: s.completedRounds[0].roundNo, profit: s.completedRounds[0].profit, hours: s.completedRounds[0].hours, resets: s.completedRounds[0].resets },
    { symbol: 'ETHFDUSD', roundNo: 'R001', profit: 1.5, hours: 2, resets: 1 },
  );

  // 卡单：R002（80 花 100 价 = 0.8 个，浮盈按 ETH 市价 200 反推）；R003 链合并（0.8+0.4=1.2 个，accCost=120）
  assert.equal(s.stuck.length, 2);
  const r002 = s.stuck.find((x) => x.roundNo === 'R002');
  const r003 = s.stuck.find((x) => x.roundNo === 'R003');
  assert.ok(r002 && r003, 'R002 与 R003 都应是活轮');
  assert.equal(r002.qty, 0.8);
  assert.equal(r002.accCost, 80);
  assert.equal(r002.avgBuy, 100);
  assert.equal(r002.lastPrice, 200);
  assert.equal(r002.floating, 80);      // 0.8 × (200−100)
  assert.equal(r002.floatingPct, 100);
  assert.equal(r002.reductions, 1);
  assert.equal(r002.crash, true);
  assert.equal(r003.qty, 1.2);          // 链上差额：80/100 + 40/100
  assert.equal(r003.accCost, 120);
  assert.equal(r003.avgBuy, 100);

  // 孤立复位段被掐死
  assert.equal(s.stats.resetKilledCount, 1);

  // 深跌事件成对
  assert.equal(s.crashes.length, 1);
  assert.equal(s.crashes[0].dropPct, 5);
  assert.ok(s.crashes[0].end !== null);

  // 日维度：全部落在北京时间 10-03（UTC 00:00~07:00）
  assert.equal(s.daily.length, 1);
  const d = s.daily[0];
  assert.equal(d.date, '2026-10-03');
  assert.equal(d.profit, 1.5);
  assert.equal(d.rounds, 1);
  assert.equal(d.new, 4);
  assert.equal(d.resets, 2);
  assert.equal(d.crashIn, 1);
  assert.equal(d.crashOut, 1);

  // 按币日维度：ETH/BTC 各成一套，币内计数与账户级一致；net 拆不到币，必须缺省
  const ethDaily = s.dailyByCoin.ETH;
  const btcDaily = s.dailyByCoin.BTC;
  assert.equal(ethDaily.length, 1);
  assert.deepEqual(
    { profit: ethDaily[0].profit, rounds: ethDaily[0].rounds, new: ethDaily[0].new, resets: ethDaily[0].resets, crashIn: ethDaily[0].crashIn, crashOut: ethDaily[0].crashOut, net: ethDaily[0].net ?? null },
    { profit: 1.5, rounds: 1, new: 3, resets: 1, crashIn: 1, crashOut: 1, net: null },
  );
  assert.equal(btcDaily.length, 1);
  assert.deepEqual(
    { new: btcDaily[0].new, resets: btcDaily[0].resets, profit: btcDaily[0].profit },
    { new: 1, resets: 1, profit: 0 },
  );

  // stats
  assert.equal(s.stats.realizedProfit, 1.5);
  assert.equal(s.stats.completedCount, 1);
  assert.equal(s.stats.newCount, 4);
  assert.equal(s.stats.resetCount, 2);
  assert.equal(s.stats.lastEquity, 104500);
  assert.equal(s.stats.equityDelta, 4500);
});

test('aggregateDashboard 跳过 localtest 与点目录', async () => {
  const source = fakeSource({
    a: [obs('2026-10-03T00:00:00Z')],
    localtest: [obs('2026-10-03T00:00:00Z')],
    '.tmp': [obs('2026-10-03T00:00:00Z')],
  });
  const summary = await aggregateDashboard(source, NOW_MS);
  assert.deepEqual(Object.keys(summary.instances).sort(), ['a']);
  assert.equal(summary.timezone, 'Asia/Shanghai');
  assert.equal(summary.instances.a.datasetEndProvisional, false, 'fakeSource 的分片都是 final → 不标暂定');
});

test('datasetEndProvisional：扫到非 final 分片时标暂定', async () => {
  const source = fakeSource({ a: [obs('2026-10-03T00:00:00Z')] });
  const origScan = source.scan;
  source.scan = async (filter, cb) => {
    const stats = await origScan(filter, cb);
    return { ...stats, provisional: true };
  };
  const summary = await aggregateDashboard(source, NOW_MS);
  assert.equal(summary.instances.a.datasetEndProvisional, true);
});

test('深跌轮口径：段内出现过 CRASH_ENTERED 即算，完成时 isCrashMode=false 也算（2026-10-12 BTC R073 实盘回归）', () => {
  const events = [
    ev('2026-10-07T13:38:54Z', 'NEW_ROUND', 'BTCFDUSD', {}, 'R073-230148'),
    ev('2026-10-07T13:39:00Z', 'BUY_FILLED', 'BTCFDUSD', { buyPrice: 83272, accCost: 500 }, 'R073-230148', 1),
    ev('2026-10-07T13:38:54Z', 'CRASH_ENTERED', 'BTCFDUSD', { dropPercent: 0.04 }, 'R073-230148', 2),
    // 策略静默退出深跌：无 CRASH_EXITED，完成时 isCrashMode=false（实盘原样）
    ev('2026-10-12T05:04:41Z', 'ROUND_COMPLETED', 'BTCFDUSD', {
      profit: 18.86, durationHours: 85.44, accCost: 23016.19, avgBuyPrice: 84222, sellPrice: 84291.05, isCrashMode: false,
    }, 'R073-161717-RCV', 3),
  ];
  const s = summarizeInstance('a', events.map((e) => ({
    tsMs: Date.parse(e.ts), seq: e.seq ?? 0, event: e.event, symbol: e.symbol, roundId: e.roundId, data: e.data,
  })), NOW_MS);
  assert.equal(s.completedRounds.length, 1);
  assert.equal(s.completedRounds[0].isCrash, true, '段内有 CRASH_ENTERED 的完成轮必须算深跌轮');
  assert.equal(s.stats.crashRoundCount, 1);
});

test('深跌退出判定（方案②）：防守轮完成卖出即视为事件结束，无需 CRASH_EXITED（2026-10-12 BTC R073 实盘回归）', () => {
  const events = [
    ev('2026-10-07T13:38:54Z', 'NEW_ROUND', 'BTCFDUSD', {}, 'R073-230148'),
    ev('2026-10-07T13:38:54Z', 'CRASH_ENTERED', 'BTCFDUSD', { dropPercent: 0.04 }, 'R073-230148', 1),
    ev('2026-10-07T13:40:00Z', 'BUY_FILLED', 'BTCFDUSD', { buyPrice: 83272, accCost: 500 }, 'R073-230148', 2),
    // 重启恢复接管（-RCV 新 id，轮号不变），之后完成 —— 事件流里**没有** CRASH_EXITED
    ev('2026-10-09T08:17:17Z', 'RECOVERY_APPLIED', 'BTCFDUSD', {}, 'R073-161717-RCV', 3),
    ev('2026-10-12T05:04:41Z', 'ROUND_COMPLETED', 'BTCFDUSD', { profit: 18.86, durationHours: 85.44 }, 'R073-161717-RCV', 4),
  ];
  const s = summarizeInstance('a', events.map((e) => ({
    tsMs: Date.parse(e.ts), seq: e.seq ?? 0, event: e.event, symbol: e.symbol, roundId: e.roundId, data: e.data,
  })), NOW_MS);
  assert.equal(s.crashes.length, 1);
  assert.equal(s.crashes[0].end, '2026-10-12T13:04:41.000+08:00', '完成时刻（北京时间）即事件退出时刻');

  // 对照：防守轮一直没完成 → 仍然"防守中"（不许误判结束）
  const open = summarizeInstance('a', events.slice(0, 3).map((e) => ({
    tsMs: Date.parse(e.ts), seq: e.seq ?? 0, event: e.event, symbol: e.symbol, roundId: e.roundId, data: e.data,
  })), NOW_MS);
  assert.equal(open.crashes.length, 1);
  assert.equal(open.crashes[0].end, null);
});

test('卡单挂单卖价：新老两种 PROFIT 格式都认，取段内最新一次', () => {
  const events = [
    ev('2026-10-03T01:00:00Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001'),
    ev('2026-10-03T01:01:00Z', 'BUY_FILLED', 'ETHFDUSD', { buyPrice: 100, accCost: 50 }, 'R001', 1),
    // 老格式：params 是 JSON 字符串
    ev('2026-10-03T01:02:00Z', 'PROFIT_PLACE_PARAMS', 'ETHFDUSD', { params: '{"price":105.5,"quantity":0.5,"side":"SELL"}' }, 'R001', 2),
    // 新格式：price 直接在 data 上，且更新 → 必须取这个
    ev('2026-10-03T01:03:00Z', 'PROFIT_PLACE_PARAMS', 'ETHFDUSD', { price: 106.2, quantity: 0.5, side: 'SELL' }, 'R001', 3),
    // 另一个币种：只有老格式
    ev('2026-10-03T02:00:00Z', 'NEW_ROUND', 'BTCFDUSD', {}, 'R002'),
    ev('2026-10-03T02:01:00Z', 'BUY_FILLED', 'BTCFDUSD', { buyPrice: 100, accCost: 50 }, 'R002', 1),
    ev('2026-10-03T02:02:00Z', 'PROFIT_PLACE_PARAMS', 'BTCFDUSD', { params: '{"price":61000.1,"quantity":0.01,"side":"SELL"}' }, 'R002', 2),
  ];
  const s = summarizeInstance('a', events.map((e) => ({
    tsMs: Date.parse(e.ts), seq: e.seq ?? 0, event: e.event, symbol: e.symbol, roundId: e.roundId, data: e.data,
  })), NOW_MS);
  assert.equal(s.stuck.length, 2);
  const eth = s.stuck.find((x) => x.symbol === 'ETHFDUSD');
  const btc = s.stuck.find((x) => x.symbol === 'BTCFDUSD');
  assert.equal(eth.sellPrice, 106.2, '取段内最新一次挂卖价（新格式覆盖老格式）');
  assert.equal(btc.sellPrice, 61000.1, '老格式 params 字符串也要解析出来');
});
