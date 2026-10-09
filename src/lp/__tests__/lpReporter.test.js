'use strict';
/**
 * lpReporter 单测：渲染与触发判定的纯逻辑（假 EventSource，不碰磁盘/OSS/网络）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderDaily, renderOpenOrders, evaluateTriggers, collectFacts } = require('../../../dist/lp/lpReporter');

const ACCOUNT = {
  instance: 'boye888',
  label: '你的账户（10 万 U）',
  principal: 100000,
  conversationId: '',
  dailyHour: 21,
  dailyMinute: 7,
  dayProfitAlertPct: 0.3,
  stuckAlertHours: 24,
};

const NOW = new Date('2026-10-07T13:00:00.000Z'); // 北京 21:00

function facts(over = {}) {
  return {
    days: ['2026-10-06'],
    totalProfit: 49.24,
    todayProfit: 49.24,
    todayRounds: 25,
    completedRounds: 25,
    latestObs: { t: '2026-10-07T12:00:00.000Z', total: 100137.02, fdusdFree: 94444 },
    latestPrices: {},
    openRounds: [],
    crashes: [],
    topupCount: 0,
    zeroToday: false,
    ...over,
  };
}

test('日报：正常日渲染（含数据时间，无"无需任何操作"）', () => {
  const text = renderDaily(facts(), ACCOUNT, NOW);
  assert.ok(text.includes('【日报】你的账户（10 万 U）'));
  assert.ok(text.includes('今日收益：+$49.24'));
  assert.ok(text.includes('累计收益：+$137.02（+0.14%）')); // 权益口径：估值 100137.02 - 本金 100000
  assert.ok(text.includes('正常运作中，今天完成 25 轮买卖'));
  assert.ok(text.includes('数据时间：'));
  assert.ok(!text.includes('无需任何操作'));
});

test('日报：零盈利日状态行不同', () => {
  const text = renderDaily(facts({ todayProfit: 0, todayRounds: 0, zeroToday: true }), ACCOUNT, NOW);
  assert.ok(text.includes('今日收益：+$0.00'));
  assert.ok(text.includes('持仓等待中'));
});

test('日报：浮亏时累计收益显示负数，不出现 +$- 或 +-%', () => {
  const text = renderDaily(
    facts({ latestObs: { t: '2026-10-07T12:00:00.000Z', total: 99969.02, fdusdFree: 94444 } }),
    ACCOUNT, NOW,
  );
  assert.ok(text.includes('累计收益：-$30.98（-0.03%）'));
  assert.ok(!text.includes('+$-'));
  assert.ok(!text.includes('+-'));
});

test('触发：超过 48 小时的深跌是旧闻，首次部署不当新闻推', () => {
  const f = facts({
    crashes: [{ enteredAt: '2026-10-03T01:00:00.000Z', symbol: 'ETHFDUSD', exitedAt: '2026-10-03T07:00:00.000Z', durationSec: 21600, totalCost: 0 }],
  });
  const r = evaluateTriggers(f, ACCOUNT, NOW, undefined);
  assert.equal(r.hits.length, 0);
});

test('日报：深跌防守中 —— 状态行必须是防守口径（不是"市场平淡"），含持仓与备用金', () => {
  const text = renderDaily(facts({
    crashes: [
      { enteredAt: '2026-10-07T13:38:54Z', symbol: 'BTCFDUSD', exitedAt: null, durationSec: null, totalCost: null, dropPercent: 0.04 },
      { enteredAt: '2026-10-07T02:01:17Z', symbol: 'ETHFDUSD', exitedAt: null, durationSec: null, totalCost: null, dropPercent: 0.04 },
    ],
    openRounds: [
      { roundId: 'R1', symbol: 'BTCFDUSD', lastBuyAt: '2026-10-08T01:00:00Z', sellPrice: null, buyCount: 3, totalCost: 18245.17, avgBuyPrice: 83500, lastBuyPrice: 83000, topupCount: 0 },
      { roundId: 'R2', symbol: 'ETHFDUSD', lastBuyAt: '2026-10-08T01:00:00Z', sellPrice: null, buyCount: 2, totalCost: 23522.09, avgBuyPrice: 2600, lastBuyPrice: 2580, topupCount: 0 },
    ],
  }), ACCOUNT, NOW);
  assert.ok(text.includes('市场急跌中（'));
  assert.ok(text.includes('短时跌幅超 4%）'));
  assert.ok(text.includes('ETH') && text.includes('BTC'));
  assert.ok(text.includes('防守状态'));
  assert.ok(text.includes('当前持仓：BTC $18,245.17 + ETH $23,522.09'));
  assert.ok(text.includes('备用资金未动用'));
  assert.ok(!text.includes('市场平淡'));
});

test('日报：今日急跌已退出 —— 报告防守结果', () => {
  const text = renderDaily(facts({
    crashes: [{ enteredAt: '2026-10-07T13:38:54Z', symbol: 'BTCFDUSD', exitedAt: '2026-10-07T13:00:00Z', durationSec: 1800, totalCost: 0, dropPercent: 0.04 }],
  }), ACCOUNT, NOW);
  assert.ok(text.includes('今天市场出现过急跌，程序自动防守后已恢复正常'));
  assert.ok(text.includes('没有动用你的备用资金'));
});

test('日报：零盈利但有持仓 —— 不说"市场平淡"', () => {
  const text = renderDaily(facts({
    todayProfit: 0, todayRounds: 0, zeroToday: true,
    openRounds: [{ roundId: 'R1', symbol: 'ETHFDUSD', lastBuyAt: '2026-10-07T06:00:00Z', sellPrice: 2700, buyCount: 1, totalCost: 500, avgBuyPrice: 2700, lastBuyPrice: 2700, topupCount: 0 }],
  }), ACCOUNT, NOW);
  assert.ok(text.includes('持仓等待中'));
  assert.ok(!text.includes('市场平淡'));
});

test('触发：深跌退出后报一次，有状态记录后不再报', () => {
  const f = facts({
    crashes: [{ enteredAt: '2026-10-07T01:00:00.000Z', symbol: 'ETHFDUSD', exitedAt: '2026-10-07T07:00:00.000Z', durationSec: 21600, totalCost: 0 }],
  });
  const first = evaluateTriggers(f, ACCOUNT, NOW, undefined);
  assert.equal(first.hits.length, 1);
  assert.equal(first.hits[0].kind, 'crash');
  assert.ok(first.hits[0].message.includes('没有动用你的备用资金'));
  const second = evaluateTriggers(f, ACCOUNT, NOW, first.next);
  assert.equal(second.hits.length, 0);
});

test('触发：未退出的深跌不报（等结果出来再报）', () => {
  const f = facts({
    crashes: [{ enteredAt: '2026-10-07T12:00:00.000Z', symbol: 'ETHFDUSD', exitedAt: null, durationSec: null, totalCost: null }],
  });
  const r = evaluateTriggers(f, ACCOUNT, NOW, undefined);
  assert.equal(r.hits.length, 0);
});

test('触发：卡轮超过阈值报一次，含投入/均价/挂卖价详情', () => {
  const f = facts({
    openRounds: [{
      roundId: 'R001', symbol: 'BTCFDUSD', lastBuyAt: '2026-10-02T12:00:00.000Z', sellPrice: 86870.73,
      buyCount: 3, totalCost: 2547.12, avgBuyPrice: 85781.38, lastBuyPrice: 85781.38, topupCount: 0,
    }],
  });
  const first = evaluateTriggers(f, ACCOUNT, NOW, undefined);
  assert.equal(first.hits.length, 1);
  assert.equal(first.hits[0].kind, 'stuck');
  const m = first.hits[0].message;
  assert.ok(m.includes('已等待 5 天 1 小时尚未卖出')); // 10-02 12:00 → 10-07 21:00 北京
  assert.ok(m.includes('已投入资金：$2,547.12（分 3 笔买入）'));
  assert.ok(m.includes('买入均价：$85,781.38'));
  assert.ok(m.includes('最近一笔买入：$85,781.38'));
  assert.ok(m.includes('当前挂卖价：$86,870.73，比买入均价高 1.3%'));
  assert.ok(!m.includes('备用金'));
  const again = evaluateTriggers(f, ACCOUNT, NOW, first.next);
  assert.equal(again.hits.length, 0);
});

test('触发：卡轮动用备用金会明示', () => {
  const f = facts({
    openRounds: [{
      roundId: 'R003', symbol: 'ETHFDUSD', lastBuyAt: '2026-10-02T12:00:00.000Z', sellPrice: null,
      buyCount: 5, totalCost: 1200, avgBuyPrice: 2650, lastBuyPrice: 2600, topupCount: 2,
    }],
  });
  const r = evaluateTriggers(f, ACCOUNT, NOW, undefined);
  assert.equal(r.hits.length, 1);
  assert.ok(r.hits[0].message.includes('已动用备用金 2 次'));
});

test('触发：卡轮未达阈值不报', () => {
  const f = facts({
    openRounds: [{ roundId: 'R002', symbol: 'ETHFDUSD', lastBuyAt: '2026-10-07T06:00:00.000Z', sellPrice: 2705, buyCount: 1, totalCost: 500, avgBuyPrice: 2700, lastBuyPrice: 2700, topupCount: 0 }],
  });
  const r = evaluateTriggers(f, ACCOUNT, NOW, undefined);
  assert.equal(r.hits.length, 0);
});

test('触发：单日超额收益每天最多一次', () => {
  const f = facts({ todayProfit: 350 }); // ≥ 100000×0.3%
  const first = evaluateTriggers(f, ACCOUNT, NOW, undefined);
  assert.equal(first.hits.length, 1);
  assert.equal(first.hits[0].kind, 'day_spike');
  const again = evaluateTriggers(f, ACCOUNT, NOW, first.next);
  assert.equal(again.hits.length, 0);
  // 阈值以下不报
  const low = evaluateTriggers(facts({ todayProfit: 100 }), ACCOUNT, NOW, undefined);
  assert.equal(low.hits.length, 0);
});

test('collectFacts：重启恢复的残影轮不算未平仓（只认同轮号里活动最新的）', async () => {
  const evs = [
    // R009 原始轮：买入后 81 秒被重启恢复接管
    { ts: '2026-10-02T04:50:34Z', event: 'NEW_ROUND', symbol: 'BTCFDUSD', roundId: 'R009-125034', data: {} },
    { ts: '2026-10-02T04:54:28Z', event: 'BUY_FILLED', symbol: 'BTCFDUSD', roundId: 'R009-125034', data: { buyPrice: 86688.95, accCost: 224.52 } },
    { ts: '2026-10-02T04:55:47Z', event: 'RECOVERY_APPLIED', symbol: 'BTCFDUSD', roundId: 'R009-125547-RCV', data: {} },
    // 接管后的 -RCV 轮继续买入并完成（仓位其实当天就卖了）
    { ts: '2026-10-02T05:17:28Z', event: 'BUY_FILLED', symbol: 'BTCFDUSD', roundId: 'R009-125547-RCV', data: { buyPrice: 86552.6, accCost: 471.2 } },
    { ts: '2026-10-02T06:00:00Z', event: 'ROUND_COMPLETED', symbol: 'BTCFDUSD', roundId: 'R009-125547-RCV', data: { profit: 2.5 } },
    // 另一个轮：恢复接管后没有新买入（仓位直接 carried over 卖出），残影同样要排除
    { ts: '2026-10-06T08:08:10Z', event: 'NEW_ROUND', symbol: 'BTCFDUSD', roundId: 'R062-160810', data: {} },
    { ts: '2026-10-06T08:10:00Z', event: 'BUY_FILLED', symbol: 'BTCFDUSD', roundId: 'R062-160810', data: { buyPrice: 86000, accCost: 224.27 } },
    { ts: '2026-10-06T08:23:59Z', event: 'RECOVERY_APPLIED', symbol: 'BTCFDUSD', roundId: 'R062-162358-RCV', data: {} },
    { ts: '2026-10-06T08:47:39Z', event: 'SELL_FILLED', symbol: 'BTCFDUSD', roundId: 'R062-162358-RCV', data: {} },
    { ts: '2026-10-06T08:47:39Z', event: 'ROUND_COMPLETED', symbol: 'BTCFDUSD', roundId: 'R062-162358-RCV', data: { profit: 1.5 } },
    { ts: '2026-10-06T08:47:40Z', event: 'ORDER_CANCELED', symbol: 'BTCFDUSD', roundId: 'R062-162358-RCV', data: {} },
    // 真实未平仓轮：没有任何恢复事件
    { ts: '2026-10-07T02:00:00Z', event: 'NEW_ROUND', symbol: 'BTCFDUSD', roundId: 'R073-230148', data: {} },
    { ts: '2026-10-07T02:01:16Z', event: 'BUY_FILLED', symbol: 'BTCFDUSD', roundId: 'R073-230148', data: { buyPrice: 85000, accCost: 18517.78 } },
  ];
  const fakeSource = {
    availableDays: () => ['2026-10-02', '2026-10-06'],
    scan: async (_f, onEvent) => { for (const e of evs) onEvent({ ...e, instance: 'boye888', date: e.ts.slice(0, 10), lineNo: 1 }); },
  };
  const f = await collectFacts(fakeSource, ACCOUNT, NOW);
  const ids = f.openRounds.map((r) => r.roundId).sort();
  assert.deepEqual(ids, ['R073']); // 两个完成轮（含恢复接管的）都不在未平仓里；按轮号合并
  assert.equal(f.openRounds[0].buyCount, 1);
  assert.equal(f.totalProfit, 4.0);
});

test('挂单详情：正常持仓 —— 卖单价/数量/距离/预计收益齐全', () => {
  const f = facts({
    latestObs: { t: '2026-10-08T22:00:02Z', total: 97994.07, fdusdFree: 49340 },
    latestPrices: { ETH: 2485.1, BTC: 81886.3 },
    openRounds: [{
      roundId: 'R059-231427', symbol: 'ETHFDUSD', lastBuyAt: '2026-10-07T02:01:18Z',
      sellPrice: 2655.09, sellQty: 9.1248, sellPlacedAt: '2026-10-08T02:02:16Z', sellLive: true,
      buyCount: 30, totalCost: 24189.95, avgBuyPrice: 2652.1, lastBuyPrice: 2609.1, topupCount: 0,
    }],
  });
  const text = renderOpenOrders(f, ACCOUNT, NOW);
  assert.ok(text.includes('【挂单详情】你的账户（10 万 U）'));
  assert.ok(text.includes('◆ ETH 持仓'));
  assert.ok(text.includes('挂卖价：$2,655.09（9.12 个）'));
  assert.ok(text.includes('已投入 $24,189.95，分 30 笔买入，均价 $2,652.10'));
  assert.ok(text.includes('最新价 $2,485.10，再涨 6.8% 自动成交'));
  assert.ok(text.includes('成交后预计赚：+$37.22')); // 2655.09×9.1248 − 24189.95 ≈ 37.22
  assert.ok(text.includes('数据时间：'));
});

test('挂单详情：无持仓 —— 资金待命口径', () => {
  const text = renderOpenOrders(facts({ openRounds: [] }), ACCOUNT, NOW);
  assert.ok(text.includes('当前没有持仓，全部资金在场外待命'));
  assert.ok(!text.includes('◆'));
});

test('挂单详情：卖单被撤未重挂 —— 说"调整中"不报预计收益', () => {
  const f = facts({
    openRounds: [{
      roundId: 'R1', symbol: 'BTCFDUSD', lastBuyAt: '2026-10-08T04:00:00Z',
      sellPrice: 84385.07, sellQty: 0.27328, sellPlacedAt: '2026-10-08T15:37:57Z', sellLive: false,
      buyCount: 5, totalCost: 22300, avgBuyPrice: 81500, lastBuyPrice: 81000, topupCount: 0,
    }],
  });
  const text = renderOpenOrders(f, ACCOUNT, NOW);
  assert.ok(text.includes('程序正在调整中（暂时撤下）'));
  assert.ok(!text.includes('成交后预计赚'));
  assert.ok(!text.includes('再涨'));
});

test('collectFacts：挂单详情 —— 两种 PROFIT 格式都认，撤销后未重挂 = 卖单不在市', async () => {
  const evs = [
    { ts: '2026-10-07T02:00:00Z', event: 'NEW_ROUND', symbol: 'ETHFDUSD', roundId: 'R1', data: {} },
    { ts: '2026-10-07T02:01:00Z', event: 'BUY_FILLED', symbol: 'ETHFDUSD', roundId: 'R1', data: { buyPrice: 2600, accCost: 1000 } },
    // 老格式：params 是 JSON 字符串
    { ts: '2026-10-07T02:02:00Z', event: 'PROFIT_PLACE_PARAMS', symbol: 'ETHFDUSD', roundId: 'R1', data: { params: '{"price":2650.5,"quantity":0.38,"side":"SELL"}' } },
    { ts: '2026-10-07T03:00:00Z', event: 'NEW_ROUND', symbol: 'BTCFDUSD', roundId: 'R2', data: {} },
    { ts: '2026-10-07T03:01:00Z', event: 'BUY_FILLED', symbol: 'BTCFDUSD', roundId: 'R2', data: { buyPrice: 84000, accCost: 2000 } },
    // 新格式：price/quantity 直接在 data 上
    { ts: '2026-10-07T03:02:00Z', event: 'PROFIT_PLACE_PARAMS', symbol: 'BTCFDUSD', roundId: 'R2', data: { price: 84500.1, quantity: 0.0238, side: 'SELL' } },
    // 新挂的卖单 1 秒后被撤（side=SELL 的 ORDER_CANCELED），且没有重挂
    { ts: '2026-10-07T03:02:01Z', event: 'ORDER_CANCELED', symbol: 'BTCFDUSD', roundId: 'R2', data: { orderInfo: '{"c":"x","S":"SELL","q":"0.02380000","p":"84500.10000000"}' } },
    // 快照给市价
    { ts: '2026-10-07T04:00:02Z', event: 'ACCOUNT_OBSERVED', symbol: '__account__', data: { totalValue: 99000, balances: [{ asset: 'ETH', qtyFree: 0, qtyLocked: 0.38, value: 944.06 }, { asset: 'FDUSD', qtyFree: 97000 }] } },
  ];
  const fakeSource = {
    availableDays: () => ['2026-10-07'],
    scan: async (_f, onEvent) => { for (const e of evs) onEvent({ ...e, instance: 'boye888', date: e.ts.slice(0, 10), lineNo: 1 }); },
  };
  const f = await collectFacts(fakeSource, ACCOUNT, NOW);
  assert.equal(f.openRounds.length, 2);
  const eth = f.openRounds.find((r) => r.symbol === 'ETHFDUSD');
  assert.equal(eth.sellPrice, 2650.5); // 老格式 params 字符串解析
  assert.equal(eth.sellQty, 0.38);
  assert.equal(eth.sellLive, true);
  const btc = f.openRounds.find((r) => r.symbol === 'BTCFDUSD');
  assert.equal(btc.sellPrice, 84500.1); // 新格式直接字段
  assert.equal(btc.sellLive, false); // 撤销晚于挂出 → 不在市
  assert.ok(Math.abs(f.latestPrices.ETH - 944.06 / 0.38) < 0.01);
});

test('collectFacts：重启恢复接管后仍未平仓 —— 仓位必须还在（2026-10-09 实盘踩坑回归）', async () => {
  const evs = [
    // R059 原始轮：10-07 买入 31 笔，10-07 进深跌
    { ts: '2026-10-07T02:00:00Z', event: 'NEW_ROUND', symbol: 'ETHFDUSD', roundId: 'R059-231427', data: {} },
    { ts: '2026-10-07T02:01:16Z', event: 'BUY_FILLED', symbol: 'ETHFDUSD', roundId: 'R059-231427', data: { buyPrice: 2609.1, accCost: 24189.95 } },
    { ts: '2026-10-07T02:01:17Z', event: 'CRASH_ENTERED', symbol: 'ETHFDUSD', roundId: 'R059-231427', data: { dropPercent: 0.04 } },
    // 10-09 16:17 北京重启，恢复接管为新 roundId，无新买入、未完成 —— 仓位应保留
    { ts: '2026-10-09T08:17:16Z', event: 'STARTUP_RECOVERY_DONE', symbol: 'ETHFDUSD', roundId: 'R059-161716-RCV', data: { accCost: 24189.95, accSz: 9.1248, isCrashMode: true } },
    { ts: '2026-10-09T08:17:17Z', event: 'RECOVERY_APPLIED', symbol: 'ETHFDUSD', roundId: 'R059-161716-RCV', data: {} },
    // 恢复接管后重挂的卖单（挂在新的 roundId 下）
    { ts: '2026-10-09T08:18:00Z', event: 'PROFIT_PLACE_PARAMS', symbol: 'ETHFDUSD', roundId: 'R059-161716-RCV', data: { price: 2652.4, quantity: 9.1248, side: 'SELL' } },
    // 快照：币还在
    { ts: '2026-10-09T09:00:02Z', event: 'ACCOUNT_OBSERVED', symbol: '__account__', data: { totalValue: 98456, balances: [{ asset: 'ETH', qtyFree: 0, qtyLocked: 9.1248, value: 22882.16 }, { asset: 'FDUSD', qtyFree: 49340.25 }] } },
  ];
  const fakeSource = {
    availableDays: () => ['2026-10-07', '2026-10-09'],
    scan: async (_f, onEvent) => { for (const e of evs) onEvent({ ...e, instance: 'boye888', date: e.ts.slice(0, 10), lineNo: 1 }); },
  };
  const f = await collectFacts(fakeSource, ACCOUNT, NOW);
  assert.equal(f.openRounds.length, 1);
  assert.equal(f.openRounds[0].roundId, 'R059'); // 按轮号合并
  assert.equal(f.openRounds[0].buyCount, 1);
  assert.equal(f.openRounds[0].totalCost, 24189.95);
  assert.equal(f.openRounds[0].sellPrice, 2652.4); // 卖单从恢复后的新 id 下取到
  assert.equal(f.openRounds[0].sellLive, true);
});

test('collectFacts：轮号重号 —— 上一段已完成后再开的同号轮是全新逻辑轮，不与旧段合并', async () => {
  const evs = [
    // 第一段 R059：10-06 开仓、买入、完成（实盘 10-06 真实发生过）
    { ts: '2026-10-06T05:08:16Z', event: 'NEW_ROUND', symbol: 'ETHFDUSD', roundId: 'R059-130816', data: {} },
    { ts: '2026-10-06T05:42:59Z', event: 'BUY_FILLED', symbol: 'ETHFDUSD', roundId: 'R059-130816', data: { buyPrice: 2700, accCost: 500 } },
    { ts: '2026-10-06T07:46:53Z', event: 'ROUND_COMPLETED', symbol: 'ETHFDUSD', roundId: 'R059-130816', data: { profit: 2.0 } },
    // 第二段 R059：10-07 重号新开（实盘同样真实发生过），未平仓
    { ts: '2026-10-06T23:14:27Z', event: 'NEW_ROUND', symbol: 'ETHFDUSD', roundId: 'R059-231427', data: {} },
    { ts: '2026-10-07T02:01:16Z', event: 'BUY_FILLED', symbol: 'ETHFDUSD', roundId: 'R059-231427', data: { buyPrice: 2609.1, accCost: 24189.95 } },
    { ts: '2026-10-07T02:02:00Z', event: 'PROFIT_PLACE_PARAMS', symbol: 'ETHFDUSD', roundId: 'R059-231427', data: { price: 2652.4, quantity: 9.1248, side: 'SELL' } },
  ];
  const fakeSource = {
    availableDays: () => ['2026-10-06', '2026-10-07'],
    scan: async (_f, onEvent) => { for (const e of evs) onEvent({ ...e, instance: 'boye888', date: e.ts.slice(0, 10), lineNo: 1 }); },
  };
  const f = await collectFacts(fakeSource, ACCOUNT, NOW);
  assert.equal(f.openRounds.length, 1); // 只有第二段是活轮；若按轮号无脑合并会 0 个
  assert.equal(f.openRounds[0].roundId, 'R059');
  assert.equal(f.openRounds[0].totalCost, 24189.95); // 第二段 accCost 独立（NEW_ROUND 重置链，未被旧段 500 污染）
  assert.equal(f.openRounds[0].buyCount, 1);
  assert.equal(f.totalProfit, 2.0);
});

test('collectFacts：从假事件源聚合（总利润/今天/未收口轮/最新估值）', async () => {
  const evs = [
    { ts: '2026-10-06T10:00:00.000Z', event: 'NEW_ROUND', symbol: 'ETHFDUSD', roundId: 'R1', data: {} },
    { ts: '2026-10-06T10:05:00.000Z', event: 'BUY_FILLED', symbol: 'ETHFDUSD', roundId: 'R1', data: {} },
    { ts: '2026-10-06T11:00:00.000Z', event: 'ROUND_COMPLETED', symbol: 'ETHFDUSD', roundId: 'R1', data: { profit: 1.5 } },
    { ts: '2026-10-07T01:00:00.000Z', event: 'NEW_ROUND', symbol: 'BTCFDUSD', roundId: 'R2', data: {} },
    { ts: '2026-10-07T01:05:00.000Z', event: 'BUY_FILLED', symbol: 'BTCFDUSD', roundId: 'R2', data: {} },
    { ts: '2026-10-07T02:00:00.000Z', event: 'ACCOUNT_OBSERVED', symbol: '__account__', data: { totalValue: 100001.5, balances: [{ asset: 'FDUSD', qtyFree: 99000 }] } },
    { ts: '2026-10-07T02:30:00.000Z', event: 'TOPUP_PLACED', symbol: 'BTCFDUSD', roundId: 'R2', data: {} },
  ];
  const fakeSource = {
    availableDays: () => ['2026-10-06', '2026-10-07'],
    scan: async (_f, onEvent) => { for (const e of evs) onEvent({ ...e, instance: 'boye888', date: e.ts.slice(0, 10), lineNo: 1 }); },
  };
  const f = await collectFacts(fakeSource, ACCOUNT, NOW);
  assert.equal(f.totalProfit, 1.5);
  assert.equal(f.todayProfit, 0); // R1 是昨天完成的
  assert.equal(f.completedRounds, 1);
  assert.equal(f.openRounds.length, 1);
  assert.equal(f.openRounds[0].roundId, 'R2');
  assert.equal(f.latestObs.total, 100001.5);
  assert.equal(f.topupCount, 1);
  assert.equal(f.zeroToday, true);
});
