/**
 * `stuck` 分析器单测（`src/analysis/stuck.ts`）—— 卡住轮视图。
 * 重点：跨窗口取"当前仍未收口"的轮、仓位/浮亏只用**观测值**、分档口径、起点不可知时给下界。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { stuckAnalysis, baseAssetOf } = require('../../../dist/analysis/stuck');
const { parseWindow } = require('../../../dist/common/time');

const NOW = new Date('2026-10-04T12:00:00.000Z');
const ev = (ts, event, symbol = 'ETHFDUSD', data = {}, roundId, instance = 'a') => ({ ts, event, symbol, roundId, data, instance, date: ts.slice(0, 10), lineNo: 2 });

/** 账户观测的 balances 形状（与真数据一致） */
const account = (ts, balances, totalValue, instance = 'a') => ev(ts, 'ACCOUNT_OBSERVED', '__account__', { exchange: 'binance', unit: 'FDUSD', balances, assetCount: balances.length, missingCount: 0, totalValue }, undefined, instance);

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
        if (filter.instance && e.instance !== filter.instance) continue;
        if (filter.symbol && !String(e.symbol ?? '').toUpperCase().startsWith(filter.symbol.toUpperCase())) continue;
        n++;
        cb(e);
      }
      return {
        shards: opts.shards ?? 1, events: n, badLines: 0, missingDays: [], provisional: false,
        failedShards: opts.failedShards ?? [], shardWarnings: [],
      };
    },
  };
}

const run = async (events, params = {}, opts = {}) =>
  stuckAnalysis().run({ source: fakeSource(events, opts), now: NOW, window: parseWindow('昨天', NOW), params });

const section = (result, prefix) => result.sections.find((s) => s.heading.startsWith(prefix));
/** 按表头取列（列增删不会让断言错位） */
const cell = (sec, row, name) => row[sec.headers.indexOf(name)];

test('baseAssetOf：ETHFDUSD → ETH（账户观测的 balances 是按资产给的）', () => {
  assert.equal(baseAssetOf('ETHFDUSD'), 'ETH');
  assert.equal(baseAssetOf('BTCUSDT'), 'BTC');
  assert.equal(baseAssetOf('SOLFDUSD'), 'SOL');
  assert.equal(baseAssetOf('ETHBTC'), 'ETH', '计价币也要能认出来（长的先匹配）');
  assert.equal(baseAssetOf('WEIRD'), 'WEIRD', '认不出就原样返回，不猜');
});

