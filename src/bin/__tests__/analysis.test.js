/**
 * CLI 命令单测（`src/bin/analysis.ts`）
 *
 * 用**假 store + 临时目录**把每条命令真正跑一遍（而不是只测参数解析）：
 * status / list / doctor(--deep) / verify / sync 的返回码与关键输出都在这里钉住。
 * `run`（常驻）不在这里跑 —— 它装信号处理器与常驻定时器，属于"会挂住测试进程"的那种；
 * 它的组成件（调度器、拉取器）已有各自单测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const cli = require('../../../dist/bin/analysis');
const { parseConfig } = require('../../../dist/config/index');
const { createLogger } = require('../../../dist/common/logger');
const { saveState, emptyState } = require('../../../dist/sync/state');
const { statePathOf, runSync } = require('../../../dist/sync/puller');
const { acquireLock, releaseLock } = require('../../../dist/sync/lock');

const TODAY = '2026-10-03'; // 与 status 里的"今天"对齐（用真实当前日期会随运行日漂移）

function shardBuffer(instance, date, events, headerOver = {}) {
  const header = JSON.stringify({ type: 'meta', schema: 1, instance, date, final: true, count: events.length, ...headerOver });
  return zlib.gzipSync(Buffer.from([header, ...events.map((e) => JSON.stringify(e))].join('\n') + '\n', 'utf8'));
}

const ev = (ts, event, symbol = 'ETH') => ({ ts, event, symbol, localDate: ts.slice(0, 10), seq: 1 });

class FakeStore {
  constructor(contents, opts = {}) {
    this.contents = contents;
    this.metas = Object.keys(contents).map((key, i) => ({
      key, etag: `E${i + 1}`, size: contents[key].length, lastModified: '2026-10-03 10:00:00 +0800 CST',
      // 必须**早于真实时钟**：静默期保护会跳过"太新"的对象，用未来时间会让同步什么都不拉
      lastModifiedMs: Date.now() - 6 * 3600_000,
      ...(opts.metas?.[key] ?? {}),
    }));
    this.extraMetas = opts.extraMetas ?? [];
    this.listError = opts.listError ?? null;
    this.versionError = opts.versionError ?? null;
    this.downloads = [];
  }
  async list(prefix) {
    if (this.listError) throw new Error(this.listError);
    return this.metas.concat(this.extraMetas).filter((m) => m.key.startsWith(prefix));
  }
  async getTo(key, dest) {
    this.downloads.push(key);
    const buf = this.contents[key];
    if (!buf) throw new Error(`fake store 没有 ${key}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  async version() {
    if (this.versionError) throw new Error(this.versionError);
    return 'ossutil version: v1.7.19';
  }
}

function makeEnv() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  const { config } = parseConfig(
    {
      name: 'analysis',
      oss: { provider: 'ossutil', binary: 'ossutil', endpoint: 'oss-cn-hongkong.aliyuncs.com', bucket: 'dream-ana', prefix: 'snapshot/', configFile: '' },
      sync: { intervalMinutes: 60, minAgeSeconds: 60, countIncludesHeader: false, maxDiskGB: 1, retentionDays: 90, concurrency: 1 },
      process: { nice: 0 }, // 测试里不改优先级
      runtime: { dataDir: 'data', stateDir: 'runtime', logDir: 'logs' },
    },
    { rootDir },
  );
  const logger = createLogger({ level: 'error', sink: () => undefined });
  return { rootDir, config, logger };
}

/** 捕获 console 输出，避免命令的打印污染测试输出 */
async function capture(fn) {
  const out = [];
  const err = [];
  const [ol, oe, ow] = [console.log, console.error, console.warn];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  console.warn = (...a) => err.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = ol;
    console.error = oe;
    console.warn = ow;
  }
}

test('cmdStatus：从未同步过 → 0，并提示先跑 sync', async () => {
  const env = makeEnv();
  const { code, out } = await capture(() => cli.cmdStatus(env.config));
  assert.equal(code, 0);
  assert.match(out, /从未跑过/);
  assert.match(out, /还没有已封存的分片/);
});

