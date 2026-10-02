/**
 * 跨进程锁单测（`src/sync/lock.ts`）
 * 背景：常驻 run 与手动 `sync` 是两个进程，共用同一批 tmp 与同一个状态文件。
 * 没有这把锁时会出现"互相删对方 tmp ⇒ 假失败 ⇒ 退避计数上涨"以及"状态文件后写覆盖先写"。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireLock, releaseLock, readLock, isProcessAlive } = require('../../../dist/sync/lock');

const NOW = new Date('2026-10-02T12:00:00.000Z');
const STALE_MS = 30 * 60_000;

function tmpLockPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  return path.join(dir, 'sync.lock');
}

/** 直接写一个指定内容的锁文件（用于构造"异机持有/时间很久"等场景） */
function writeLock(file, over = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, token: 'T', acquiredAt: NOW.toISOString(), host: 'other-host', ...over }));
}

test('第一次获取成功并写入持有者信息；第二个人拿不到（返回持有者）', () => {
  const file = tmpLockPath();
  // 用**真实存活**的 pid：同机判定以"进程是否还活着"为准，写个假 pid 会被正确判为残留锁而接管
  const first = acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-A', pid: process.pid });
  assert.equal(first.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'token-A');

  const second = acquireLock(file, { now: new Date(NOW.getTime() + 60_000), staleMs: STALE_MS, token: 'token-B', pid: 222 });
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, process.pid);
  assert.equal(second.holder.token, 'token-A');
});

test('释放后可以重新获取；持有进程已死（同机）时可接管 —— 硬杀进程不会永久挡路', () => {
  const file = tmpLockPath();
  const host = os.hostname();
  acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-A', host });
  releaseLock(file, 'token-A');
  assert.ok(!fs.existsSync(file));
  assert.equal(acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-C', host }).ok, true);

  // 残留锁 + 进程已死（哪怕才刚写下）⇒ 立刻可接管
  writeLock(file, { pid: 999999, host, token: 'dead', acquiredAt: NOW.toISOString() });
  assert.equal(acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-D', host }).ok, true);
  assert.equal(readLock(file).token, 'token-D');
});

test('损坏的锁文件视为过期（否则会永久挡路）', () => {
  const file = tmpLockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 坏掉的 json');
  const res = acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-E' });
  assert.equal(res.ok, true);
});

test('release 只在 token 匹配时删除（防"过期接管者"被原持有者误删）', () => {
  const file = tmpLockPath();
  acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-A' });
  releaseLock(file, 'token-B'); // 不是我的锁
  assert.ok(fs.existsSync(file), '不该删掉别人的锁');
  releaseLock(file, 'token-A');
  assert.ok(!fs.existsSync(file));
});

test('同机持有者进程已死 ⇒ 立刻接管（pm2 restart/Ctrl+C 打断同步后不该被锁挡满一个周期）', () => {
  const file = tmpLockPath();
  const host = os.hostname();
  writeLock(file, { pid: 999999, host, token: 'dead', acquiredAt: NOW.toISOString() });

  const res = acquireLock(file, { now: new Date(NOW.getTime() + 60_000), staleMs: STALE_MS, token: 'token-new', host });
  assert.equal(res.ok, true, '持有者已死却还拒绝 ⇒ 打断一次同步就要等一个 stale 周期');
  assert.equal(readLock(file).token, 'token-new');
});

test('同机持有者仍活着 ⇒ 拒绝（哪怕已经超过 stale 时长，只要进程在跑就不该被抢）', () => {
  const file = tmpLockPath();
  const host = os.hostname();
  writeLock(file, { pid: process.pid, host, token: 'alive', acquiredAt: new Date(NOW.getTime() - 10 * 3600_000).toISOString() });

  const res = acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-new', host });
  assert.equal(res.ok, false, '活着的持有者绝不能被抢（那正是"两个同步同时跑"的来源）');
  assert.equal(res.holder.token, 'alive');
});

test('异机持有 ⇒ 只能按年龄判：未过期拒绝、过期接管', () => {
  const file = tmpLockPath();
  const host = os.hostname();
  writeLock(file, { host: 'another-host', acquiredAt: NOW.toISOString() });
  assert.equal(acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'a', host }).ok, false);

  writeLock(file, { host: 'another-host', acquiredAt: new Date(NOW.getTime() - STALE_MS - 1000).toISOString() });
  assert.equal(acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'b', host }).ok, true);
});

test('readLock / isProcessAlive：损坏锁返回 null；不存在的 pid 判为已死', () => {
  const file = tmpLockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  assert.equal(readLock(file), null);
  assert.equal(readLock(path.join(path.dirname(file), 'nope.lock')), null);
  assert.equal(isProcessAlive(999999), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(process.pid), true);
});