test('★核心：跨窗口未收口的轮要能看见，带观测仓位/成本/浮亏', async () => {
  const events = [
    // 3 天前开轮、建了仓，一直没完成（跨天卡住）
    ev('2026-10-01T00:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R007-080000'),
    ev('2026-10-01T00:30:00.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0, buyPrice: 2600, accCost: 2600 }, 'R007-080000'),
    ev('2026-10-01T05:00:00.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 1, buyPrice: 2550, accCost: 5150 }, 'R007-080000'),
    // 最近一次账户观测：锁仓 2 个 ETH，市值 5000（成本 5150 ⇒ 浮亏 -150）
    account('2026-10-04T11:00:00.000Z', [{ asset: 'ETH', qtyFree: 0, qtyLocked: 2, value: 5000 }, { asset: 'FDUSD', qtyFree: 40000, qtyLocked: 0, value: 40000 }], 45000),
    // 补仓 = TOPUP_* 那套独立机制（**不是**网格买单）：下单 2 次、成交 1 次
    ev('2026-10-02T00:00:00.000Z', 'TOPUP_EXECUTED', 'ETHFDUSD', { cost: 500, quantity: 0.2, buyPrice: 2500, remainingTopUp: 1500 }, 'R007-080000'),
    ev('2026-10-02T00:05:00.000Z', 'TOPUP_EXECUTED', 'ETHFDUSD', { cost: 500, quantity: 0.2, buyPrice: 2490, remainingTopUp: 1000 }, 'R007-080000'),
    ev('2026-10-02T00:07:00.000Z', 'TOPUP_ORDER_FILLED', 'ETHFDUSD', { clientOrderId: 'DT01', price: 2490, qty: 0.2 }, 'R007-080000'),
  ];
  const result = await run(events);

  assert.match(result.summary, /1 轮还开着（已建仓 1）/);
  const detail = section(result, '未收口轮');
  assert.equal(detail.rows.length, 1);
  const row = detail.rows[0];
  assert.deepEqual([cell(detail, row, '实例'), cell(detail, row, '币种'), cell(detail, row, '轮次')], ['a', 'ETHFDUSD', 'R007-080000']);
  assert.equal(cell(detail, row, '卡住'), '3.3天', '卡住 = 末笔买入(10-01T05:00) → 此刻(10-04T12:00) = 79h ⇒ 3.3 天');
  assert.equal(cell(detail, row, '本轮仓位'), '2', '本轮数量 = ΔaccCost/buyPrice 累加（2600/2600 + 2550/2550 = 2）');
  assert.equal(cell(detail, row, '账户同币'), '2', '账户里该资产总量（观测值）');
  assert.equal(cell(detail, row, '轮次成本'), '5150.00', '成本 = 该轮最近一条 BUY_FILLED 的 accCost');
  assert.equal(cell(detail, row, '浮亏'), '-150.00', '浮亏 = 本轮数量 × 观测价格(5000/2) − 本轮成本 = 5000 − 5150');
  assert.equal(cell(detail, row, '加仓'), '1', '加仓 = 网格买单笔数 2 − 1（**不是**补仓）');
  assert.equal(cell(detail, row, '补仓'), '1/2下单', '补仓 = TOPUP 成交/下单（成交 1、下单 2 ⇒ 有一单挂着没吃到）');
  assert.match(detail.note, /观测值/, '必须写明这两个数是观测值，不是推算');
});

test('已收口/被掐断的轮不算卡住（还开着 = 没完成 且 没有后继轮）', async () => {
  const events = [
    ev('2026-10-01T00:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R007-080000'),
    ev('2026-10-01T06:00:00.000Z', 'ROUND_COMPLETED', 'ETHFDUSD', { profit: 1, durationHours: 5 }, 'R007-080000'),
  ];
  const result = await run(events);
  assert.match(result.summary, /当前没有还开着的轮/);
  assert.match(result.warnings.join('\n'), /当前没有还开着的轮/);
});

test('★分档口径：>24h / >72h / >7天（对齐回测的卡住率）', async () => {
  const events = [
    ev('2026-10-04T06:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R010-140000'), // 卡 6h
    ev('2026-10-04T06:01:00.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0, accCost: 100 }, 'R010-140000'),
    ev('2026-10-03T00:00:00.000Z', 'NEW_ROUND', 'BTCFDUSD', {}, 'R011-080000'), // 卡 36h
    ev('2026-10-03T00:01:00.000Z', 'BUY_FILLED', 'BTCFDUSD', { index: 0, accCost: 100 }, 'R011-080000'),
    ev('2026-10-01T00:00:00.000Z', 'NEW_ROUND', 'SOLFDUSD', {}, 'R012-080000'), // 卡 84h
    ev('2026-10-01T00:01:00.000Z', 'BUY_FILLED', 'SOLFDUSD', { index: 0, accCost: 100 }, 'R012-080000'),
    ev('2026-09-20T00:00:00.000Z', 'NEW_ROUND', 'XRPFDUSD', {}, 'R013-080000'), // 卡 348h ≈ 14.5 天
    ev('2026-09-20T00:01:00.000Z', 'BUY_FILLED', 'XRPFDUSD', { index: 0, accCost: 100 }, 'R013-080000'),
  ];
  const result = await run(events);
  const buckets = section(result, '卡住分档');
  const at = (label) => buckets.rows.find((r) => r[0] === label)[1];
  assert.equal(at('未收口合计'), '4');
  assert.equal(at('>24h'), '3');
  assert.equal(at('>72h'), '2');
  assert.equal(at('>7天'), '1');
  assert.equal(at('最长卡住（已建仓）'), '14.5天');
});

test('★起点不可知时给下界（≥）并告警，不假装知道开轮时间', async () => {
  const events = [
    // 只有成交，没有 NEW_ROUND（本地分片从这天开始，轮次更早就开了）
    ev('2026-10-02T00:00:00.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0, accCost: 100 }, 'R005-010000'),
  ];
  const result = await run(events);
  const detail = section(result, '未收口轮');
  assert.match(cell(detail, detail.rows[0], '轮次'), /^≥R005/, '轮次名带 ≥：起点早于本地分片');
  assert.match(cell(detail, detail.rows[0], '已开'), /^≥/, '已开也是下界');
  assert.match(result.warnings.join('\n'), /不在已扫描范围/);
  assert.match(result.warnings.join('\n'), /下界/);
});

test('拿不到账户观测时：市值/浮亏显示 "-" 并告警（不编数字）', async () => {
  const events = [
    ev('2026-10-01T00:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R007-080000'),
    ev('2026-10-01T00:30:00.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0, accCost: 2600 }, 'R007-080000'),
  ];
  const result = await run(events);
  const detail = section(result, '未收口轮');
  const row = detail.rows[0];
  assert.equal(cell(detail, row, '本轮仓位'), '0', 'BUY_FILLED 没有 buyPrice 就推不出数量 —— 不编');
  assert.equal(cell(detail, row, '浮亏'), '-');
  assert.match(result.warnings.join('\n'), /拿不到账户观测/);
});

test('★停了的实例要标出来：旧轮不许被当成"正在卡 3 天"', async () => {
  const events = [
    // 实例 a：数据停在 3 天前（实例已停 → 它的旧轮不是"正在卡住"）
    ev('2026-10-01T00:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001-010000', 'a'),
    ev('2026-10-01T00:10:00.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0, accCost: 100 }, 'R001-010000', 'a'),
    // 实例 b：1 小时前还在产出
    ev('2026-10-04T11:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R002-190000', 'b'),
    ev('2026-10-04T11:10:00.000Z', 'BUY_FILLED', 'ETHFDUSD', { index: 0, accCost: 200 }, 'R002-190000', 'b'),
  ];
  const result = await run(events);
  assert.match(result.warnings.join('\n'), /已经很久没有新事件：a（/, '停了的实例必须点名');
  assert.match(result.warnings.join('\n'), /未必真在卡着/);
  const detail = section(result, '未收口轮');
  const rowA = detail.rows.find((r) => cell(detail, r, '实例') === 'a');
  const rowB = detail.rows.find((r) => cell(detail, r, '实例') === 'b');
  assert.match(cell(detail, rowA, '数据'), /^⚠/, '停了的实例带 ⚠');
  assert.ok(!/^⚠/.test(cell(detail, rowB, '数据')), '活跃实例不该被标 ⚠');
});

test('账户观测：列出每个实例最新一条（含锁仓资产）', async () => {
  const events = [
    ev('2026-10-04T10:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R007-080000'),
    account('2026-10-04T10:30:00.000Z', [{ asset: 'ETH', qtyFree: 0, qtyLocked: 1.5, value: 3750 }], 50000, 'a'),
    account('2026-10-04T10:40:00.000Z', [{ asset: 'ETH', qtyFree: 0.2, qtyLocked: 0, value: 500 }], 30000, 'b'),
  ];
  const result = await run(events);
  const rows = section(result, '账户观测').rows;
  assert.equal(rows.length, 2, '两个实例各一行');
  const b = rows.find((r) => r[0] === 'b');
  assert.equal(b[4], 'ETH 0.2', 'b 的 ETH 全是可用（qtyLocked=0）—— 仓位要把可用算进去（撤单后就不再锁仓）');
  const a = rows.find((r) => r[0] === 'a');
  assert.equal(a[4], 'ETH 1.5');
});

test('分片读不出来时：明说"轮次状态可能不完整"，不许当成"没有卡住轮"', async () => {
  const result = await run([ev('2026-10-04T10:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001-100000')], {}, { failedShards: [{ key: 'snapshot/a/2026-09-01.jsonl.gz', errors: ['gzip 坏'] }] });
  assert.match(result.warnings.join('\n'), /轮次状态可能不完整/);
});

test('symbol / instance 过滤生效（只看某个实例的卡住轮）', async () => {
  const events = [
    ev('2026-10-04T06:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001-140000', 'a'),
    ev('2026-10-04T07:00:00.000Z', 'NEW_ROUND', 'ETHFDUSD', {}, 'R001-150000', 'b'),
  ];
  const onlyA = await run(events, { instance: 'a' });
  const detailA = section(onlyA, '未收口轮');
  assert.equal(detailA.rows.length, 1);
  assert.equal(cell(detailA, detailA.rows[0], '实例'), 'a');

  const onlyBtc = await run(events, { symbol: 'btc' });
  assert.match(onlyBtc.summary, /当前没有还开着的轮/);
});
