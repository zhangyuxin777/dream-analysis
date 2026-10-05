/**
 * `topup` 分析器单测。
 * 重点：**下单 ≠ 成交**（模板注释特意强调过）、"补不动了"的三个信号、跳过原因、金额按分累加。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { topupAnalysis } = require('../../../dist/analysis/topup');
const { parseWindow } = require('../../../dist/common/time');

const NOW = new Date('2026-10-04T12:00:00.000Z');
const ev = (ts, event, data = {}, roundId = 'R010-080000', instance = 'a', symbol = 'ETHFDUSD') =>
  ({ ts, event, symbol, roundId, data, instance, date: ts.slice(0, 10), lineNo: 2 });

function fakeSource(events, opts = {}) {
  return {
    instances: () => [...new Set(events.map((e) => e.instance))],
    shards: () => [],
    availableDays: () => [...new Set(events.map((e) => e.date))],
    scan: async (filter, cb) => {
      let n = 0;
      for (const e of events) {
        const ms = Date.parse(e.ts);
        if (ms < filter.window.fromMs || ms >= filter.window.toMs) continue;
        if (filter.instance && e.instance !== filter.instance) continue;
        n++;
        cb(e);
      }
      return { shards: opts.shards ?? 1, events: n, badLines: 0, missingDays: [], provisional: false, failedShards: [], shardWarnings: [] };
    },
  };
}

const run = async (events, params = {}) =>
  topupAnalysis().run({ source: fakeSource(events), now: NOW, window: parseWindow(params.window ?? '近7d', NOW), params });
const section = (r, prefix) => r.sections.find((s) => s.heading.startsWith(prefix));
const overview = (r) => Object.fromEntries(section(r, '概览').rows.map((x) => [x[0], x[1]]));

test('★下单 ≠ 成交：TOPUP_EXECUTED 只算下单，成交看 TOPUP_ORDER_FILLED', async () => {
  const events = [
    ev('2026-10-03T01:00:00.000Z', 'TOPUP_TRIGGERED', { topUpAmount: 500, remaining: 2000, bidPrice: 2500, quantity: 0.2 }),
    ev('2026-10-03T01:00:10.000Z', 'TOPUP_EXECUTED', { cost: 500, quantity: 0.2, buyPrice: 2500, remainingTopUp: 1500 }),
    ev('2026-10-03T01:00:20.000Z', 'TOPUP_EXECUTED', { cost: 500, quantity: 0.2, buyPrice: 2490, remainingTopUp: 1000 }),
    ev('2026-10-03T01:05:00.000Z', 'TOPUP_ORDER_FILLED', { clientOrderId: 'DT01', price: 2490, qty: 0.2 }),
  ];
  const result = await run(events);
  const o = overview(result);
  assert.equal(o['下单 / 成交'], '2 / 1', '下单 2（EXECUTED）与成交 1（ORDER_FILLED）必须分开');
  assert.equal(o['补仓下单金额合计'], '1000.00', 'Σ cost = 500+500 = 1000（报价币）');
  assert.equal(o['补仓成交金额合计'], '498.00', '成交金额 = price×qty = 2490×0.2');
  assert.equal(o['最近一次下单后的剩余额度'], '1000.00', 'remainingTopUp 取最近一次');
  assert.match(result.warnings.join('\n'), /下单 2 次但只看到 1 次成交/);
  assert.match(result.warnings.join('\n'), /不影响落盘/, '成交事件在白名单里 ⇒ 不能把差值归因成"采集盲区"');
});

test('★补不动了的三个信号：到最后一档（程序报的卡了多久）/ 额度用尽 / 换卖单失败', async () => {
  const events = [
    ev('2026-10-02T01:00:00.000Z', 'TOPUP_LAST_TIER_REACHED', { profitPercent: 0.003, elapsedHours: 52.5 }),
    ev('2026-10-02T02:00:00.000Z', 'TOPUP_EXHAUSTED', {}),
    ev('2026-10-02T03:00:00.000Z', 'TOPUP_REPLACE_FAILED', { error: 'insufficient balance' }),
  ];
  const result = await run(events);
  const warning = result.warnings.join('\n');
  assert.match(warning, /补仓已成交但换卖单失败/, 'REPLACE_FAILED 是最该立刻看的（模板注释：不会自动重挂、需人工）');
  assert.match(warning, /这轮在下一笔买单成交前\*\*不会卖出\*\*/);
  assert.match(warning, /1 次补仓额度\*\*已用尽\*\*/);
  assert.match(warning, /1 次走到\*\*最后一档\*\*（程序自己的判据）.*程序自报的最长"stuck" 52\.5h/s);
  assert.match(warning, /不是\*\*"到达最后一档之后过了多久"/, 'elapsedHours 的口径要写清（主仓按 now − lastBuyFillTime 算）');

  const signals = section(result, '补不动了的信号');
  const kinds = signals.rows.map((r) => r[0]);
  assert.deepEqual(kinds.sort(), ['到最后一档', '换卖单失败(需人工)', '额度用尽'].sort());
  const lastTier = signals.rows.find((r) => r[0] === '到最后一档');
  assert.match(lastTier[5], /程序自报 stuck=52\.5h/, 'elapsedHours 是程序自己报的"stuck"（口径写在明细里）');
});

