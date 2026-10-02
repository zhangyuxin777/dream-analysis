/**
 * 指令路由单测（`src/bot/router.ts`）—— **不碰网络**：假 store/假同步/假回复。
 * 覆盖：鉴权顺序、whoami、status、sync（管理员）、analyze（真分片算真数）、并发闸门、二次回复、截断落盘。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { CommandRouter, buildHelpText, formatAnalysisError } = require('../../../dist/bot/router');
const { AnalysisRegistry } = require('../../../dist/analysis/types');
const { createDefaultRegistry } = require('../../../dist/analysis/types');
const { parseConfig } = require('../../../dist/config/index');
const { createLogger } = require('../../../dist/common/logger');
const { emptyState, saveState } = require('../../../dist/sync/state');
const { statePathOf } = require('../../../dist/sync/puller');
const { healthAnalysis } = require('../../../dist/analysis/health');
const { roundsAnalysis } = require('../../../dist/analysis/rounds');

function makeEnv(botOver = {}, reportOver = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
  const { config } = parseConfig(
    {
      name: 'analysis',
      oss: { provider: 'ossutil', binary: 'ossutil', endpoint: 'oss-cn-hongkong.aliyuncs.com', bucket: 'dream-ana', prefix: 'snapshot/', configFile: '' },
      sync: { intervalMinutes: 60, minAgeSeconds: 60, countIncludesHeader: false, maxDiskGB: 1, retentionDays: 90, concurrency: 1 },
      process: { nice: 0 },
      runtime: { dataDir: 'data', stateDir: 'runtime', logDir: 'logs' },
      report: { inlineMaxChars: 3500, signTtlHours: 24, ...reportOver },
      bot: {
        type: 'dingtalk',
        appId: 'ding-app',
        appSecret: 'ding-secret',
        allowedStaffIds: ['staff-1'],
        allowedConversationIds: ['cid-1'],
        adminStaffIds: ['staff-1'],
        notify: { warn: 'cid-1' },
        ...botOver,
      },
    },
    { rootDir },
  );
  const logger = createLogger({ level: 'error', sink: () => undefined });
  return { rootDir, config, logger };
}

/** 装一天真分片（含水位线），让分析器有数据可算 */
function installShard(config, instance, date, events, headerOver = {}) {
  const dir = path.join(config.runtime.dataDir, instance);
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'meta', schema: 2, instance, date, final: headerOver.final ?? true, count: events.length });
  const body = [header, ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${date}.jsonl.gz`), zlib.gzipSync(Buffer.from(body, 'utf8')));
  const state = emptyState();
  state.objects[`${config.oss.prefix}${instance}/${date}.jsonl.gz`] = {
    etag: 'E1', size: 100, dataLines: events.length, final: headerOver.final ?? true, pulledAt: new Date().toISOString(), warnings: [],
  };
  saveState(statePathOf(config), state);
}

const msg = (text, over = {}) => ({
  text,
  senderId: 'staff-1',
  senderNick: '大哥',
  conversationId: 'cid-1',
  conversationType: '2',
  platform: 'dingtalk',
  sessionWebhook: 'https://example.invalid/hook',
  ...over,
});

const ROUND_EVENTS = [
  { ts: '2026-10-01T01:00:00.000Z', event: 'NEW_ROUND', symbol: 'ETHFDUSD', roundId: 'R001', localDate: '2026-10-01', seq: 1, data: {} },
  { ts: '2026-10-01T02:00:00.000Z', event: 'SELL_FILLED', symbol: 'ETHFDUSD', roundId: 'R001', localDate: '2026-10-01', seq: 2, data: { profit: 1.5 } },
  { ts: '2026-10-01T03:00:00.000Z', event: 'ROUND_COMPLETED', symbol: 'ETHFDUSD', roundId: 'R001', localDate: '2026-10-01', seq: 3, data: { profit: 1.6, durationHours: 2 } },
];

function makeRouter(env, over = {}) {
  return new CommandRouter({
    config: env.config,
    logger: env.logger,
    now: () => new Date('2026-10-02T12:00:00.000Z'),
    runSyncFn: async () => ({ listed: 2, pulled: ['a'], skipped: 0, ignored: 1, failed: [], bytes: 1234, pruned: [], warnings: [], recomputed: [], deferred: [], whitelistChanges: [], refusedByLock: false }),
    ...over,
  });
}

test('未配置 bot 时构造 router 直接抛（防止"配了却没启"的静默）', () => {
  const env = makeEnv();
  const noBot = { ...env.config, bot: null };
  assert.throws(() => new CommandRouter({ config: noBot, logger: env.logger }), /未配置 bot/);
});

test('whoami 在权限检查之前（否则配白名单时拿不到 ID）', async () => {
  const env = makeEnv({ allowedStaffIds: ['someone-else'], allowedConversationIds: ['other-group'] });
  const router = makeRouter(env);
  const out = await router.handle(msg('whoami'));
  assert.match(out, /平台: dingtalk/);
  assert.match(out, /staffId: staff-1/);
  assert.match(out, /conversationId: cid-1/);
  assert.match(out, /nick: 大哥/);
});

test('群白名单与人员白名单分别拦截（文案要说清怎么办）', async () => {
  const groupDenied = makeRouter(makeEnv({ allowedConversationIds: ['other-group'] }));
  assert.match(await groupDenied.handle(msg('status')), /该群未授权/);

  const staffDenied = makeRouter(makeEnv({ allowedStaffIds: ['someone-else'] }));
  assert.match(await staffDenied.handle(msg('status')), /无权限操作/);

  const open = makeRouter(makeEnv({ allowedStaffIds: [], allowedConversationIds: [] }));
  assert.match(await open.handle(msg('status', { senderId: 'anyone' })), /同步状态/, '白名单为空 = 不拦（启动时会 warn）');
});

test('help / 空消息 / 未知指令', async () => {
  const env = makeEnv();
  const router = makeRouter(env);
  const help = await router.handle(msg('h'));
  assert.match(help, /📋 指令列表/);
  assert.match(help, /whoami/);
  assert.match(help, /rounds \(r\)/);
  assert.match(help, /health \(hc\)/);

  assert.match(await router.handle(msg('')), /📋 指令列表/);
  const unknown = await router.handle(msg('foobar'));
  assert.match(unknown, /未知指令: foobar/);
});

test('status：返回与 CLI 同一份状态文本', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', ROUND_EVENTS);
  const out = await makeRouter(env).handle(msg('status'));
  assert.match(out, /=== 同步状态 ===/);
  assert.match(out, /本地分片: 1 个/);
  assert.match(out, /boye888\s+2026-10-01\s+已封存/);
});

test('sync：管理员限制 + 成功摘要 + 被锁/失败两种文案', async () => {
  const env = makeEnv({ adminStaffIds: ['staff-1'] });
  const ok = await makeRouter(env).handle(msg('sync'));
  assert.match(ok, /同步完成：列举 2 \/ 拉取 1 \/ 跳过 0 \/ 忽略 1 \/ 失败 0 \/ 退避 0/);

  const notAdmin = await makeRouter(makeEnv({ adminStaffIds: ['other'] })).handle(msg('sync'));
  assert.match(notAdmin, /只有管理员能触发同步/);

  const locked = await makeRouter(env, { runSyncFn: async () => ({ refusedByLock: true, listed: 0, pulled: [], skipped: 0, ignored: 0, failed: [], bytes: 0, pruned: [], warnings: [], recomputed: [], deferred: [], whitelistChanges: [] }) }).handle(msg('sync'));
  assert.match(locked, /已有同步在进行/);

  const failed = await makeRouter(env, { runSyncFn: async () => { throw new Error('AccessDenied'); } }).handle(msg('sync'));
  assert.match(failed, /同步失败：AccessDenied/);
});

test('analyze 快捷指令：真分片算出真数（r eth 2026-10-01）', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', ROUND_EVENTS);
  const out = await makeRouter(env).handle(msg('r eth 2026-10-01'));
  assert.match(out, /## 轮次与成交 · 2026-10-01/);
  assert.match(out, /\| ETHFDUSD \| 1 \| 1 \| 0 \|/);
  assert.match(out, /止盈利润合计 1\.50/);
});

test('analyze：a/analyze 形式、未知分析器、非法窗口、没有本地数据', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', ROUND_EVENTS);
  const router = makeRouter(env);

  const viaAnalyze = await router.handle(msg('analyze rounds symbol=eth window=2026-10-01'));
  assert.match(viaAnalyze, /## 轮次与成交/);

  const unknown = await router.handle(msg('analyze nope'));
  assert.match(unknown, /未知分析器: nope/);
  assert.match(unknown, /rounds \(r\)/, '未知分析器要顺手给出可用清单');

  const badWindow = await router.handle(msg('r eth 上周'));
  assert.match(badWindow, /无法解析的窗口写法/);

  const noArgs = await router.handle(msg('analyze'));
  assert.match(noArgs, /用法: analyze <名字>/);

  const empty = makeEnv();
  const noData = await makeRouter(empty).handle(msg('r'));
  assert.match(noData, /本地还没有任何分片/);
});

test('同一会话单并发：慢任务在跑时，第二条指令被拒（不排队）', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const registry = createDefaultRegistry([
    { name: 'slow', aliases: [], help: '慢分析（测试用）', run: async () => { await gate; return { title: 'slow', summary: 'done', warnings: [] }; } },
  ]);
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', ROUND_EVENTS);
  const router = makeRouter(env, { registry, syncReplyBudgetMs: 0 });

  const first = router.handle(msg('analyze slow'));
  const second = await router.handle(msg('analyze slow'));
  assert.match(second, /上一个任务还在跑/);

  release();
  assert.match(await first, /## slow/);
  // 释放后应能再次执行
  release = () => undefined;
  assert.match(await router.handle(msg('analyze slow')), /## slow/);
});

test('慢任务走二次回复：先回"正在分析"，结果稍后单独发（钉钉 SDK 自己 ack，没有 3 秒硬限制）', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const registry = createDefaultRegistry([
    { name: 'slow', aliases: [], help: '慢分析（测试用）', run: async () => { await gate; return { title: 'slow-report', summary: '结果好了', warnings: [] }; } },
  ]);
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', ROUND_EVENTS);
  const sent = [];
  let followedUp;
  const followUpDone = new Promise((r) => {
    followedUp = r;
  });
  const router = makeRouter(env, {
    registry,
    syncReplyBudgetMs: 5,
    reply: async (webhook, text) => {
      sent.push({ webhook, text });
      followedUp();
    },
  });

  const immediate = await router.handle(msg('analyze slow'));
  assert.match(immediate, /⏳ 正在分析 slow/);
  assert.match(immediate, /结果稍后单独发/);
  assert.equal(sent.length, 0, '结果还没出来，不该提前发');

  release();
  await followUpDone;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].webhook, 'https://example.invalid/hook');
  assert.match(sent[0].text, /## slow-report/);

  // 二次回复完成后闸门必须释放（否则这个会话永远不能再发指令）；
  // 此时 gate 已 settled ⇒ 这一轮会直接出结果（不再走"正在分析"）
  const after = await router.handle(msg('analyze slow'));
  assert.ok(!/上一个任务还在跑/.test(after), '闸门没释放：' + after);
  assert.match(after, /## slow-report/);
});

test('报告被截断时：落盘完整报告并给出路径（群里只发摘要）', async () => {
  const env = makeEnv({}, { inlineMaxChars: 200 });
  const events = Array.from({ length: 40 }, (_, i) => ({ ts: `2026-10-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`, event: `EVT_${i}`, symbol: 'ETHFDUSD', localDate: '2026-10-01', seq: i, data: {} }));
  installShard(env.config, 'boye888', '2026-10-01', events);

  const out = await makeRouter(env).handle(msg('hc 2026-10-01'));
  assert.match(out, /已截断/);
  assert.match(out, /完整报告已落盘：logs[\\/]reports[\\/]/);

  const dir = path.join(env.config.runtime.logDir, 'reports');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const full = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.ok(full.length > out.length, '落盘的是完整报告，不是截断后的文本');
});

test('formatAnalysisError：错误 → 群里能看懂的一句话', () => {
  const registry = createDefaultRegistry([healthAnalysis(), roundsAnalysis()]);
  const { AnalysisRunError } = require('../../../dist/analysis/runner');
  const { WindowTooLongError } = require('../../../dist/common/time');
  assert.match(formatAnalysisError(new AnalysisRunError('未知分析器: x', 'unknown-analysis'), 'x', registry), /未知分析器: x[\s\S]*rounds \(r\)/);
  assert.match(formatAnalysisError(new AnalysisRunError('本地还没有任何分片', 'no-data'), 'r', registry), /本地还没有任何分片/);
  assert.match(formatAnalysisError(new WindowTooLongError(1000, 720), 'r', registry), /窗口太长/);
  assert.match(formatAnalysisError(new Error('boom'), 'rounds', registry), /分析 rounds 失败：boom/);
});

test('buildHelpText：由注册表生成，不手写两份', () => {
  const text = buildHelpText(createDefaultRegistry([healthAnalysis(), roundsAnalysis()]));
  assert.match(text, /hc \/ health/);
  assert.match(text, /r \/ rounds/);
  assert.match(text, /health \(hc\)/);
  assert.match(text, /symbol → instance → top/);
});
