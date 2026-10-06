/**
 * `errors` 与 `stream` 的单测（都在 `src/analysis/`）。
 * 重点：事件分类用**逐个列名**的清单（不是后缀正则）、kind 拼错不能静默、
 * 断流配对（开始/结束/未恢复）与时长算对。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { errorsAnalysis } = require('../../../dist/analysis/errors');
const { streamAnalysis } = require('../../../dist/analysis/stream');
const { ATTENTION_EVENTS, CRITICAL_EVENTS, CONNECTION_EVENTS, STOP_EVENTS, TOPUP_EVENTS, CRASH_EVENTS } = require('../../../dist/analysis/events');
const { parseWindow } = require('../../../dist/common/time');

const NOW = new Date('2026-10-03T12:00:00.000Z');
const ev = (ts, event, data = {}, instance = 'a', symbol = 'ETHFDUSD') => ({ ts, event, symbol, roundId: undefined, data, instance, date: ts.slice(0, 10), lineNo: 2 });

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

const runErrors = async (events, params = {}) =>
  errorsAnalysis().run({ source: fakeSource(events), now: NOW, window: parseWindow(params.window ?? '近7d', NOW), params });
const runStream = async (events, params = {}) =>
  streamAnalysis().run({ source: fakeSource(events), now: NOW, window: parseWindow(params.window ?? '近7d', NOW), params });
const section = (result, prefix) => result.sections.find((s) => s.heading.startsWith(prefix));
const overview = (result) => Object.fromEntries(section(result, '概览').rows.map((r) => [r[0], r[1]]));

test('事件目录：逐个列名（后缀正则会漏的那几个必须在清单里）', () => {
  // ⚠️ `WORKER_WS_STALE_RECONNECT` **故意不算**"需要看"（模板注释：能自愈就不出声），所以不在这里
  for (const name of ['ORDER_EXPIRED', 'ORDER_UNKNOWN_STATUS', 'RESET_RATE_LIMITED', 'RATE_LIMITED', 'SELL_ORDER_LOST', 'SELL_STATE_UNRECONCILED', 'WORKER_TICKER_INVALID', 'HEALTH_CHECK_NO_ORDERS', 'TOPUP_EXHAUSTED', 'RESET_CANCEL_FAILED', 'SELL_STATE_NO_LEDGER_MANUAL']) {
    assert.ok(ATTENTION_EVENTS.includes(name), `${name} 必须算"需要看"（旧的 _ERROR|_FAILED 后缀正则会漏掉它）`);
  }
  assert.ok(CRITICAL_EVENTS.includes('MARKET_STREAM_UNRECOVERED'));
  assert.ok(CRITICAL_EVENTS.includes('SELL_ORDER_LOST'));
});

test('★漂移检查：我引用的事件名必须都在主仓白名单里（本机有 dream_develop 时才跑，否则跳过）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const producer = path.join(__dirname, '..', '..', '..', '..', 'dream_develop', 'src', 'common', 'ossExport.ts');
  if (!fs.existsSync(producer)) return; // 别的机器/CI 没有主仓 ⇒ 跳过，不算失败
  const src = fs.readFileSync(producer, 'utf8');
  const m = /TIMELINE_EVENT_WHITELIST[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
  assert.ok(m, '解析不出主仓白名单（格式变了？）');
  const whitelist = new Set([...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]));
  assert.ok(whitelist.size >= 100, `白名单规模异常：${whitelist.size}`);

  const mine = [...ATTENTION_EVENTS, ...CRITICAL_EVENTS, ...CONNECTION_EVENTS, ...STOP_EVENTS, ...TOPUP_EVENTS, ...CRASH_EVENTS];
  const missing = [...new Set(mine)].filter((name) => !whitelist.has(name));
  assert.deepEqual(missing, [], '这些事件名不在主仓白名单里 ⇒ 永远不会出现在分片里（清单漂移了，改回主仓的真名）');

  // ⚠️ 只查导出数组是不够的：**函数里引用的名字**（配对表/判据）会漏检 ——
  // 真事：`outageEndChannel` 里把 `WORKER_WS_SUBSCRIBED` 当恢复事件，而它**不在白名单**里（永不出现），
  // 结果 worker-ws 的断流只能借下一次 `WS_RECONNECTED` 收尾，造出 9.53h 的假断流时长。
  // ⇒ 直接扫**源码**里出现的所有事件名字面量（去掉注释，免得把说明文字里的引用算进去）。
  const eventsSrc = path.join(__dirname, '..', 'events.ts');
  const code = fs.readFileSync(eventsSrc, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const referenced = new Set(
    [...code.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)].map((x) => x[1])
      .filter((name) => !name.endsWith('_')), // `'UDS_'`/`'MARKET_STREAM_'` 这类是**前缀**（channelOf 用），不是事件名
  );
  const missingInCode = [...referenced].filter((name) => !whitelist.has(name));
  assert.deepEqual(missingInCode, [], '源码里引用了白名单外的事件名（永远不会出现在分片里）—— 要么改回真名，要么明确标注"未导出"');
});

test('errors：只列"需要看"的事件，分档最严重的那批，并能按类别过滤', async () => {
  const events = [
    ev('2026-10-03T01:00:00.000Z', 'PROFIT_PLACE_ERROR', { error: 'balance insufficient' }),
    ev('2026-10-03T02:00:00.000Z', 'SELL_ORDER_LOST', { clientOrderId: 'DS01', reason: 'not found' }),
    ev('2026-10-03T03:00:00.000Z', 'ORDER_FILLED', { orderInfo: {} }), // 正常事件，不该出现
    ev('2026-10-03T04:00:00.000Z', 'WORKER_DEVIATION_RESET', { bidPrice: 1, buy1Price: 1.01 }),
  ];
  const result = await runErrors(events);
  assert.match(result.summary, /2 条需要看的事件（最该立刻看 1 条/); // WORKER_DEVIATION_RESET 是正常换锚机制，不算"需要看"
  const critical = section(result, '最该立刻看');
  assert.equal(critical.rows.length, 1);
  assert.equal(critical.rows[0][3], 'SELL_ORDER_LOST');
  assert.match(critical.rows[0][4], /clientOrderId=DS01/, '关键字段要摘出来');
  assert.match(result.warnings.join('\n'), /最该立刻看/);

  const onlyConn = await runErrors(events, { kind: 'connection' });
  assert.match(onlyConn.summary, /没有需要看的事件/);
});

test('★errors：kind 拼错要告警，不能把拼写错误伪装成"一切正常"', async () => {
  const result = await runErrors([ev('2026-10-03T01:00:00.000Z', 'SELL_ORDER_LOST', {})], { kind: 'conection' });
  assert.match(result.warnings.join('\n'), /不是已知类别/);
  assert.match(result.warnings.join('\n'), /可用：/);
});

test('errors：某类事件刷屏时提示"可能是风暴"', async () => {
  const events = Array.from({ length: 25 }, (_, i) => ev(`2026-10-03T0${String(i % 10)}:${String(i).padStart(2, '0')}:00.000Z`, 'RATE_LIMITED', {}));
  const result = await runErrors(events);
  assert.match(result.warnings.join('\n'), /超过 20 次/);
});

test('stream：断流配对——开始/恢复/时长，未恢复的算到参考时刻并标出', async () => {
  const events = [
    // 实例 a：断 30 分钟
    ev('2026-10-03T01:00:00.000Z', 'UDS_CONN_CLOSED', { code: 1006 }, 'a'),
    ev('2026-10-03T01:30:00.000Z', 'UDS_RETRY_OK', { retryCount: 2 }, 'a'),
    // 实例 b：窗口结束时仍未恢复（断在 11:00，参考时刻 = 12:00 ⇒ 1h）
    ev('2026-10-03T11:00:00.000Z', 'UDS_CONN_CLOSED_STALE', {}, 'b'),
    // 连续的断开事件不能重复计时
    ev('2026-10-03T11:05:00.000Z', 'UDS_CONN_UNAVAILABLE', {}, 'b'),
  ];
  const result = await runStream(events);
  const o = overview(result);
  assert.equal(o['断开次数'], '2', '连续断开只算一次');
  assert.match(o['累计断流'], /1\.50h/, '0.5h + 1h = 1.5h');
  assert.match(o['窗口结束时仍在断流'], /是（b）/);
  assert.match(result.warnings.join('\n'), /仍有 1 个实例处于断流/);

  const timeline = section(result, '断开时间线');
  const b = timeline.rows.find((r) => r[0] === 'b');
  assert.equal(b[2], '窗口结束时仍未恢复');
  assert.match(b[4], /UDS_CONN_CLOSED_STALE → （未恢复）/);
});

test('stream：未恢复/连续失败告警要单独点名；UDS_CONN_ERROR 不算断流（避免时长虚高）', async () => {
  const events = [
    ev('2026-10-03T01:00:00.000Z', 'UDS_CONN_ERROR', { error: 'socket hang up' }, 'a'), // 只是报错
    ev('2026-10-03T02:00:00.000Z', 'MARKET_STREAM_UNRECOVERED', { downtimeSec: 900, attempts: 5 }, 'a'),
    ev('2026-10-03T03:00:00.000Z', 'UDS_RETRY_FAIL_ALERT', { retryCount: 7 }, 'a'),
  ];
  const result = await runStream(events);
  const o = overview(result);
  assert.equal(o['断开次数'], '1', 'MARKET_STREAM_UNRECOVERED 是行情流断流的权威起点（算 1 次）；UDS_CONN_ERROR 不算断开');
  assert.equal(o['未恢复告警 / 连续失败告警'], '1 / 1');
  assert.match(result.warnings.join('\n'), /未恢复\/连续失败/);
});

test('stream：整个窗口没有连接类事件时要明说（白名单里本该有）', async () => {
  const result = await runStream([ev('2026-10-03T01:00:00.000Z', 'BUY_FILLED', {})]);
  assert.match(result.summary, /没有连接类事件/);
  assert.match(result.warnings.join('\n'), /白名单里它们本该在/);
});
