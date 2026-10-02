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

test('校验失败（坏 gz）→ 不入库、不清水位线、suspects+1、tmp 清理', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: Buffer.from('这不是 gzip') });

  const result = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(result.pulled.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /校验失败|解压/);

  const { state } = loadState(statePathOf(env.config));
  assert.equal(state.objects[key], undefined, '校验不过的分片绝不能进水位线');
  assert.equal(state.suspects[key], 1);
  assert.ok(!fs.existsSync(path.join(env.config.runtime.dataDir, '.tmp', 'boye888', '2026-10-02.jsonl.gz')));

  // 连续失败到 3 次后，后续轮次不再重试（防病态对象拖住每轮）
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  const third = await runSync({ store, config: env.config, logger: env.logger, now: env.now });
  assert.equal(third.failed.length, 0);
  assert.equal(third.skipped, 1, '达到 suspect 上限后应被跳过');
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
  assert.deepEqual(emptyState(), { version: 1, objects: {}, suspects: {}, lastRun: null });
});
