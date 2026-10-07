/**
 * 指令路由单测（极简版路由器）—— 不碰网络：真分片 + 临时目录。
 * 覆盖：bot 未配置抛错、群/人白名单、未知指令提示、`r` 随时报告的绑定与渲染。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { CommandRouter, REPORT_HINT } = require('../../../dist/bot/router');
const { parseConfig } = require('../../../dist/config/index');
const { createLogger } = require('../../../dist/common/logger');
const { emptyState, saveState, loadState } = require('../../../dist/sync/state');
const { statePathOf } = require('../../../dist/sync/puller');

function makeEnv(botOver = {}, lpOver = { extraAccounts: [] }) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
  const { config } = parseConfig(
    {
      name: 'analysis',
      oss: { provider: 'ossutil', binary: 'ossutil', endpoint: 'oss-cn-hongkong.aliyuncs.com', bucket: 'dream-ana', prefix: 'snapshot/', configFile: '' },
      sync: { intervalMinutes: 60, minAgeSeconds: 60, countIncludesHeader: false, maxDiskGB: 1, retentionDays: 90, concurrency: 1 },
      process: { nice: 0 },
      runtime: { dataDir: 'data', stateDir: 'runtime', logDir: 'logs' },
      report: { inlineMaxChars: 3500, signTtlHours: 24 },
      bot: {
        type: 'dingtalk',
        appId: 'ding-app',
        appSecret: 'ding-secret',
        allowedStaffIds: [],
        allowedConversationIds: [],
        adminStaffIds: [],
        notify: { warn: 'cid-1' },
        ...botOver,
      },
      lp: {
        accounts: [
          {
            instance: 'boye888', label: '你的账户（10 万 U）', principal: 100000,
            conversationId: 'cid-1', dailyHour: 21, dailyMinute: 7,
            dayProfitAlertPct: 0.3, stuckAlertHours: 24,
          },
          {
            instance: 'other000', label: '另一个账户', principal: 50000,
            conversationId: 'cid-other', dailyHour: 21, dailyMinute: 7,
            dayProfitAlertPct: 0.3, stuckAlertHours: 24,
          },
          ...lpOver.extraAccounts,
        ],
      },
    },
    { rootDir },
  );
  const logger = createLogger({ level: 'error', sink: () => undefined });
  return { rootDir, config, logger };
}

/** 装一天真分片（含水位线） */
function installShard(config, instance, date, events, headerOver = {}) {
  const dir = path.join(config.runtime.dataDir, instance);
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'meta', schema: 2, instance, date, final: headerOver.final ?? true, count: events.length });
  const body = [header, ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${date}.jsonl.gz`), zlib.gzipSync(Buffer.from(body, 'utf8')));
  const state = loadState(statePathOf(config)).state;
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
  ...over,
});

const ROUND_EVENTS = [
  { ts: '2026-10-01T01:00:00.000Z', event: 'NEW_ROUND', symbol: 'ETHFDUSD', roundId: 'R001', localDate: '2026-10-01', seq: 1, data: {} },
  { ts: '2026-10-01T02:00:00.000Z', event: 'BUY_FILLED', symbol: 'ETHFDUSD', roundId: 'R001', localDate: '2026-10-01', seq: 2, data: { buyPrice: 2700, accCost: 500 } },
  { ts: '2026-10-01T03:00:00.000Z', event: 'SELL_FILLED', symbol: 'ETHFDUSD', roundId: 'R001', localDate: '2026-10-01', seq: 3, data: { profit: 1.5 } },
  { ts: '2026-10-01T04:00:00.000Z', event: 'ROUND_COMPLETED', symbol: 'ETHFDUSD', roundId: 'R001', localDate: '2026-10-01', seq: 4, data: { profit: 1.6, durationHours: 3 } },
];

function makeRouter(env, over = {}) {
  return new CommandRouter({
    config: env.config,
    logger: env.logger,
    now: () => new Date('2026-10-02T12:00:00.000Z'), // 北京 20:00
    ...over,
  });
}

test('未配置 bot 时构造 router 直接抛（防止"配了却没启"的静默）', () => {
  const env = makeEnv();
  const noBot = { ...env.config, bot: null };
  assert.throws(() => new CommandRouter({ config: noBot, logger: env.logger }), /未配置 bot/);
});

test('空消息 / 未知指令 → 提示发 r（不泄露任何技术指令）', async () => {
  const env = makeEnv();
  const router = makeRouter(env);
  assert.equal(await router.handle(msg('')), REPORT_HINT);
  assert.equal(await router.handle(msg('status')), REPORT_HINT);
  assert.equal(await router.handle(msg('whoami')), REPORT_HINT);
  assert.equal(await router.handle(msg('analyze rounds')), REPORT_HINT);
  assert.equal(await router.handle(msg('随便说说')), REPORT_HINT);
});

test('群白名单 / 人员白名单分别拦截', async () => {
  const env = makeEnv({
    allowedConversationIds: ['cid-1'],
    allowedStaffIds: ['staff-1'],
  });
  const router = makeRouter(env);
  assert.match(await router.handle(msg('r', { conversationId: 'cid- outsider' })), /未授权/);
  assert.match(await router.handle(msg('r', { senderId: 'staff-999' })), /无权限/);
});

test('r：该群未绑定 LP 账户 → 提示找管理员（不渲染别的账户）', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', ROUND_EVENTS);
  installShard(env.config, 'other000', '2026-10-01', ROUND_EVENTS);
  const router = makeRouter(env);
  const text = await router.handle(msg('r', { conversationId: 'cid-unbound' }));
  assert.match(text, /还没绑定账户/);
});

test('r：绑定群渲染 LP 报告（日报同款格式，LP 视角无术语）', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', ROUND_EVENTS);
  installShard(env.config, 'other000', '2026-10-01', ROUND_EVENTS);
  const router = makeRouter(env);
  const text = await router.handle(msg('r'));
  assert.ok(text.includes('【日报】你的账户（10 万 U）'));
  assert.ok(text.includes('今日收益：+$0.00'));
  assert.ok(text.includes('累计收益：+$1.60（+0.00%）'));
  assert.ok(text.includes('正常运作中') || text.includes('持仓等待中'));
  assert.ok(text.includes('数据时间：'));
  // LP 视角：不出现技术指令/术语的残留
  assert.ok(!text.includes('无需任何操作'));
  assert.ok(!text.includes('ATR'));
});

test('r：中文"报告"也算（老人记不住字母时可用）', async () => {
  const env = makeEnv();
  installShard(env.config, 'boye888', '2026-10-01', ROUND_EVENTS);
  const router = makeRouter(env);
  const text = await router.handle(msg('报告'));
  assert.ok(text.includes('【日报】'));
});

test('r：还没有数据 → 友好提示', async () => {
  const env = makeEnv();
  const router = makeRouter(env);
  assert.match(await router.handle(msg('r')), /还没有数据/);
});
