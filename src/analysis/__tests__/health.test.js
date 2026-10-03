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
      return {
        shards: opts.shards ?? 1,
        events: n,
        badLines: opts.badLines ?? 0,
        missingDays: opts.missingDays ?? [],
        provisional: opts.provisional ?? false,
        failedShards: opts.failedShards ?? [],
        shardWarnings: opts.shardWarnings ?? [],
      };
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

test('心跳按实例分开统计：一个实例停摆不会被另一个实例的正常心跳抵消', async () => {
  const hour = 3_600_000;
  const t0 = Date.parse('2026-10-01T01:00:00.000Z');
  const events = [
    // 实例 a 正常：每小时一次
    ...[0, 1, 2].map((i) => ({ ...ev(new Date(t0 + i * hour).toISOString(), 'ACCOUNT_OBSERVED', '__account__', { totalValue: 100 + i, exchange: 'binance' }), instance: 'a' })),
    // 实例 b 中间断了 5 小时
    { ...ev(new Date(t0).toISOString(), 'ACCOUNT_OBSERVED', '__account__', { totalValue: 200, exchange: 'binance' }), instance: 'b' },
    { ...ev(new Date(t0 + 5 * hour).toISOString(), 'ACCOUNT_OBSERVED', '__account__', { totalValue: 201, exchange: 'binance' }), instance: 'b' },
  ];
  const result = await run(events);
  const heartbeat = result.sections.find((s) => s.heading === '心跳（按实例）');
  assert.deepEqual(heartbeat.rows.map((r) => r[0]).sort(), ['a', 'b']);
  const rowB = heartbeat.rows.find((r) => r[0] === 'b');
  assert.equal(rowB[2], '300min', '实例 b 的最大间隔必须是 5 小时（不是被实例 a 的心跳抹平）');

  const warning = result.warnings.join('\n');
  assert.match(warning, /ACCOUNT_OBSERVED 最大间隔 5\.0h（实例 b/);
  assert.match(warning, /2 个实例在发心跳/);
  // "最近账户估值"取最新那条心跳（实例 b 的 201），而不是扫描顺序里最后一条
  const overview = Object.fromEntries(result.sections.find((s) => s.heading === '概览').rows.map((r) => [r[0], r[1]]));
  assert.equal(overview['最近账户估值'], '201.00 @binance');
});

test('分片读不出来 / 分片带数据告警：必须报出来（不许当成"这天没事件"）', async () => {
  const result = await run([ev('2026-10-01T01:00:00.000Z', 'SELL_FILLED')], {
    failedShards: [{ key: 'snapshot/a/2026-09-30.jsonl.gz', errors: ['gzip 解压失败：invalid header'] }],
    shardWarnings: [{ key: 'snapshot/a/2026-10-01.jsonl.gz', warnings: ['行数不符：header.count=10 实际数据行=8'] }],
  });
  const warning = result.warnings.join('\n');
  assert.match(warning, /1 个分片\*\*读不出来\*\*/);
  assert.match(warning, /gzip 解压失败/);
  assert.match(warning, /统计可能不完整/);
  assert.match(warning, /1 个分片带数据告警/);
  assert.match(warning, /行数不符/);
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

test('配置回显只在展示层折叠：Top-N 让给业务事件，回显合并成一行（原始行不动）', async () => {
  const events = [
    ev('2026-10-01T01:00:00.000Z', 'ORDER_FILLED'),
    ev('2026-10-01T02:00:00.000Z', 'ORDER_CANCELED'),
    ...Array.from({ length: 8 }, (_, i) => ev(`2026-10-01T0${i + 3}:00:00.000Z`, 'WORKER_CONFIG_DEVIATION')),
    ev('2026-10-01T11:00:00.000Z', 'WORKER_ENV_PRODUCTION'),
  ];
  const result = await run(events);
  const top = result.sections.find((s) => s.heading.startsWith('事件 Top'));
  const names = top.rows.map((r) => r[0]);

  assert.ok(names.includes('ORDER_FILLED'), '业务事件必须在：' + JSON.stringify(top.rows));
  assert.ok(!names.includes('WORKER_CONFIG_DEVIATION'), '回显类不该单独占 Top-N 名额');
  assert.ok(!names.includes('WORKER_ENV_PRODUCTION'), 'WORKER_ENV_* 同样折叠');

  const folded = top.rows.find((r) => r[0].includes('配置回显'));
  assert.ok(folded, '必须有折叠汇总行：' + JSON.stringify(top.rows));
  assert.equal(folded[1], '9', '8 条 WORKER_CONFIG_* + 1 条 WORKER_ENV_*');
  assert.match(folded[0], /2 类共 9 条/);
  assert.match(top.note, /原始行仍在分片里/, '必须说明只是展示折叠，数据一行没少');

  // 折叠不影响任何计数：总事件数 / 异常数 / symbol 分布都照旧
  const overview = Object.fromEntries(result.sections.find((s) => s.heading === '概览').rows.map((r) => [r[0], r[1]]));
  assert.equal(overview['分片 / 事件'], '1 / 11');
});

test('全是回显事件时，折叠行也要能看（不能让 Top-N 空着让人以为没数据）', async () => {
  const events = Array.from({ length: 5 }, (_, i) => ev(`2026-10-01T0${i + 1}:00:00.000Z`, 'WORKER_CONFIG_DEVIATION'));
  const result = await run(events);
  const top = result.sections.find((s) => s.heading.startsWith('事件 Top'));
  assert.equal(top.rows.length, 1);
  assert.match(top.rows[0][0], /配置回显/);
  assert.equal(top.rows[0][1], '5');
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
