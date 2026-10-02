/**
 * 本地事件源单测（`src/store/eventSource.ts`）—— 真 gz 分片 + 真水位线对象 + 临时目录。
 * 这里验的是"分析器看到的世界"：窗口过滤、币种短名、实例过滤、缺天如实上报、未封存标记。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { LocalEventSource, matchSymbol } = require('../../../dist/store/eventSource');
const { parseWindow } = require('../../../dist/common/time');
const { emptyState } = require('../../../dist/sync/state');

const PREFIX = 'snapshot/';
const NOW = new Date('2026-10-02T12:00:00.000Z'); // 北京时间 10-02 20:00

const ev = (ts, event, symbol = 'ETHFDUSD', data = {}, roundId) => ({ ts, event, symbol, roundId, localDate: ts.slice(0, 10), seq: 1, data });

function writeShard(dataDir, instance, date, events, headerOver = {}) {
  const dir = path.join(dataDir, instance);
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'meta', schema: 2, instance, date, final: true, count: events.length, ...headerOver });
  const body = [header, ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${date}.jsonl.gz`), zlib.gzipSync(Buffer.from(body, 'utf8')));
}

/** 造一个"同步过两天"的环境：10-01（已封存）+ 10-02（未封存） */
function makeEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventsource-'));
  const state = emptyState();
  const day1 = [ev('2026-10-01T01:00:00.000Z', 'NEW_ROUND'), ev('2026-10-01T02:00:00.000Z', 'SELL_FILLED', 'BTCFDUSD')];
  const day2 = [ev('2026-10-02T01:00:00.000Z', 'BUY_FILLED'), ev('2026-10-02T02:00:00.000Z', 'SELL_FILLED')];
  writeShard(dataDir, 'boye888', '2026-10-01', day1, { final: true });
  writeShard(dataDir, 'boye888', '2026-10-02', day2, { final: false });
  state.objects[`${PREFIX}boye888/2026-10-01.jsonl.gz`] = { etag: 'E1', size: 1, dataLines: day1.length, final: true, pulledAt: 'x', warnings: [] };
  state.objects[`${PREFIX}boye888/2026-10-02.jsonl.gz`] = { etag: 'E2', size: 1, dataLines: day2.length, final: false, pulledAt: 'x', warnings: ['行数不符'] };
  return { dataDir, state };
}

test('shards/instances/availableDays：只认磁盘上真实存在的分片，并带上 final 与告警', () => {
  const env = makeEnv();
  const src = new LocalEventSource({ dataDir: env.dataDir, prefix: PREFIX, state: env.state });
  assert.deepEqual(src.instances(), ['boye888']);
  assert.deepEqual(src.availableDays(), ['2026-10-01', '2026-10-02']);

  const shards = src.shards();
  assert.equal(shards.length, 2);
  assert.equal(shards[0].final, true);
  assert.equal(shards[1].final, false);
  assert.deepEqual(shards[1].warnings, ['行数不符']);

  // 水位线说有一天、磁盘上没有（被手工删了）⇒ 当作"没有这一天"，不许假装有
  const falsy = { ...env.state, objects: { ...env.state.objects, [`${PREFIX}boye888/2026-09-30.jsonl.gz`]: { etag: 'E0', size: 1, dataLines: 1, final: true, pulledAt: 'x', warnings: [] } } };
  const src2 = new LocalEventSource({ dataDir: env.dataDir, prefix: PREFIX, state: falsy });
  assert.deepEqual(src2.availableDays(), ['2026-10-01', '2026-10-02']);
});

test('scan：按窗口过滤事件（昨天 = 完整的 10-01 本地日）', async () => {
  const env = makeEnv();
  const src = new LocalEventSource({ dataDir: env.dataDir, prefix: PREFIX, state: env.state });
  const seen = [];
  const stats = await src.scan({ window: parseWindow('昨天', NOW) }, (e) => seen.push(`${e.date}/${e.event}`));

  assert.deepEqual(seen, ['2026-10-01/NEW_ROUND', '2026-10-01/SELL_FILLED']);
  assert.equal(stats.events, 2);
  assert.equal(stats.shards, 1);
  assert.deepEqual(stats.missingDays, [], '窗口只有 10-01，且本地有它');
  assert.equal(stats.provisional, false, '10-01 是已封存的');
});

