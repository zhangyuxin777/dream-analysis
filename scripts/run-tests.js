#!/usr/bin/env node
/**
 * 测试运行器（dream-analysis）
 *
 * 设计要点（每条都对着"假通过"来防）：
 * 1. **集合 = 磁盘发现**：`src/`、`scripts/` 下的 `*.test.[cm]?js`；没有手写清单，加测试 = 新建文件。
 * 2. **总是把文件清单显式传给 `node --test`**：绝不让 node 回退自己的发现规则
 *    （那会扫到 `run-tests.js` 这类工具文件并递归执行 —— 主仓踩过 544 进程事故）。
 * 3. **过滤命中 0 个 ⇒ 失败**（不是"跑 0 个 = 通过"），除非显式 `--allow-empty`。
 * 4. **未知开关 ⇒ 硬失败**（静默忽略会让人以为"跑过了"）。
 * 5. **递归深度护栏**：`DSH_TEST_RUNNER_DEPTH` ≥ 2 直接拒绝，且在扫盘之前。
 * 6. 清单落盘 `logs/test/run-tests-<ts>.txt`，挂了能对照二分。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DISCOVERY_ROOTS = ['src', 'scripts'];
/** 遍历时跳过的目录（dist/logs/data 里绝不该有测试；logs 里放代码是主仓踩过的坑） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'logs', 'runtime', 'data', '.git', '.dsh']);
const MAX_DEPTH = 2;
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(8, os.cpus().length - 1));
/** 覆盖率硬门槛（Node ≥22.8 原生支持；不过就 exit 非 0 —— 没有"警告档"） */
const COVERAGE = { lines: 80, branches: 80, functions: 80 };

/** 递归收集测试文件（绝对路径，已排序） */
function discoverTests() {
  const out = [];
  for (const rel of DISCOVERY_ROOTS) walk(path.join(ROOT, rel), out);
  return out.sort();
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在 = 没有测试，不是错误
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && /\.test\.[cm]?js$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

/** 相对 ROOT 的 posix 风格路径（用于打印与过滤匹配） */
function relOf(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

const KNOWN_FLAGS = new Set([
  '--only', '--list', '--coverage', '--concurrency', '--timeout',
  '--reporter', '--allow-empty', '--help',
]);

/** 解析 argv（纯函数，便于单测钉住契约） */
function parseArgs(argv) {
  const opts = {
    only: [],
    list: false,
    coverage: false,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: null,
    reporter: 'spec',
    allowEmpty: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--only 需要一个子串参数');
      opts.only.push(v);
    } else if (a === '--concurrency') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error('--concurrency 需要正整数');
      opts.concurrency = v;
    } else if (a === '--timeout') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--timeout 需要正数（毫秒）');
      opts.timeoutMs = v;
    } else if (a === '--reporter') {
      const v = argv[++i];
      if (!['spec', 'tap', 'dot'].includes(v)) throw new Error('--reporter 只支持 spec|tap|dot');
      opts.reporter = v;
    } else if (a === '--list') opts.list = true;
    else if (a === '--coverage') opts.coverage = true;
    else if (a === '--allow-empty') opts.allowEmpty = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`未知开关: ${a}（已知: ${[...KNOWN_FLAGS].join(' ')}）`);
    else opts.only.push(a); // 位置参数 = 过滤子串（`npm run test:only -- carry`）
  }
  return opts;
}

/**
 * `node --test` 的参数。**末尾必须是本批文件清单** ——
 * 这条契约由 `scripts/__tests__/run-tests.test.js` 钉住（防"清单丢失 ⇒ 回退 node 发现模式"）。
 */
function argsForChunk(files, opts) {
  const args = ['--test', `--test-concurrency=${opts.concurrency}`, `--test-reporter=${opts.reporter}`];
  if (opts.timeoutMs) args.push(`--test-timeout=${opts.timeoutMs}`);
  if (opts.coverage) {
    args.push('--experimental-test-coverage',
      `--test-coverage-lines=${COVERAGE.lines}`,
      `--test-coverage-branches=${COVERAGE.branches}`,
      `--test-coverage-functions=${COVERAGE.functions}`);
  }
  return args.concat(files);
}