test('为什么没补：TOPUP_SKIPPED 要带 drawdown/threshold 明细', async () => {
  const events = [ev('2026-10-03T01:00:00.000Z', 'TOPUP_SKIPPED', { drawdown: 0.012, threshold: 0.02, avgPrice: 2600, bidPrice: 2569 })];
  const result = await run(events);
  const skipped = section(result, '为什么没补');
  assert.equal(skipped.rows.length, 1);
  assert.match(skipped.rows[0][4], /drawdown=0\.012/);
  assert.match(skipped.rows[0][4], /threshold=0\.02/);
  assert.match(result.warnings.join('\n'), /一次补仓都没下/);
});

test('按币种/按轮次统计 + symbol 过滤；金额按分累加不受浮点影响', async () => {
  const events = [
    ev('2026-10-03T01:00:00.000Z', 'TOPUP_EXECUTED', { cost: 0.1, quantity: 1, buyPrice: 0.1, remainingTopUp: 0.2 }, 'R1', 'a', 'ETHFDUSD'),
    ev('2026-10-03T01:01:00.000Z', 'TOPUP_EXECUTED', { cost: 0.2, quantity: 1, buyPrice: 0.2, remainingTopUp: 0 }, 'R1', 'a', 'ETHFDUSD'),
    ev('2026-10-03T02:00:00.000Z', 'TOPUP_EXECUTED', { cost: 1, quantity: 1, buyPrice: 1, remainingTopUp: 9 }, 'R2', 'a', 'BTCFDUSD'),
  ];
  const all = await run(events);
  assert.equal(overview(all)['补仓下单金额合计'], '-（多币种，见"按币种"表）', '不同报价币的钱不能相加（0.1+0.2+1 这个"1.30"是假的）');
  const bySym = section(all, '按币种');
  const ethRow = bySym.rows.find((r) => r[0] === 'ETHFDUSD');
  const btcRow = bySym.rows.find((r) => r[0] === 'BTCFDUSD');
  assert.equal(ethRow[8], '0.30', 'ETH 自己的下单金额 = 0.1+0.2（按分累加，不受浮点影响）');
  assert.equal(btcRow[8], '1.00');

  const onlyBtc = await run(events, { symbol: 'btc' });
  const o = overview(onlyBtc);
  assert.equal(o['下单 / 成交'], '1 / 0', 'symbol 过滤后只统计 BTC');
  assert.equal(o['补仓下单金额合计'], '1.00', '只有一个币种时才给合计');
  assert.match(onlyBtc.title, /BTC/);
});

test('窗口内没有补仓事件时：明确说这是"有用信息"，不是数据缺失', async () => {
  const result = await run([ev('2026-10-03T01:00:00.000Z', 'BUY_FILLED', { index: 0 })]);
  assert.match(result.summary, /没有补仓事件/);
  assert.match(result.warnings.join('\n'), /这本身是有用信息/);
});