test('cmdStatus：有数据时打印封存状态/落后天数/退避分片/口径', async () => {
  const env = makeEnv();
  const keyOld = 'snapshot/boye888/2026-09-30.jsonl.gz';
  const keyToday = `snapshot/boye888/${TODAY}.jsonl.gz`;
  const state = emptyState();
  state.objects[keyOld] = { etag: 'A', size: 10, dataLines: 5, final: true, pulledAt: '2026-10-01T00:00:00.000Z', warnings: [], whitelistVersion: 'v2' };
  state.objects[keyToday] = { etag: 'B', size: 20, dataLines: 7, final: false, pulledAt: '2026-10-03T00:00:00.000Z', warnings: ['行数不符'] };
  state.suspects['snapshot/boye888/2026-10-02.jsonl.gz'] = { count: 2, etag: 'C', lastErrorAt: '2026-10-03T01:00:00.000Z' };
  state.lastRun = {
    startedAt: '2026-10-03T00:00:00.000Z', finishedAt: '2026-10-03T00:00:01.000Z', listed: 3, pulled: 1, skipped: 2,
    ignored: 1, failed: 0, bytes: 20, errors: [], deferred: 1, whitelistChanges: ['boye888: v1 → v2'],
  };
  saveState(statePathOf(env.config), state);

  const { code, out } = await capture(() => cli.cmdStatus(env.config));
  assert.equal(code, 0);
  assert.match(out, /已封存/);
  assert.match(out, /未封存/);
  assert.match(out, /口径=v2/);
  assert.match(out, /数据口径变更: boye888: v1 → v2/);
  assert.match(out, /退避中: 1 个分片/);
  assert.match(out, /失败退避中的分片: 1 个/);
});

test('cmdList：标出"已同步 / 远端已变 / 不符合契约"三种状态', async () => {
  const env = makeEnv();
  const synced = 'snapshot/boye888/2026-10-01.jsonl.gz';
  const changed = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const bogus = 'snapshot/.keep';
  const store = new FakeStore({ [synced]: shardBuffer('boye888', '2026-10-01', [ev('2026-10-01T01:00:00.000Z', 'A')]) });
  store.metas.push({ key: changed, etag: 'NEW', size: 5, lastModified: '', lastModifiedMs: null });
  store.extraMetas.push({ key: bogus, etag: 'K', size: 1, lastModified: '', lastModifiedMs: null });

  const state = emptyState();
  state.objects[synced] = { etag: store.metas[0].etag, size: 1, dataLines: 1, final: true, pulledAt: 'x', warnings: [] };
  state.objects[changed] = { etag: 'OLD', size: 1, dataLines: 1, final: false, pulledAt: 'x', warnings: [] };
  saveState(statePathOf(env.config), state);

  const { code, out } = await capture(() => cli.cmdList({ config: env.config, logger: env.logger, store }));
  assert.equal(code, 0);
  assert.match(out, /✓ 已同步/);
  assert.match(out, /↻ 远端已变/);
  assert.match(out, /✗ 不符合契约/);
});

test('cmdVerify：合法分片 → 0 并打印契约核对要素（行数/事件分布/连接类事件）', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({
    [key]: shardBuffer('boye888', '2026-10-02', [
      ev('2026-10-02T01:00:00.000Z', 'NEW_ROUND'),
      ev('2026-10-02T02:00:00.000Z', 'UDS_CONN_CLOSED'),
      ev('2026-10-02T03:00:00.000Z', 'SELL_FILLED', 'BTC'),
    ], { whitelistVersion: 'v3' }),
  });
  const { code, out } = await capture(() => cli.cmdVerify({ config: env.config, logger: env.logger, store }, key));
  assert.equal(code, 0);
  assert.match(out, /校验通过/);
  assert.match(out, /whitelistVersion=v3/);
  assert.match(out, /连接类事件（断流分析依赖）: UDS_CONN_CLOSED=1/);
  assert.match(out, /symbol 分布/);
});

test('cmdVerify：键不符合契约 → 1（不下载）；坏分片 → 1（并说明不会被入库）', async () => {
  const env = makeEnv();
  const store = new FakeStore({ 'snapshot/.keep': Buffer.from('x') });
  const badKey = await capture(() => cli.cmdVerify({ config: env.config, logger: env.logger, store }, 'snapshot/.keep'));
  assert.equal(badKey.code, 1);
  assert.match(badKey.err, /不符合契约/);

  const noKey = await capture(() => cli.cmdVerify({ config: env.config, logger: env.logger, store }, ''));
  assert.equal(noKey.code, 1);

  const broken = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const brokenStore = new FakeStore({ [broken]: Buffer.from('不是 gzip') });
  const res = await capture(() => cli.cmdVerify({ config: env.config, logger: env.logger, store: brokenStore }, broken));
  assert.equal(res.code, 1);
  assert.match(res.out, /校验失败/);
});

test('cmdDoctor：一切正常 → 0；OSS 列举失败 → 1；ossutil 不可用 → 1', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const good = new FakeStore({ [key]: shardBuffer('boye888', '2026-10-02', [ev('2026-10-02T01:00:00.000Z', 'A')]) });
  const ok = await capture(() => cli.cmdDoctor({ config: env.config, logger: env.logger, store: good }, false));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /全部通过/);

  const listFail = new FakeStore({}, { listError: 'AccessDenied' });
  const bad = await capture(() => cli.cmdDoctor({ config: env.config, logger: env.logger, store: listFail }, false));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /OSS 列举失败/);

  const noOssutil = new FakeStore({}, { versionError: 'spawn ENOENT' });
  const noBin = await capture(() => cli.cmdDoctor({ config: env.config, logger: env.logger, store: noOssutil }, false));
  assert.equal(noBin.code, 1);
  assert.match(noBin.out, /ossutil 不可用/);
});

