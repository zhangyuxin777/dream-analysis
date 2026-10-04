/**
 * 拉取器端到端单测（`src/sync/puller.ts`）—— 假 ObjectStore + 真临时目录 + 真 gz 分片。
 * 这里验的是整条链：列举 → 计划 → 下载 → 校验 → 原子入库 → 水位线 → 淘汰。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { runSync, statePathOf, shardPathOf } = require('../../../dist/sync/puller');
const { loadState, emptyState } = require('../../../dist/sync/state');
const { parseConfig } = require('../../../dist/config/index');
const { createLogger } = require('../../../dist/common/logger');

const NOW = new Date('2026-10-03T04:00:00.000Z'); // 对应北京时间 10-03 12:00

/** 造一个真的天分片（gzip） */
function shardBuffer(instance, date, events, headerOver = {}) {
  const header = JSON.stringify({
    type: 'meta', schema: 1, instance, date, final: true, count: events.length,
    firstTs: events[0]?.ts, lastTs: events[events.length - 1]?.ts, ...headerOver,
  });
  const lines = [header, ...events.map((e) => JSON.stringify(e))];
  return zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
}

const ev = (ts, event, symbol = 'ETH') => ({ ts, event, symbol, localDate: ts.slice(0, 10), seq: 1 });
const okEvents = [ev('2026-10-02T01:00:00.000Z', 'NEW_ROUND'), ev('2026-10-02T02:00:00.000Z', 'BUY_FILLED'), ev('2026-10-02T03:00:00.000Z', 'SELL_FILLED')];

