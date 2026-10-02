/**
 * `health` 分析器单测（`src/analysis/health.ts`）
 * 用**内存假事件源**（真事件源另有单测），只验聚合与"该报的必须报"。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { healthAnalysis, HEARTBEAT_GAP_ALERT_MS } = require('../../../dist/analysis/health');
const { parseWindow } = require('../../../dist/common/time');

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ev = (ts, event, symbol = 'ETHFDUSD', data = {}) => ({ ts, event, symbol, data, instance: 'a', date: ts.slice(0, 10), lineNo: 2 });

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
      return { shards: opts.shards ?? 1, events: n, badLines: opts.badLines ?? 0, missingDays: opts.missingDays ?? [], provisional: opts.provisional ?? false };
    },
  };
}

const run = async (events, opts = {}, params = {}) =>
  healthAnalysis().run({ source: fakeSource(events, opts), now: NOW, window: parseWindow(params.window ?? '昨天', NOW), params });

test('概览：事件数/分片/异常计数/心跳间隔/最近估值', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'ACCOUNT_OBSERVED', '__account__', { totalValue: 1000, exchange: 'binance' }),
    ev('2026-10-01T02:00:00.000Z', 'ACCOUNT_OBSERVED', '__account__', { totalValue: 1010, exchange: 'binance' }),
    ev('2026-10-01T03:00:00.000Z', 'SELL_FILLED', 'ETHFDUSD', { profit: 1.23 }),
    ev('2026-10-01T04:00:00.000Z', 'PROFIT_PLACE_ERROR', 'ETHFDUSD', {}),
    ev('2026-10-01T05:00:00.000Z', 'TOPUP_FAILED', 'BTCFDUSD', {}),
  ];
  const result = await run(events, { shards: 1 });
  assert.match(result.title, /健康检查 · 昨天/);
  assert.match(result.summary, /5 条事件/);
  assert.deepEqual(result.warnings, [], '心跳间隔 1h < 2h，不该报停摆');

  const overview = result.sections.find((s) => s.heading === '概览');
  const rows = Object.fromEntries(overview.rows.map((r) => [r[0], r[1]]));
  assert.equal(rows['分片 / 事件'], '1 / 5');
  assert.equal(rows['异常类事件'], '2', 'PROFIT_PLACE_ERROR 与 TOPUP_FAILED 都算异常类');
  assert.equal(rows['最近账户估值'], '1010.00 @binance');

  const errors = result.sections.find((s) => s.heading === '异常事件');
  assert.deepEqual(errors.rows, [['PROFIT_PLACE_ERROR', '1'], ['TOPUP_FAILED', '1']]);
  const symbols = result.sections.find((s) => s.heading === '按 symbol');
  assert.deepEqual(symbols.rows, [['__account__', '2'], ['ETHFDUSD', '2'], ['BTCFDUSD', '1']], '并列时按名字升序（顺序必须确定）');
});

test('心跳缺口超阈值 ⇒ 报"疑似停摆"，并**明确写出**分不清断流还是停机', async () => {
  const gap = HEARTBEAT_GAP_ALERT_MS + 60_000;
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'ACCOUNT_OBSERVED', '__account__', { totalValue: 1 }),
    ev(new Date(Date.parse('2026-10-01T01:00:00.000Z') + gap).toISOString(), 'ACCOUNT_OBSERVED', '__account__', { totalValue: 2 }),
  ];
  const result = await run(events);
  const warning = result.warnings.join('\n');
  assert.match(warning, /ACCOUNT_OBSERVED 最大间隔/);
  assert.match(warning, /疑似停摆\/断流/);
  assert.match(warning, /无法区分"断流"与"进程停机"/, '必须写清数据源的局限，别让人误读成确诊');
});

test('缺天 / 坏行 / 空窗口都必须报出来', async () => {
  const missing = await run([ev('2026-10-01T01:00:00.000Z', 'SELL_FILLED')], { missingDays: ['2026-09-30'], badLines: 3 });
  assert.match(missing.warnings.join('\n'), /缺 1 天的本地数据: 2026-09-30/);
  assert.match(missing.warnings.join('\n'), /3 行无法解析/);

  const empty = await run([]);
  assert.match(empty.summary, /没有事件/);
  assert.match(empty.warnings.join('\n'), /窗口内没有任何事件/);
});

test('没有 ACCOUNT_OBSERVED 但有其它事件 ⇒ 提示"无法用心跳判断停摆"', async () => {
  const result = await run([ev('2026-10-01T01:00:00.000Z', 'SELL_FILLED')]);
  assert.match(result.warnings.join('\n'), /没有 ACCOUNT_OBSERVED/);
});

test('provisional 透传（含未封存分片时结果必须标暂定）', async () => {
  const result = await run([ev('2026-10-01T01:00:00.000Z', 'SELL_FILLED')], { provisional: true });
  assert.equal(result.provisional, true);
});

test('窗口过滤：窗口外的事件不参与统计', async () => {
  const events = [
    ev('2026-09-30T01:00:00.000Z', 'SELL_FILLED'), // 前天，不在"昨天"窗口
    ev('2026-10-01T01:00:00.000Z', 'SELL_FILLED'),
  ];
  const result = await run(events);
  assert.match(result.summary, /1 条事件/);
});