test('scan：窗口覆盖两天时，未封存的那天会把 provisional 打开，并带上实例/日期/行号', async () => {
  const env = makeEnv();
  const src = new LocalEventSource({ dataDir: env.dataDir, prefix: PREFIX, state: env.state });
  const seen = [];
  const stats = await src.scan({ window: parseWindow('2026-10-01~2026-10-02', NOW) }, (e) => seen.push(e));

  assert.equal(stats.shards, 2);
  assert.equal(stats.events, 4);
  assert.equal(stats.provisional, true);
  assert.equal(seen[0].instance, 'boye888');
  assert.equal(seen[0].date, '2026-10-01');
  assert.ok(seen[0].lineNo >= 2, '行号应指向文件里的真实行（header 是第 1 行）');
});

test('scan：币种短名匹配（eth → ETHFDUSD），不匹配的不进回调', async () => {
  const env = makeEnv();
  const src = new LocalEventSource({ dataDir: env.dataDir, prefix: PREFIX, state: env.state });
  const eth = [];
  await src.scan({ window: parseWindow('2026-10-01~2026-10-02', NOW), symbol: 'eth' }, (e) => eth.push(e.symbol));
  // 10-01：NEW_ROUND(ETH) + SELL_FILLED(BTC，必须被排除)；10-02：BUY_FILLED(ETH) + SELL_FILLED(ETH)
  assert.deepEqual(eth, ['ETHFDUSD', 'ETHFDUSD', 'ETHFDUSD']);

  const btc = [];
  await src.scan({ window: parseWindow('2026-10-01~2026-10-02', NOW), symbol: 'btc' }, (e) => btc.push(e.symbol));
  assert.deepEqual(btc, ['BTCFDUSD']);
});

test('scan：实例过滤；窗口里本地没有的天进 missingDays（如实上报，不许静默）', async () => {
  const env = makeEnv();
  const src = new LocalEventSource({ dataDir: env.dataDir, prefix: PREFIX, state: env.state });

  const none = [];
  await src.scan({ window: parseWindow('昨天', NOW), instance: 'other-instance' }, (e) => none.push(e));
  assert.deepEqual(none, []);

  const stats = await src.scan({ window: parseWindow('2026-09-28~2026-10-02', NOW) }, () => undefined);
  assert.deepEqual(stats.missingDays, ['2026-09-28', '2026-09-29', '2026-09-30']);
});

test('matchSymbol：精确与短名都认，空过滤=全要，无 symbol 的不匹配', () => {
  assert.equal(matchSymbol('ETHFDUSD', 'eth'), true);
  assert.equal(matchSymbol('ETHFDUSD', 'ETHFDUSD'), true);
  assert.equal(matchSymbol('ETHFDUSD', 'btc'), false);
  assert.equal(matchSymbol('ETHFDUSD', ''), true);
  assert.equal(matchSymbol(undefined, 'eth'), false);
  assert.equal(matchSymbol('__account__', 'eth'), false);
});

test('分片存在但读不出来：进 failedShards、不算"已覆盖"，那天仍算缺数据（不许静默当成 0 事件）', async () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.dataDir, 'boye888', '2026-10-02.jsonl.gz'), Buffer.from('这不是 gzip', 'utf8'));
  const src = new LocalEventSource({ dataDir: env.dataDir, prefix: PREFIX, state: env.state });

  const stats = await src.scan({ window: parseWindow('2026-10-02', NOW) }, () => undefined);
  assert.equal(stats.shards, 0, '读失败不能算成"扫过了一个分片"');
  assert.equal(stats.failedShards.length, 1);
  assert.match(stats.failedShards[0].errors.join(' '), /gzip 解压失败/);
  assert.deepEqual(stats.missingDays, ['2026-10-02'], '读不出来的那天也要算缺数据');
});

test('分片级告警（同步时校验出来的行数不符等）必须带进分析结果', async () => {
  const env = makeEnv(); // 10-02 的水位线条目里带着 warnings: ['行数不符']
  const src = new LocalEventSource({ dataDir: env.dataDir, prefix: PREFIX, state: env.state });

  const stats = await src.scan({ window: parseWindow('2026-10-02', NOW) }, () => undefined);
  assert.equal(stats.shards, 1);
  assert.equal(stats.shardWarnings.length, 1);
  assert.match(stats.shardWarnings[0].warnings.join(' '), /行数不符/);
  assert.equal(stats.provisional, true, '未封存的分片同时要把 provisional 打开');
});