class FakeStore {
  constructor(contents, extras = []) {
    this.contents = contents; // key → Buffer
    this.metas = Object.keys(contents).map((key, i) => this.metaOf(key, `E${i + 1}`)).concat(extras);
    this.downloads = [];
    this.listCalls = 0;
  }
  metaOf(key, etag, ageHours = 5, size = null) {
    return { key, etag, size: size ?? this.contents[key]?.length ?? 0, lastModified: '', lastModifiedMs: NOW.getTime() - ageHours * 3600_000 };
  }
  async list(prefix) {
    this.listCalls++;
    return this.metas.filter((m) => m.key.startsWith(prefix));
  }
  async getTo(key, dest) {
    this.downloads.push(key);
    const buf = this.contents[key];
    if (!buf) throw new Error(`fake store 没有 ${key}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
}

function makeEnv() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puller-test-'));
  const { config } = parseConfig(
    {
      name: 'analysis',
      oss: { provider: 'ossutil', binary: 'ossutil', endpoint: 'oss-cn-hongkong.aliyuncs.com', bucket: 'dream-ana', prefix: 'snapshot/', configFile: '' },
      sync: { intervalMinutes: 60, minAgeSeconds: 60, countIncludesHeader: false, maxDiskGB: 1, retentionDays: 90, concurrency: 1 },
      runtime: { dataDir: 'data', stateDir: 'runtime', logDir: 'logs' },
    },
    { rootDir },
  );
  const logger = createLogger({ level: 'error', sink: () => undefined });
  return { rootDir, config, logger, now: () => NOW };
}

test('首次同步：拉取 2 份并入库，水位线写对，文件落到 data/<instance>/<date>.jsonl.gz', async () => {
  const env = makeEnv();
  const keyA = 'snapshot/boye888/2026-10-01.jsonl.gz';
  const keyB = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({
    [keyA]: shardBuffer('boye888', '2026-10-01', okEvents),
    [keyB]: shardBuffer('boye888', '2026-10-02', okEvents),
  });

  const result = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(result.pulled.sort(), [keyA, keyB]);
  assert.equal(result.failed.length, 0);
  assert.ok(fs.existsSync(shardPathOf(env.config, 'boye888', '2026-10-02')));

  const { state } = loadState(statePathOf(env.config));
  assert.equal(state.objects[keyB].dataLines, 3);
  assert.equal(state.objects[keyB].final, true);
  assert.equal(state.lastRun.pulled, 2);
  assert.deepEqual(state.suspects, {});
  assert.ok(!fs.existsSync(path.join(env.config.runtime.dataDir, '.tmp', 'boye888', '2026-10-02.jsonl.gz')), 'tmp 必须被 rename 走');
});

test('第二次同步：ETag 未变 → 全部跳过，不产生任何下载', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: shardBuffer('boye888', '2026-10-02', okEvents) });

  await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  store.downloads.length = 0;
  const second = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(second.pulled.length, 0);
  assert.equal(second.skipped, 1);
  assert.deepEqual(store.downloads, [], 'ETag 相同绝不该再下载');
});

test('上传侧重算覆盖（ETag 变）→ 整份重建，行数按新内容更新', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: shardBuffer('boye888', '2026-10-02', okEvents) });
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });

  // 上传侧重算：内容变多，ETag 变化（final 仍 false —— 当天未封存）
  const more = [...okEvents, ev('2026-10-02T04:00:00.000Z', 'TOPUP_PLACED')];
  store.contents[key] = shardBuffer('boye888', '2026-10-02', more, { final: false });
  store.metas = [store.metaOf(key, 'E-CHANGED', 5, store.contents[key].length)];

  const result = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(result.pulled, [key]);
  assert.deepEqual(result.recomputed, [key]);

  const { state } = loadState(statePathOf(env.config));
  assert.equal(state.objects[key].dataLines, 4, '必须整份重建（不是把新行追加到旧计数上）');
  assert.equal(state.objects[key].final, false);
});

test('校验失败（坏 gz）→ 不入库、不清水位线、suspects 记录内容指纹、tmp 清理', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: Buffer.from('这不是 gzip') });

  const result = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(result.pulled.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /校验失败|解压/);

  const { state } = loadState(statePathOf(env.config));
  assert.equal(state.objects[key], undefined, '校验不过的分片绝不能进水位线');
  assert.equal(state.suspects[key].count, 1);
  assert.equal(state.suspects[key].etag, store.metas[0].etag, '失败记录必须带内容指纹（否则无法判断"内容变了该重试"）');
  assert.ok(!fs.existsSync(path.join(env.config.runtime.dataDir, '.tmp', 'boye888', '2026-10-02.jsonl.gz')));
});

test('失败是**退避**不是拉黑：同内容按 30min×2^n 推迟，且 deferred 可见；时间到了继续重试', async () => {
  const env = makeEnv();
  let clock = new Date(NOW.getTime());
  const now = () => clock;
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: Buffer.from('坏数据') });
  const deps = { store, config: env.config, logger: env.logger, now };

  clock = new Date(clock.getTime() + 10 * 60_000);
  assert.equal((await runSync(deps)).failed.length, 1, '第 1 次失败');

  // 冷却期（count=1 ⇒ 30min）内：不再重试，但必须明确报出来
  clock = new Date(clock.getTime() + 5 * 60_000);
  const deferredRun = await runSync(deps);
  assert.equal(deferredRun.failed.length, 0, '冷却期内不该再尝试');
  assert.equal(deferredRun.deferred.length, 1, '被推迟的分片必须可见（静默推迟 = 静默停同步）');
  assert.equal(deferredRun.deferred[0].count, 1);
  assert.ok(deferredRun.deferred[0].retryAfterMs > 0);

  // 冷却过后继续重试（不会永久停在这一天）
  clock = new Date(clock.getTime() + 31 * 60_000);
  assert.equal((await runSync(deps)).failed.length, 1, '冷却过后必须继续重试');

  const { state } = loadState(statePathOf(env.config));
  assert.equal(state.suspects[key].count, 2, '失败次数累加（用于指数退避与告警）');
});

test('失败后上传侧修好了（ETag 变）⇒ 立刻重试，不受冷却限制', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: Buffer.from('坏数据') });
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(loadState(statePathOf(env.config)).state.suspects[key].count, 1);

  // 上传侧重算：内容换成合法分片，ETag 随之变化
  store.contents[key] = shardBuffer('boye888', '2026-10-02', okEvents);
  store.metas = [store.metaOf(key, 'E-FIXED', 5, store.contents[key].length)];

  const result = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(result.pulled, [key], '内容变了就该立刻给一次机会');
  assert.deepEqual(loadState(statePathOf(env.config)).state.suspects, {}, '成功后必须清掉失败记录');
});

test('跨进程互斥：锁被别的进程持有 → 本轮整体拒绝（不排队、不互相踩 tmp/状态文件）', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: shardBuffer('boye888', '2026-10-02', okEvents) });

  const { acquireLock, releaseLock } = require('../../../dist/sync/lock');
  const { lockPathOf } = require('../../../dist/sync/puller');
  const lockPath = lockPathOf(env.config);
  const held = acquireLock(lockPath, { now: NOW, staleMs: 30 * 60_000, token: 'other-process' });
  assert.equal(held.ok, true);

  const refused = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(refused.refusedByLock, true);
  assert.equal(refused.listed, 0);
  assert.deepEqual(store.downloads, [], '拒绝时必须什么都没拉');

  releaseLock(lockPath, 'other-process');
  const ok = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(ok.refusedByLock, false);
  assert.deepEqual(ok.pulled, [key]);
  assert.ok(!fs.existsSync(lockPath), '跑完必须释放锁（否则下一轮永远拿不到）');
});

test('口径版本会落盘（跨轮比较的基准）；只有一份时不该报"变更"', async () => {
  const env = makeEnv();
  const day1 = 'snapshot/boye888/2026-09-30.jsonl.gz';
  const store = new FakeStore({ [day1]: shardBuffer('boye888', '2026-09-30', okEvents, { whitelistVersion: 'v1' }) });

  const first = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(first.whitelistChanges, [], '只有一份时无从比较，不该报变更');

  const { state } = loadState(statePathOf(env.config));
  assert.equal(state.objects[day1].whitelistVersion, 'v1', '口径要落盘（否则跨天比较没有基准）');
});

test('口径变更在**跨轮**时被识别出来（先拉 v1，再拉到 v2）', async () => {
  const env = makeEnv();
  const day1 = 'snapshot/boye888/2026-09-30.jsonl.gz';
  const day2 = 'snapshot/boye888/2026-10-01.jsonl.gz';
  const store = new FakeStore({ [day1]: shardBuffer('boye888', '2026-09-30', okEvents, { whitelistVersion: 'v1' }) });
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });

  store.contents[day2] = shardBuffer('boye888', '2026-10-01', okEvents, { whitelistVersion: 'v2' });
  store.metas = [store.metaOf(day1, 'E1', 5), store.metaOf(day2, 'E2', 5)];

  const second = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(second.whitelistChanges.length, 1);
  assert.match(second.whitelistChanges[0], /v1 → v2/);
  assert.match(second.whitelistChanges[0], /前一天/, '跨天变更要以"前一天"为基准');
  assert.equal(loadState(statePathOf(env.config)).state.lastRun.whitelistChanges.length, 1, '口径变更必须进 lastRun（status/告警能看到）');
});

test('同一分片被重算且口径变了 → 也要报（这是最直接的变更信号）', async () => {
  const env = makeEnv();
  const day = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [day]: shardBuffer('boye888', '2026-10-02', okEvents, { whitelistVersion: 'v1' }) });
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });

  store.contents[day] = shardBuffer('boye888', '2026-10-02', okEvents, { whitelistVersion: 'v2' });
  store.metas = [store.metaOf(day, 'E-CHANGED', 5)];

  const second = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(second.whitelistChanges.length, 1);
  assert.match(second.whitelistChanges[0], /同一分片/);
});

test('回填一个更早的日期**不该**报假口径变更（基准必须是"同分片/前一天"，不能是"最新的另一份"）', async () => {
  const env = makeEnv();
  const recent = 'snapshot/boye888/2026-10-01.jsonl.gz';
  const backfill = 'snapshot/boye888/2026-09-20.jsonl.gz';
  const store = new FakeStore({ [recent]: shardBuffer('boye888', '2026-10-01', okEvents, { whitelistVersion: 'v2' }) });
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });

  store.contents[backfill] = shardBuffer('boye888', '2026-09-20', okEvents, { whitelistVersion: 'v1' });
  store.metas = [store.metaOf(recent, 'E1', 5), store.metaOf(backfill, 'E2', 5)];

  const second = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(second.whitelistChanges, [], '回填旧日期不该凭空报出"口径变更"');
});

test('契约外对象被忽略（不下载、计入 ignored）', async () => {
  const env = makeEnv();
  const good = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [good]: shardBuffer('boye888', '2026-10-02', okEvents) }, [
    { key: 'snapshot/.keep', etag: 'K', size: 63, lastModified: '', lastModifiedMs: NOW.getTime() - 5 * 3600_000 },
    { key: 'snapshot/boye888/2026-10-02.jsonl.gz.1', etag: 'R', size: 1, lastModified: '', lastModifiedMs: NOW.getTime() - 5 * 3600_000 },
  ]);

  const result = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(result.pulled, [good]);
  assert.equal(result.ignored, 2);
  assert.deepEqual(store.downloads, [good], '非法键绝不能被下载');
});

test('淘汰：保留期外的本地分片被删，同时清掉水位线条目', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: shardBuffer('boye888', '2026-10-02', okEvents) });
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });

  // 手工塞一份 2020 年的旧分片
  const old = shardPathOf(env.config, 'boye888', '2020-01-01');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, shardBuffer('boye888', '2020-01-01', okEvents));

  const result = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(result.pruned.map((p) => path.basename(p)), ['2020-01-01.jsonl.gz']);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(shardPathOf(env.config, 'boye888', '2026-10-02')), '新分片必须留着');
});

test('★淘汰之后不许再重拉：老对象仍在桶里，但本地已按保留期淘汰 ⇒ 必须一直 skip（否则每小时"拉了又删"）', async () => {
  const env = makeEnv();
  const oldKey = 'snapshot/boye888/2020-01-01.jsonl.gz';
  const newKey = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({
    [oldKey]: shardBuffer('boye888', '2020-01-01', okEvents),
    [newKey]: shardBuffer('boye888', '2026-10-02', okEvents),
  });

  // ① 首次：保留期放宽，两份都拉下来
  env.config.sync.retentionDays = 3650;
  const first = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(first.pulled.length, 2);

  // ② 保留期收紧到 1 天：2020 那份被淘汰（文件 + 水位线都没了）
  env.config.sync.retentionDays = 1;
  const second = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(second.pruned.map((p) => path.basename(p)), ['2020-01-01.jsonl.gz']);
  assert.ok(!fs.existsSync(shardPathOf(env.config, 'boye888', '2020-01-01')));

  // ③ 关键：再同步一轮，**不许**因为"水位线被删了"就把它重新下载一遍
  //    （真数据里桶不会清理老对象，所以这会变成每小时 55MB 的无限拉删循环）
  const downloadsBefore = store.downloads.length;
  const third = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(third.pulled, [], '被淘汰的对象不许重拉');
  assert.equal(store.downloads.length, downloadsBefore, '一次下载都不该发生');
  assert.equal(third.skipped, 2, '两份都该是 skip（老的那份理由 = pruned）');
});

test('★淘汰墓碑：ETag 变了（上传侧重算/补数）仍然要重拉 —— 但每次只多下一次，不进循环', async () => {
  const env = makeEnv();
  const oldKey = 'snapshot/boye888/2020-01-01.jsonl.gz';
  const newKey = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({
    [oldKey]: shardBuffer('boye888', '2020-01-01', okEvents),
    [newKey]: shardBuffer('boye888', '2026-10-02', okEvents),
  });

  env.config.sync.retentionDays = 3650;
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });

  env.config.sync.retentionDays = 2; // 只淘汰 2020 那份（10-02 留着，兜住"至少留一份"底线）
  const prunedRun = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(prunedRun.pruned.map((p) => path.basename(p)), ['2020-01-01.jsonl.gz'], '前提：这一轮真的写了墓碑');
  assert.equal(loadState(statePathOf(env.config)).state.pruned[oldKey].etag, 'E1');

  // 同 ETag：不许重拉
  assert.deepEqual((await runSync({ store, config: env.config, logger: env.logger, now: env.now })).pulled, []);

  // 上传侧补数/重算这一天（ETag 变了）⇒ 必须重新拉一次，不能因为"以前淘汰过"就永远忽略
  store.metas.find((m) => m.key === oldKey).etag = 'E-CHANGED';
  const after = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(after.pulled, [oldKey], '墓碑不能变成永久拉黑');
  assert.match(after.recomputed.join(), /2020-01-01/, '要能被识别成"远端已变"');
  // 同一轮里它又被淘汰了，墓碑换成新 ETag ⇒ 下一轮恢复 skip（不会每轮都下）
  assert.deepEqual(after.pruned.map((p) => path.basename(p)), ['2020-01-01.jsonl.gz']);
  assert.equal(loadState(statePathOf(env.config)).state.pruned[oldKey].etag, 'E-CHANGED');
  assert.deepEqual((await runSync({ store, config: env.config, logger: env.logger, now: env.now })).pulled, [], '不会进循环');
});

test('★P5 Critical：淘汰时没有水位线（状态文件丢过）⇒ 墓碑 ETag 为空，也必须挡住重拉', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2020-01-01.jsonl.gz';
  const store = new FakeStore({}); // 远端此刻没有这个对象（模拟"状态丢了、远端也查不到"）
  env.config.sync.retentionDays = 2; // 2 天：2020 那份该淘汰，10-02 那份留着（"至少留一份"的底线不能兜住它）
  for (const [inst, date] of [['boye888', '2020-01-01'], ['boye888', '2026-10-02']]) {
    const p = shardPathOf(env.config, inst, date);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, shardBuffer(inst, date, okEvents));
  }

  const first = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(first.pruned.map((x) => path.basename(x)), ['2020-01-01.jsonl.gz']);
  assert.equal(loadState(statePathOf(env.config)).state.pruned[key].etag, '', '淘汰时没有水位线 ⇒ 墓碑 ETag 为空');

  // 远端对象后来出现了（又被上传/重算过）：**不许**重新下载再淘汰
  store.contents[key] = shardBuffer('boye888', '2020-01-01', okEvents);
  store.metas.push(store.metaOf(key, 'E-NEW'));
  const second = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.deepEqual(second.pulled, [], '空 ETag 的墓碑也必须挡住重拉（否则就是"拉了又删"的循环）');
  assert.equal(second.skipped, 1);
});

test('状态文件损坏时不崩：按空状态重拉，并带 warning 返回', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: shardBuffer('boye888', '2026-10-02', okEvents) });
  fs.mkdirSync(env.config.runtime.stateDir, { recursive: true });
  fs.writeFileSync(statePathOf(env.config), '{ 坏掉的 json');

  const result = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(result.pulled.length, 1);
  assert.ok(result.warnings.some((w) => w.includes('状态文件')));
  assert.equal(loadState(statePathOf(env.config)).state.objects[key].dataLines, 3);
});

test('空状态对象的形状（供调用方断言用）', () => {
  assert.deepEqual(emptyState(), { version: 1, objects: {}, suspects: {}, pruned: {}, lastRun: null });
});