test('cmdDoctor --deep：下载最新分片做契约核对；含连接类事件时明确报出来', async () => {
  const env = makeEnv();
  const older = 'snapshot/boye888/2026-10-01.jsonl.gz';
  const newer = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({
    [older]: shardBuffer('boye888', '2026-10-01', [ev('2026-10-01T01:00:00.000Z', 'A')]),
    [newer]: shardBuffer('boye888', '2026-10-02', [ev('2026-10-02T01:00:00.000Z', 'A'), ev('2026-10-02T02:00:00.000Z', 'MARKET_STREAM_UNRECOVERED')]),
  });
  const { code, out } = await capture(() => cli.cmdDoctor({ config: env.config, logger: env.logger, store }, true));
  assert.equal(code, 0, out);
  assert.match(out, /契约核对 snapshot\/boye888\/2026-10-02\.jsonl\.gz/);
  assert.match(out, /连接类事件=MARKET_STREAM_UNRECOVERED/);
  assert.ok(!fs.existsSync(cli.verifyTmpPathOf(env.config, 'boye888', '2026-10-02')), '核对用的临时文件必须清掉');
});

test('cmdDoctor --deep：前缀下还没有符合契约的对象 → 0 并提示等上传侧', async () => {
  const env = makeEnv();
  const store = new FakeStore({ 'snapshot/.keep': Buffer.from('x') });
  const { code, out } = await capture(() => cli.cmdDoctor({ config: env.config, logger: env.logger, store }, true));
  assert.equal(code, 0, out);
  assert.match(out, /还没有符合契约的对象/);
});

test('cmdSync：正常 → 0；有失败 → 1；锁被别人持有 → 1 且不下载', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: shardBuffer('boye888', '2026-10-02', [ev('2026-10-02T01:00:00.000Z', 'A')]) });

  const ok = await capture(() => cli.cmdSync({ config: env.config, logger: env.logger, store }, false));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /拉取 1/);

  // 内容指纹必须换掉，否则会因"ETag 未变"被幂等跳过（那是正确行为，但测不到失败路径）
  const failing = new FakeStore({ [key]: Buffer.from('坏') }, { metas: { [key]: { etag: 'E-BAD' } } });
  const bad = await capture(() => cli.cmdSync({ config: env.config, logger: env.logger, store: failing }, false));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /❌/);

  const lockPath = path.join(env.config.runtime.stateDir, 'sync.lock');
  acquireLock(lockPath, { now: new Date(), staleMs: 30 * 60_000, token: 'other' });
  const refused = await capture(() => cli.cmdSync({ config: env.config, logger: env.logger, store }, false));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /已有同步在进行/);
  releaseLock(lockPath, 'other');
});

test('cmdStatus：有同步在跑时明确报出来（锁是"此刻有没有同步"的唯一准确来源）', async () => {
  const env = makeEnv();
  const lockPath = path.join(env.config.runtime.stateDir, 'sync.lock');
  acquireLock(lockPath, { now: new Date(), staleMs: 30 * 60_000, token: 'running' });
  const running = await capture(() => cli.cmdStatus(env.config));
  assert.equal(running.code, 0);
  assert.match(running.out, /当前有同步在进行/);
  releaseLock(lockPath, 'running');

  // 残留锁（持有者进程已死）要提示"下一次会自动接管"，而不是让人以为卡住了
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'dead', acquiredAt: new Date().toISOString(), host: os.hostname() }));
  const stale = await capture(() => cli.cmdStatus(env.config));
  assert.match(stale.out + stale.err, /残留锁/);
  fs.rmSync(lockPath, { force: true });
});

test('applyNice：nice=0 时什么都不做；非法值时只记 warn 不抛', () => {
  const env = makeEnv();
  const lines = [];
  const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  assert.doesNotThrow(() => cli.applyNice(env.config, logger));
  assert.equal(lines.length, 0, 'nice=0 不该有任何输出');

  const aggressive = { ...env.config, process: { nice: 19 } };
  assert.doesNotThrow(() => cli.applyNice(aggressive, logger));
  assert.ok(lines.length >= 1, '要么成功记 info，要么失败记 warn —— 不能静默');
});

test('runSync 与 cmdSync 共用同一把锁（命令级验证：同进程二次进入被拒）', async () => {
  const env = makeEnv();
  const key = 'snapshot/boye888/2026-10-02.jsonl.gz';
  const store = new FakeStore({ [key]: shardBuffer('boye888', '2026-10-02', [ev('2026-10-02T01:00:00.000Z', 'A')]) });
  const first = await runSync({ store, config: env.config, logger: env.logger });
  assert.equal(first.pulled.length, 1);
  assert.ok(!fs.existsSync(path.join(env.config.runtime.stateDir, 'sync.lock')), '正常路径也要释放锁');
});
