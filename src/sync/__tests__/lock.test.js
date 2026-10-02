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
const { acquireLock, releaseLock } = require('../../../dist/sync/lock');

const NOW = new Date('2026-10-02T12:00:00.000Z');
const STALE_MS = 30 * 60_000;

function tmpLockPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  return path.join(dir, 'sync.lock');
}

test('第一次获取成功并写入持有者信息；第二个人拿不到（返回持有者）', () => {
  const file = tmpLockPath();
  const first = acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-A', pid: 111 });
  assert.equal(first.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'token-A');

  const second = acquireLock(file, { now: new Date(NOW.getTime() + 60_000), staleMs: STALE_MS, token: 'token-B', pid: 222 });
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, 111);
  assert.equal(second.holder.token, 'token-A');
});

test('释放后可以重新获取；过期锁可被接管（硬杀进程不会永久挡路）', () => {
  const file = tmpLockPath();
  acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-A' });
  releaseLock(file, 'token-A');
  assert.ok(!fs.existsSync(file));
  assert.equal(acquireLock(file, { now: NOW, staleMs: STALE_MS, token: 'token-C' }).ok, true);

  const stale = new Date(NOW.getTime() + STALE_MS + 1000);
  assert.equal(acquireLock(file, { now: stale, staleMs: STALE_MS, token: 'token-D' }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'token-D');
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
