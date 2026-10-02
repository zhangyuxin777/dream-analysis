/**
 * 分析执行器单测（`src/analysis/runner.ts`）—— CLI 与机器人共用的那条链路。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { runAnalysis, resolveAnalysis, AnalysisRunError } = require('../../../dist/analysis/runner');
const { createDefaultRegistry } = require('../../../dist/analysis/types');
const { parseConfig } = require('../../../dist/config/index');
const { emptyState, saveState } = require('../../../dist/sync/state');
const { statePathOf } = require('../../../dist/sync/puller');
const { WindowTooLongError } = require('../../../dist/common/time');

function makeEnv(reportOver = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const { config } = parseConfig(
    {
      name: 'analysis',
      oss: { provider: 'ossutil', binary: 'ossutil', endpoint: 'oss-cn-hongkong.aliyuncs.com', bucket: 'dream-ana', prefix: 'snapshot/', configFile: '' },
      sync: { intervalMinutes: 60, minAgeSeconds: 60, countIncludesHeader: false, maxDiskGB: 1, retentionDays: 90, concurrency: 1 },
      process: { nice: 0 },
      runtime: { dataDir: 'data', stateDir: 'runtime', logDir: 'logs' },
      report: { inlineMaxChars: 3500, signTtlHours: 24, ...reportOver },
    },
    { rootDir },
  );
  return { rootDir, config };
}

function installShard(config, instance, date, events) {
  const dir = path.join(config.runtime.dataDir, instance);
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'meta', schema: 2, instance, date, final: true, count: events.length });
  fs.writeFileSync(path.join(dir, `${date}.jsonl.gz`), zlib.gzipSync(Buffer.from([header, ...events.map((e) => JSON.stringify(e))].join('\n') + '\n', 'utf8')));
  const state = emptyState();
  state.objects[`${config.oss.prefix}${instance}/${date}.jsonl.gz`] = { etag: 'E1', size: 1, dataLines: events.length, final: true, pulledAt: 'x', warnings: [] };
  saveState(statePathOf(config), state);
}

const EVENTS = [
  { ts: '2026-10-01T01:00:00.000Z', event: 'NEW_ROUND', symbol: 'ETHFDUSD', roundId: 'R1', localDate: '2026-10-01', seq: 1, data: {} },
  { ts: '2026-10-01T02:00:00.000Z', event: 'SELL_FILLED', symbol: 'ETHFDUSD', roundId: 'R1', localDate: '2026-10-01', seq: 2, data: { profit: 2 } },
];

test('未知分析器 → AnalysisRunError(unknown-analysis)', async () => {
  const env = makeEnv();
  await assert.rejects(
    () => runAnalysis({ config: env.config, name: 'nope', params: {}, now: new Date('2026-10-02T12:00:00Z') }),
    (err) => err instanceof AnalysisRunError && err.kind === 'unknown-analysis',
  );
  const registry = createDefaultRegistry([]);
  assert.throws(() => resolveAnalysis(registry, 'nope'), /未知分析器/);
});

test('本地没有分片 → AnalysisRunError(no-data)（文案要能直接发给用户）', async () => {
  const env = makeEnv();
  await assert.rejects(
    () => runAnalysis({ config: env.config, name: 'rounds', params: {}, now: new Date('2026-10-02T12:00:00Z') }),
    (err) => err instanceof AnalysisRunError && err.kind === 'no-data' && /先同步/.test(err.message),
  );
});

test('正常路径：返回分析器/窗口/渲染结果/耗时', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', EVENTS);
  const out = await runAnalysis({ config: env.config, name: 'r', params: { window: '2026-10-01' }, now: new Date('2026-10-02T12:00:00Z') });
  assert.equal(out.analysis.name, 'rounds');
  assert.equal(out.window.label, '2026-10-01');
  assert.match(out.rendered.text, /止盈利润合计 2\.00/);
  assert.equal(out.rendered.truncated, false);
  assert.ok(out.elapsedMs >= 0);
});

test('窗口超限 → WindowTooLongError（在枚举天数之前就拦）', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', EVENTS);
  await assert.rejects(
    () => runAnalysis({ config: env.config, name: 'r', params: { window: '近100000d' }, now: new Date('2026-10-02T12:00:00Z') }),
    WindowTooLongError,
  );
});

test('状态文件彻底坏掉：不抛原始异常，按"没有数据"处理（用户看到的是可行动的一句话）', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', EVENTS);
  fs.writeFileSync(statePathOf(env.config), '{ 坏 json');
  await assert.rejects(
    () => runAnalysis({ config: env.config, name: 'r', params: { window: '2026-10-01' }, now: new Date('2026-10-02T12:00:00Z') }),
    (err) => err instanceof AnalysisRunError && err.kind === 'no-data',
  );
});

test('状态文件只是"有告警"（旧格式 suspects）：正常出结果，并把告警并进去', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', EVENTS);
  const statePath = statePathOf(env.config);
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  raw.suspects = { [`${env.config.oss.prefix}boye888/2026-09-30.jsonl.gz`]: 2 }; // 旧格式：裸数字
  fs.writeFileSync(statePath, JSON.stringify(raw));

  const out = await runAnalysis({ config: env.config, name: 'r', params: { window: '2026-10-01' }, now: new Date('2026-10-02T12:00:00Z') });
  assert.match(out.rendered.text, /暂定|止盈利润/, '仍旧要出报告');
  assert.ok(out.result.warnings.some((w) => w.startsWith('状态文件有问题：')), out.result.warnings.join('|'));
});
