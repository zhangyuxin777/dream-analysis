/**
 * 测试运行器自身的单测（`scripts/run-tests.js`）
 *
 * 这是**接线钉子**：主仓栽过"清单没传下去 ⇒ node 回退自己的发现模式 ⇒ 递归 544 进程"，
 * 所以这里钉死三件事：① argv 末尾必须是本批文件清单 ② 未知开关必须硬失败 ③ 发现集合只认 src/ scripts/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const runner = require('../run-tests');

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = [path.join(ROOT, 'src', 'a', '__tests__', 'a.test.js'), path.join(ROOT, 'src', 'b', '__tests__', 'b.test.js')];

test('argsForChunk：argv 末尾必须是本批文件清单（防回退 node 自身发现模式）', () => {
  const opts = runner.parseArgs([]);
  const args = runner.argsForChunk(FILES, opts);
  assert.equal(args[0], '--test');
  assert.deepEqual(args.slice(-FILES.length), FILES, '文件清单必须是最后几个参数');
  assert.ok(!args.includes('--test-reporter=spec') === false, '默认报告器是 spec');
});

test('argsForChunk：--coverage 时带上三个覆盖率硬阈值（Node 原生，不达标即 exit 非 0）', () => {
  const opts = runner.parseArgs(['--coverage']);
  const args = runner.argsForChunk(FILES, opts);
  assert.ok(args.includes('--experimental-test-coverage'));
  assert.ok(args.includes(`--test-coverage-lines=${runner.COVERAGE.lines}`));
  assert.ok(args.includes(`--test-coverage-branches=${runner.COVERAGE.branches}`));
  assert.ok(args.includes(`--test-coverage-functions=${runner.COVERAGE.functions}`));
});

test('parseArgs：位置参数与 --only 都当过滤子串；concurrency/reporter/timeout 可解析', () => {
  assert.deepEqual(runner.parseArgs(['carry']).only, ['carry']);
  assert.deepEqual(runner.parseArgs(['--only', 'sync']).only, ['sync']);
  assert.deepEqual(runner.parseArgs(['sync', 'state']).only, ['sync', 'state']);
  assert.equal(runner.parseArgs(['--concurrency', '3']).concurrency, 3);
  assert.equal(runner.parseArgs(['--reporter', 'tap']).reporter, 'tap');
  assert.equal(runner.parseArgs(['--timeout', '5000']).timeoutMs, 5000);
});

test('parseArgs：未知开关硬失败（静默忽略会让人以为"跑过了"）', () => {
  assert.throws(() => runner.parseArgs(['--nope']), /未知开关/);
  assert.throws(() => runner.parseArgs(['--only']), /--only 需要/);
  assert.throws(() => runner.parseArgs(['--concurrency', '0']), /concurrency/);
  assert.throws(() => runner.parseArgs(['--reporter', 'yaml']), /reporter/);
});

test('filterTests：子串大小写不敏感；无命中返回空（由 main 判失败，不是"跑 0 个算通过"）', () => {
  assert.deepEqual(runner.filterTests(FILES, []), FILES);
  assert.deepEqual(runner.filterTests(FILES, ['A']), [FILES[0]]);
  assert.deepEqual(runner.filterTests(FILES, ['a/__tests__', 'b/__tests__']), FILES);
  assert.deepEqual(runner.filterTests(FILES, ['nothing-matches']), []);
});

test('discoverTests：只认 src/ scripts/ 下的 *.test.js，且不扫 node_modules/dist/logs', () => {
  const found = runner.discoverTests();
  assert.ok(Array.isArray(found));
  for (const f of found) {
    const rel = runner.relOf(f);
    assert.match(rel, /\.test\.[cm]?js$/, `命名不合规: ${rel}`);
    assert.ok(rel.startsWith('src/') || rel.startsWith('scripts/'), `发现根之外: ${rel}`);
    assert.ok(!/(^|\/)(node_modules|dist|logs|runtime|data)\//.test(rel), `不该扫到: ${rel}`);
    assert.ok(fs.existsSync(f), '发现结果必须是磁盘上真实存在的文件');
  }
});

test('discoverTests：确实发现了本仓的测试（防"发现逻辑静默失效 ⇒ 0 个也算过"）', () => {
  const found = runner.discoverTests().map(runner.relOf);
  assert.ok(found.length >= 8, `至少应发现 8 个测试文件，实际 ${found.length}`);
  assert.ok(found.includes('src/ndjson/__tests__/shard.test.js'));
  assert.ok(found.includes('src/sync/__tests__/puller.test.js'));
});

test('relOf：统一成 posix 风格（Windows 上打印/过滤不能出现反斜杠）', () => {
  assert.equal(runner.relOf(path.join(ROOT, 'src', 'x', '__tests__', 'y.test.js')), 'src/x/__tests__/y.test.js');
});
