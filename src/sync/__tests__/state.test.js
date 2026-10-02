/**
 * 同步状态单测（`src/sync/state.ts`）
 * `planPull` 是"拉什么/不拉什么"的唯一判据，边界必须逐条钉住。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  planPull,
  saveState,
  loadState,
  emptyState,
  listLocalShards,
  selectShardsToPrune,
} = require('../../../dist/sync/state');

const PREFIX = 'snapshot/';
const NOW = new Date('2026-10-02T12:00:00.000Z');
const iso = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600_000);

function meta(key, etag, ageHours = 3, size = 100) {
  return { key, etag, size, lastModified: '', lastModifiedMs: iso(ageHours).getTime() };
}

test('planPull：ETag 相同 → 跳过（幂等核心）', () => {
  const state = emptyState();
  state.objects['snapshot/a/2026-10-01.jsonl.gz'] = { etag: 'E1', size: 100, dataLines: 5, final: true, pulledAt: 'x', warnings: [] };
  const plan = planPull([meta('snapshot/a/2026-10-01.jsonl.gz', 'E1', 5)], state, { prefix: PREFIX, minAgeSeconds: 60, now: NOW });
  assert.equal(plan.toPull.length, 0);
  assert.deepEqual(plan.skipped, [{ key: 'snapshot/a/2026-10-01.jsonl.gz', reason: 'etag-unchanged' }]);
  assert.deepEqual(plan.recomputed, []);
});

test('planPull：ETag 变了 → 重拉 + 记入 recomputed（当天重算属正常）', () => {
  const state = emptyState();
  state.objects['snapshot/a/2026-10-02.jsonl.gz'] = { etag: 'E1', size: 100, dataLines: 5, final: false, pulledAt: 'x', warnings: [] };
  const plan = planPull([meta('snapshot/a/2026-10-02.jsonl.gz', 'E2', 3)], state, { prefix: PREFIX, minAgeSeconds: 60, now: NOW });
  assert.equal(plan.toPull.length, 1);
  assert.deepEqual(plan.recomputed, ['snapshot/a/2026-10-02.jsonl.gz']);
});

test('planPull：太新（不足 minAgeSeconds）→ 跳过（防竞态读半成品）', () => {
  const plan = planPull([meta('snapshot/a/2026-10-02.jsonl.gz', 'E1', 0.001)], emptyState(), { prefix: PREFIX, minAgeSeconds: 60, now: NOW });
  assert.deepEqual(plan.skipped, [{ key: 'snapshot/a/2026-10-02.jsonl.gz', reason: 'too-fresh' }]);
});

test('planPull：连续失败达上限 → 不再重试（防病态对象拖住每轮）；force 可强制重试', () => {
  const state = emptyState();
  state.suspects['snapshot/a/2026-10-02.jsonl.gz'] = 3;
  const blocked = planPull([meta('snapshot/a/2026-10-02.jsonl.gz', 'E9', 3)], state, { prefix: PREFIX, minAgeSeconds: 60, now: NOW });
  assert.deepEqual(blocked.skipped, [{ key: 'snapshot/a/2026-10-02.jsonl.gz', reason: 'suspect-limit' }]);

  const forced = planPull([meta('snapshot/a/2026-10-02.jsonl.gz', 'E9', 3)], state, { prefix: PREFIX, minAgeSeconds: 60, now: NOW, force: true });
  assert.equal(forced.toPull.length, 1);
});

test('planPull：force 忽略 ETag 与静默期（但仍不接受非法键）', () => {
  const state = emptyState();
  state.objects['snapshot/a/2026-10-01.jsonl.gz'] = { etag: 'E1', size: 1, dataLines: 1, final: true, pulledAt: 'x', warnings: [] };
  const plan = planPull(
    [meta('snapshot/a/2026-10-01.jsonl.gz', 'E1', 5), meta('snapshot/a/2026-10-02.jsonl.gz', 'E2', 0.001), meta('snapshot/.keep', 'E3', 99)],
    state,
    { prefix: PREFIX, minAgeSeconds: 60, now: NOW, force: true },
  );
  assert.deepEqual(plan.toPull.map((m) => m.key), ['snapshot/a/2026-10-01.jsonl.gz', 'snapshot/a/2026-10-02.jsonl.gz']);
  assert.equal(plan.ignored.length, 1);
  assert.equal(plan.ignored[0].key, 'snapshot/.keep');
  assert.equal(plan.ignored[0].reason, 'key-not-matching-contract');
});

test('planPull：lastModifiedMs 为 null 时不因静默期跳过（解析失败不该阻塞拉取）', () => {
  const weird = { key: 'snapshot/a/2026-10-02.jsonl.gz', etag: 'E1', size: 1, lastModified: '??', lastModifiedMs: null };
  const plan = planPull([weird], emptyState(), { prefix: PREFIX, minAgeSeconds: 60, now: NOW });
  assert.equal(plan.toPull.length, 1);
});

test('saveState/loadState：往返一致、键排序稳定、原子写不留 tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  const file = path.join(dir, 'nested', 'sync-state.json');
  const state = emptyState();
  state.objects['snapshot/b/2026-10-01.jsonl.gz'] = { etag: 'B', size: 2, dataLines: 2, final: true, pulledAt: 't1', warnings: ['w'] };
  state.objects['snapshot/a/2026-10-01.jsonl.gz'] = { etag: 'A', size: 1, dataLines: 1, final: false, pulledAt: 't2', warnings: [] };
  state.suspects['snapshot/c/2026-10-01.jsonl.gz'] = 2;
  state.lastRun = { startedAt: 's', finishedAt: 'f', listed: 2, pulled: 2, skipped: 0, ignored: 0, failed: 0, bytes: 3, errors: [] };
  saveState(file, state);

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.indexOf('snapshot/a/') < text.indexOf('snapshot/b/'), '键必须排序（让 diff 稳定）');
  assert.ok(!fs.existsSync(`${file}.tmp`), '原子写不该留下 tmp');

  const loaded = loadState(file);
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(Object.keys(loaded.state.objects), ['snapshot/a/2026-10-01.jsonl.gz', 'snapshot/b/2026-10-01.jsonl.gz']);
  assert.equal(loaded.state.objects['snapshot/b/2026-10-01.jsonl.gz'].final, true);
  assert.equal(loaded.state.suspects['snapshot/c/2026-10-01.jsonl.gz'], 2);
  assert.equal(loaded.state.lastRun.pulled, 2);
});

test('loadState：文件缺失/损坏都不抛，按空状态处理并给 warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-bad-'));
  const missing = loadState(path.join(dir, 'nope.json'));
  assert.deepEqual(missing.state, emptyState());
  assert.deepEqual(missing.warnings, []);

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  const bad = loadState(broken);
  assert.equal(bad.state.version, 1);
  assert.equal(bad.warnings.length, 1);

  const wrongVersion = path.join(dir, 'v2.json');
  fs.writeFileSync(wrongVersion, JSON.stringify({ version: 2, objects: {} }));
  assert.match(loadState(wrongVersion).warnings[0], /版本\/结构不符/);
});

test('listLocalShards：只认 <instance>/<date>.jsonl.gz，跳过 .tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shards-'));
  fs.mkdirSync(path.join(dir, 'boye888'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.tmp', 'boye888'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'boye888', '2026-10-02.jsonl.gz'), 'x');
  fs.writeFileSync(path.join(dir, 'boye888', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.tmp', 'boye888', '2026-10-02.jsonl.gz'), 'x');

  const shards = listLocalShards(dir);
  assert.deepEqual(shards.map((s) => `${s.instance}/${s.date}`), ['boye888/2026-10-02']);
});

test('selectShardsToPrune：按保留天数淘汰，且至少留一份', () => {
  const shards = [
    { instance: 'a', date: '2020-01-01', filePath: 'p1', size: 10 },
    { instance: 'a', date: '2026-10-01', filePath: 'p2', size: 10 },
    { instance: 'a', date: '2026-10-02', filePath: 'p3', size: 10 },
  ];
  const pruned = selectShardsToPrune(shards, { retentionDays: 30, maxDiskGB: 1, now: new Date('2026-10-02T12:00:00+08:00') });
  assert.deepEqual(pruned.map((p) => p.filePath), ['p1']);

  const allOld = shards.map((s) => ({ ...s, date: '2020-01-01' }));
  const keepOne = selectShardsToPrune(allOld, { retentionDays: 1, maxDiskGB: 1, now: new Date('2026-10-02T12:00:00+08:00') });
  assert.equal(keepOne.length, 2, '三份都过期也只删到剩一份');
});

test('selectShardsToPrune：磁盘超限时从最旧开始删，删到低于上限即停（最小删除）', () => {
  const shards = [
    { instance: 'a', date: '2026-09-01', filePath: 'old', size: 600 * 1024 * 1024 },
    { instance: 'a', date: '2026-09-02', filePath: 'mid', size: 600 * 1024 * 1024 },
    { instance: 'a', date: '2026-09-03', filePath: 'new', size: 100 * 1024 * 1024 },
  ];
  const pruned = selectShardsToPrune(shards, { retentionDays: 3650, maxDiskGB: 1, now: new Date('2026-10-02T12:00:00+08:00') });
  // 总量 1300MB > 1024MB ⇒ 删最旧的 600MB 后剩 700MB 已达标 ⇒ 停手（不多删）
  assert.deepEqual(pruned.map((p) => p.filePath), ['old']);

  const tight = selectShardsToPrune(shards, { retentionDays: 3650, maxDiskGB: 0.5, now: new Date('2026-10-02T12:00:00+08:00') });
  assert.deepEqual(tight.map((p) => p.filePath), ['old', 'mid'], '上限 0.5GB 时要一直删到只剩 100MB 那份');
});