/** 过滤：按相对路径子串（大小写不敏感） */
function filterTests(files, only) {
  if (only.length === 0) return files;
  const needles = only.map((s) => s.toLowerCase());
  return files.filter((f) => {
    const rel = relOf(f).toLowerCase();
    return needles.some((n) => rel.includes(n));
  });
}

/** dist 过期提醒（只提醒不拦：`npm test` 路径已经 tsc 过了，`test:only` 可能过期） */
function distStalenessWarning() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) return 'dist/ 不存在 —— 先 `npm run build`';
  const newest = (dir, re) => {
    let best = 0;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (re.test(e.name)) best = Math.max(best, fs.statSync(p).mtimeMs);
      }
    }
    return best;
  };
  const srcNewest = newest(path.join(ROOT, 'src'), /\.ts$/);
  const distNewest = newest(distDir, /\.js$/);
  if (distNewest > 0 && srcNewest > distNewest) return 'dist/ 可能过期（有 .ts 比 dist 新）—— 建议先 `npm run build`';
  return null;
}

function writeRunList(files) {
  const dir = path.join(ROOT, 'logs', 'test');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `run-tests-${stamp}.txt`);
  fs.writeFileSync(file, files.map(relOf).join('\n') + '\n', 'utf8');
  // 只保留最近 10 份
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('run-tests-')).sort();
  for (const f of kept.slice(0, Math.max(0, kept.length - 10))) fs.unlinkSync(path.join(dir, f));
  return relOf(file);
}

function main() {
  const depth = Number(process.env.DSH_TEST_RUNNER_DEPTH || '0');
  if (depth >= MAX_DEPTH) {
    console.error(`[run-tests] 递归深度 ${depth} ≥ ${MAX_DEPTH}，拒绝继续（测试里不许再起一个运行器）`);
    return 1;
  }

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[run-tests] ${err.message}`);
    return 1;
  }
  if (opts.help) {
    console.log('用法: node scripts/run-tests.js [过滤子串…] [--only <子串>] [--list] [--coverage] [--concurrency N] [--timeout ms] [--reporter spec|tap|dot]');
    return 0;
  }

  const discovered = discoverTests();
  const selected = filterTests(discovered, opts.only);

  if (opts.list) {
    console.log(`[run-tests] 发现 ${discovered.length} 个测试文件，命中 ${selected.length} 个：`);
    for (const f of selected) console.log('  ' + relOf(f));
    if (selected.length !== discovered.length) {
      const hit = new Set(selected);
      console.log('  --- 被过滤掉 ---');
      for (const f of discovered) if (!hit.has(f)) console.log('  ' + relOf(f));
    }
    return 0;
  }

  if (discovered.length === 0) {
    console.error('[run-tests] 未发现任何测试文件（src/ scripts/ 下的 *.test.js）—— 视为失败');
    return 1;
  }
  if (selected.length === 0) {
    const msg = `[run-tests] 过滤条件命中 0 个（共发现 ${discovered.length} 个）：${opts.only.join(' ')}`;
    if (!opts.allowEmpty) {
      console.error(msg + ' —— 视为失败（避免"跑了 0 个也算通过"）');
      return 1;
    }
    console.warn(msg + ' —— --allow-empty 放行，不执行任何测试');
    return 0;
  }

  const warn = distStalenessWarning();
  if (warn) console.warn(`[run-tests] ⚠️ ${warn}`);

  const listFile = writeRunList(selected);
  console.log(`[run-tests] 发现 ${discovered.length} 个，本次执行 ${selected.length} 个；清单: ${listFile}`);

  const args = argsForChunk(selected, opts);
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, DSH_TEST_RUNNER_DEPTH: String(depth + 1) },
  });
  if (res.error) {
    console.error(`[run-tests] 无法启动 node --test: ${res.error.message}`);
    return 1;
  }
  return res.status === null ? 1 : res.status;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { discoverTests, parseArgs, argsForChunk, filterTests, relOf, COVERAGE, DEFAULT_CONCURRENCY };
