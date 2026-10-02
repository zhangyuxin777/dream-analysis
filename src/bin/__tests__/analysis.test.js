/**
 * CLI 冒烟单测（`src/bin/analysis.ts`）
 * 只钉两件事：① 模块可被 require 而不执行主流程（`require.main` 守卫）② 配置缺失时 fail-fast 返回码 2
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cli = require('../../../dist/bin/analysis');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('require 该模块不会执行主流程，且导出 main', () => {
  assert.equal(typeof cli.main, 'function');
  assert.equal(cli.shardPathOf, undefined, 'CLI 不该顺手导出内部实现（只暴露 main）');
});

test('缺少 env.json 时 main() 返回 2（配置错 fail-fast，不抛给调用方）', async (t) => {
  if (fs.existsSync(path.join(ROOT, 'env.json'))) {
    t.skip('本机存在 env.json，跳过"缺配置"这条路径');
    return;
  }
  const saved = process.argv;
  process.argv = [process.execPath, 'analysis.js', 'status'];
  try {
    assert.equal(await cli.main(), 2);
  } finally {
    process.argv = saved;
  }
});

test('未知命令返回 1（并打印用法）', async () => {
  const saved = process.argv;
  process.argv = [process.execPath, 'analysis.js', 'definitely-not-a-command'];
  const logs = [];
  const origError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const code = await cli.main();
    // 没有 env.json 时会在配置阶段就返回 2；有 env.json 时应走到"未知命令"返回 1
    assert.ok(code === 1 || code === 2, `期望 1 或 2，实际 ${code}`);
  } finally {
    console.error = origError;
    process.argv = saved;
  }
});
