/**
 * 状态文本单测（`src/report/status.ts`）—— CLI 与机器人共用同一份文案。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildStatusText } = require('../../../dist/report/status');
const { parseConfig } = require('../../../dist/config/index');
const { emptyState, saveState } = require('../../../dist/sync/state');
const { statePathOf, lockPathOf } = require('../../../dist/sync/puller');
const { acquireLock } = require('../../../dist/sync/lock');

const NOW = new Date('2026-10-03T12:00:00.000Z'); // 北京时间 10-03 20:00

function makeEnv() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
  const { config } = parseConfig(
    {
      name: 'analysis',
      oss: { provider: 'ossutil', binary: 'ossutil', endpoint: 'oss-cn-hongkong.aliyuncs.com', bucket: 'dream-ana', prefix: 'snapshot/', configFile: '' },
      runtime: { dataDir: 'data', stateDir: 'runtime', logDir: 'logs' },
    },
    { rootDir },
  );
  return { rootDir, config };
}

test('从未同步过：给出可行动的下一步', () => {
  const env = makeEnv();
  const text = buildStatusText(env.config, { now: NOW, rootDir: env.rootDir });
  assert.match(text, /=== 同步状态 ===/);
  assert.match(text, /状态文件: runtime/);
  assert.match(text, /从未跑过（先执行 sync）/);
  assert.match(text, /还没有已封存的分片/);
  assert.match(text, /本地分片: 0 个/);
});

test('有数据：封存状态 / 落后天数 / 退避 / 口径变更 / 失败项都露出来', () => {
  const env = makeEnv();
  const shards = [{ key: `${env.config.oss.prefix}boye888/2026-10-01.jsonl.gz`, date: '2026-10-01', final: true, lines: 700 }];
  const state = emptyState();
  for (const s of shards) {
    state.objects[s.key] = { etag: 'E1', size: 1000, dataLines: s.lines, final: s.final, pulledAt: '2026-10-02T00:00:00.000Z', warnings: [], whitelistVersion: 'v2' };
  }
  state.objects[`${env.config.oss.prefix}boye888/2026-10-02.jsonl.gz`] = { etag: 'E2', size: 10, dataLines: 5, final: false, pulledAt: '2026-10-03T00:00:00.000Z', warnings: ['行数不符'] };
  state.suspects[`${env.config.oss.prefix}boye888/2026-09-30.jsonl.gz`] = { count: 2, etag: 'E9', lastErrorAt: '2026-10-03T01:00:00.000Z' };
  state.lastRun = {
    startedAt: '2026-10-03T00:00:00.000Z', finishedAt: '2026-10-03T00:00:00.200Z', listed: 3, pulled: 1, skipped: 2,
    ignored: 1, failed: 0, bytes: 1000, errors: [], deferred: 1, whitelistChanges: ['boye888: v1 → v2'], refusedByLock: true,
  };
  saveState(statePathOf(env.config), state);

  const text = buildStatusText(env.config, { now: NOW, rootDir: env.rootDir });
  assert.match(text, /上次同步: 2026-10-03T00:00:00\.200Z 用时 200ms/);
  assert.match(text, /本轮因"已有同步在进行"被跳过/);
  assert.match(text, /退避中: 1 个分片/);
  assert.match(text, /数据口径变更: boye888: v1 → v2/);
  assert.match(text, /已封存/);
  assert.match(text, /未封存/);
  assert.match(text, /口径=v2/);
  assert.match(text, /1 条告警/);
  assert.match(text, /已封存最新日期: 2026-10-01（今天 2026-10-03，落后 2 天）/);
  assert.match(text, /失败退避中的分片: 1 个/);
  assert.match(text, /已失败 2 次/);
});

test('status：报出"历史覆盖"起止（本地分片永不自动删除 ⇒ 盘上就是全部历史）', () => {
  const env = makeEnv();
  const state = emptyState();
  state.objects[`${env.config.oss.prefix}boye888/2026-10-01.jsonl.gz`] = { etag: 'E1', size: 1, dataLines: 1, final: true, pulledAt: 'x', warnings: [] };
  state.lastRun = {
    startedAt: '2026-10-04T02:00:00.000Z', finishedAt: '2026-10-04T02:00:00.100Z', listed: 5, pulled: 1, skipped: 3,
    ignored: 0, failed: 0, bytes: 100, errors: [], deferred: 0, whitelistChanges: [], refusedByLock: false,
  };
  saveState(statePathOf(env.config), state);
  // 盘上放一份很老的 + 一份新的
  for (const date of ['2020-01-01', '2026-10-01']) {
    const d = path.join(env.config.runtime.dataDir, 'boye888');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${date}.jsonl.gz`), 'x');
  }

  const text = buildStatusText(env.config, { now: NOW });
  assert.match(text, /历史覆盖: 2020-01-01 ~ 最新/);
  assert.match(text, /永不自动删除/);
  assert.ok(!/淘汰/.test(text), '不该再出现任何"淘汰"字样');
});

test('落后超过 2 天要显式告警（这是"同步可能停了"的最直接信号）', () => {
  const env = makeEnv();
  const state = emptyState();
  state.objects[`${env.config.oss.prefix}boye888/2026-09-20.jsonl.gz`] = { etag: 'E1', size: 1, dataLines: 1, final: true, pulledAt: 'x', warnings: [] };
  saveState(statePathOf(env.config), state);
  assert.match(buildStatusText(env.config, { now: NOW }), /数据落后超过 2 天/);
});

test('锁：正在同步时显示持有者；残留锁（进程已死）提示下次自动接管', () => {
  const env = makeEnv();
  acquireLock(lockPathOf(env.config), { now: NOW, staleMs: 30 * 60_000, token: 't1' });
  const running = buildStatusText(env.config, { now: NOW });
  assert.match(running, /当前有同步在进行: pid=\d+@/);

  fs.writeFileSync(lockPathOf(env.config), JSON.stringify({ pid: 999999, token: 'dead', acquiredAt: NOW.toISOString(), host: os.hostname() }));
  assert.match(buildStatusText(env.config, { now: NOW }), /残留锁/);
});
