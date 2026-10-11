/**
 * 看板静态服务单测（`src/web/staticServer.ts`）
 * 只读、防目录穿越、SPA 回退、/data/ 与带扩展名路径 404 不回退。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStaticServer } = require('../../../dist/web/staticServer');

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-static-'));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>dashboard</html>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'data', 'summary.json'), '{"ok":true}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
  return dir;
}

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.text(), type: res.headers.get('content-type') };
}

test('静态服务：200、MIME、HEAD、SPA 回退与 404 边界', async (t) => {
  const root = makeRoot();
  const logs = [];
  const logger = { child: () => logger, info: () => {}, warn: () => {}, error: (_m, x) => logs.push(x?.detail ?? _m) };
  const server = createStaticServer({ rootDir: root, host: '127.0.0.1', port: 0, logger });
  await server.ready;
  const base = `http://${server.address()}`;
  t.after(() => server.close());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // index 与静态资源
  const index = await get(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  assert.match(index.body, /dashboard/);

  const js = await get(`${base}/assets/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.type, /javascript/);

  const data = await get(`${base}/data/summary.json`);
  assert.equal(data.status, 200);
  assert.match(data.type, /application\/json/);

  // SPA 回退：无扩展名的深链 → index.html
  const fallback = await get(`${base}/some/deep/route`);
  assert.equal(fallback.status, 200);
  assert.match(fallback.body, /dashboard/);

  // 不回退的边界：/data/ 下不存在 = 真 404；带扩展名不存在 = 真 404
  assert.equal((await get(`${base}/data/nope.json`)).status, 404);
  assert.equal((await get(`${base}/assets/nope.js`)).status, 404);

  // 目录穿越被拦
  const traversal = await get(`${base}/../../../../etc/passwd`);
  assert.ok(traversal.status === 403 || traversal.status === 400 || !traversal.body.includes('root:'));

  // HEAD 可用
  const head = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  // 拒绝写方法
  const post = await fetch(`${base}/`, { method: 'POST' });
  assert.equal(post.status, 405);

  assert.deepEqual(logs, []);
});
