#!/usr/bin/env node
/**
 * CLI 入口。命令：
 *   run              常驻：定时同步 + 机器人（配了 bot 段才启）
 *   sync [--force]   手动拉取一次
 *   status           数据新鲜度 / 上次同步结果 / 本地分片
 *   doctor [--deep]  自检（配置 / ossutil / OSS 连通 / 目录；--deep 加契约核对）
 *   list             远端对象 vs 本地状态对照
 *   verify <key>     下载并校验某个分片（不入库、不动水位线）—— 契约核对用
 *   analyses         列出可用分析器
 *   analyze <名字> … 跑一次分析并打印报告
 *
 * 约定：
 * - 所有输出都不含凭据（AK/SK 只在 ossutil 配置文件里，本项目从不打印）；
 * - **状态文案与分析执行都走共享模块**（`report/status.ts`、`analysis/runner.ts`），
 *   与机器人用的是同一份 —— 两边各写一套必然漂移；
 * - 命令函数接受显式依赖（config/logger/store 注入），单测能用假 store + 临时目录真跑一遍。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfig, ConfigError, loadConfig } from '../config';
import { createLogger, ILogger } from '../common/logger';
import { formatBytes } from '../common/format';
import { ObjectStore } from '../oss/store';
import { buildStore } from '../oss/storeFactory';
import { OssutilStore } from '../oss/ossutilStore';
import { runSync, statePathOf } from '../sync/puller';
import { createScheduler } from '../sync/scheduler';
import { loadState, listLocalShards } from '../sync/state';
import { readShard } from '../ndjson/shard';
import { parseShardKey } from '../ndjson/types';
import { createAnalysisRegistry } from '../analysis';
import { parseAnalyzeCommand } from '../analysis/args';
import { AnalysisRunError, runAnalysis } from '../analysis/runner';
import { WindowParseError, WindowTooLongError } from '../common/time';
import { buildStatusText } from '../report/status';
import { DingTalkBot } from '../bot/dingtalk-bot';
import { CommandRouter } from '../bot/router';
import { isConnection } from '../analysis/events';
import { LocalEventSource } from '../store/eventSource';
import { LpReporter } from '../lp/lpReporter';

const ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * "这个/这些分片里有没有连接类事件"的**唯一判词**（doctor --deep 与 verify 共用）。
 * 为什么要共用：曾经 doctor 改成"该分片里没有（稀疏，正常）"、verify 还留着"❌ 未满足，只能降级" ⇒
 * 同一份真分片、同一次会话，两条命令结论互斥（P5 抓到）。
 * ⚠️ 别把它当"契约是否满足"的判据：连接事件本来就稀疏，**absence 是常态** ⇒
 * 单分片判不出来（doctor --deep 另有"本地全部分片累计"那条给基数）。
 */
function connectionEventsNote(events: readonly string[]): string {
  return events.length > 0
    ? events.slice(0, 5).join(',')
    : '该分片里没有（连接事件本来就稀疏；白名单里它们在，不用降级 —— 要看 stream 得跨窗口）';
}

export interface CommandContext {
  config: AppConfig;
  logger: ILogger;
  store: ObjectStore;
}

export function buildContext(config: AppConfig, logger: ILogger): CommandContext {
  return { config, logger, store: buildStore(config) };
}

function buildLogger(config: AppConfig): ILogger {
  return createLogger({
    level: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
    filePath: path.join(config.runtime.logDir, 'analysis.log'),
  });
}

export function applyNice(config: AppConfig, logger: ILogger): void {
  const nice = config.process.nice;
  if (!nice) return;
  try {
    os.setPriority(process.pid, nice);
    logger.info('已降低进程优先级（让位于实盘）', { nice });
  } catch (err) {
    logger.warn('设置 nice 失败（Windows 上属正常）', { nice, detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * `verify` / `doctor --deep` 用的临时路径：**故意与同步用的 `.tmp/<instance>/<date>.jsonl.gz` 分开**
 * —— 否则在校验进行中触发同步（或反过来），两边会互相覆盖/删除同一个 tmp 文件，导致一次假失败。
 */
export function verifyTmpPathOf(config: AppConfig, instance: string, date: string): string {
  return path.join(config.runtime.dataDir, '.tmp', 'verify', `${instance}-${date}.jsonl.gz`);
}

/**
 * 配了 `bot` 段才启机器人；**任何失败都只记日志**（机器人不该有停掉同步/分析的权力）。
 * 这里同时做三件接线：客户端、指令路由、以及"路由怎么二次回复"（绑到客户端的 replyText）。
 */
export function startBotIfConfigured(config: AppConfig, logger: ILogger): DingTalkBot | null {
  const botCfg = config.bot;
  if (!botCfg) {
    logger.info('未配置 bot 段 —— 只跑定时同步（要对话请填 env.json 的 bot 段）');
    return null;
  }
  if (botCfg.type !== 'dingtalk') {
    logger.error('bot.type 目前只实现了 dingtalk，机器人未启动', { type: botCfg.type });
    return null;
  }
  const botLogger = logger.child('bot');
  const bot = new DingTalkBot(
    { clientId: botCfg.appId, clientSecret: botCfg.appSecret, allowedStaffIds: botCfg.allowedStaffIds },
    botLogger,
  );
  const router = new CommandRouter({
    config,
    logger: botLogger,
  });
  bot.setHandler((msg) => router.handle(msg));
  void bot.start().catch((err) => {
    logger.error('机器人启动异常（不影响同步与分析）', { detail: err instanceof Error ? err.message : String(err) });
  });
  return bot;
}

/**
 * 配了 `lp` 段才启 LP 报告；推送走企业机器人（sendGroupMessage），
 * 机器人后启动（botRef 后绑定），未配置 bot 时只渲染不推送并 warn。
 */
export function startLpIfConfigured(
  config: AppConfig,
  logger: ILogger,
  botRef: { bot: DingTalkBot | null },
): LpReporter | null {
  if (!config.lp || config.lp.accounts.length === 0) return null;
  const { state } = loadState(statePathOf(config));
  const source = new LocalEventSource({
    dataDir: config.runtime.dataDir,
    prefix: config.oss.prefix,
    state,
    countIncludesHeader: config.sync.countIncludesHeader,
  });
  const lpLogger = logger.child('lp');
  lpLogger.info('LP 报告已配置', { accounts: config.lp.accounts.map((a) => a.instance) });
  return new LpReporter({
    configLp: config.lp,
    source,
    stateDir: config.runtime.stateDir,
    send: (conversationId, text) => {
      const bot = botRef.bot;
      if (!bot) {
        lpLogger.warn('机器人未启动，LP 消息无法推送（先配 bot 段）');
        return Promise.resolve(false);
      }
      return bot.sendGroupMessage(conversationId, text);
    },
    logger: lpLogger,
  });
}

export async function cmdRun(config: AppConfig, logger: ILogger, store: ObjectStore = buildStore(config)): Promise<number> {
  applyNice(config, logger);
  logger.info('启动常驻服务', {
    name: config.name,
    host: os.hostname(),
    endpoint: config.oss.endpoint,
    bucket: config.oss.bucket,
    prefix: config.oss.prefix,
    intervalMinutes: config.sync.intervalMinutes,
    bot: config.bot ? config.bot.type : null,
    node: process.version,
  });

  const syncLogger = logger.child('sync');
  // LP 报告（A 节奏 + B 触发）：B 触发挂在每次同步之后；botRef 后绑定（机器人下面才启动）
  const botRef: { bot: DingTalkBot | null } = { bot: null };
  const lpReporter = startLpIfConfigured(config, logger, botRef);
  const scheduler = createScheduler({
    intervalMinutes: config.sync.intervalMinutes,
    logger: syncLogger,
    run: async () => {
      await runSync({ store, config, logger: syncLogger });
      if (lpReporter) {
        await lpReporter.runTriggers().catch((err) => {
          logger.error('LP 触发判定异常（不影响同步）', { detail: err instanceof Error ? err.message : String(err) });
        });
      }
    },
  });
  scheduler.start();

  // 先起机器人再跑首次同步：这样同步期间也能回 whoami/status（配置期最常用）
  const bot = startBotIfConfigured(config, logger);
  if (bot) botRef.bot = bot;
  lpReporter?.start();
  await scheduler.triggerNow();

  // 保活：调度器的定时器是 unref 的（它不该单独决定进程生死），这里显式持有一个常驻句柄
  const keepAlive = setInterval(() => undefined, 60_000);
  const shutdown = (signal: string): void => {
    logger.info('收到退出信号，正在停止', { signal });
    scheduler.stop();
    lpReporter?.stop();
    bot?.close?.();
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return 0;
}

export async function cmdSync(ctx: CommandContext, force: boolean): Promise<number> {
  // 手动同步也是"在 002 上跑的分析任务"，同样要让位于实盘（早期版本漏了这一步）
  applyNice(ctx.config, ctx.logger);
  const started = Date.now();
  const result = await runSync({ store: ctx.store, config: ctx.config, logger: ctx.logger.child('sync') }, { force });
  if (result.refusedByLock) {
    console.error('已有同步在进行（可能是常驻进程），本轮未执行；稍后重试即可');
    return 1;
  }
  console.log(`列举 ${result.listed} 个，拉取 ${result.pulled.length}，跳过 ${result.skipped}，忽略 ${result.ignored}，失败 ${result.failed.length}，退避 ${result.deferred.length}，共 ${formatBytes(result.bytes)}，耗时 ${Date.now() - started}ms`);
  for (const c of result.whitelistChanges) console.log(`  ⚠️ 数据口径变更: ${c}`);
  for (const d of result.deferred) console.log(`  ⏸ ${d.key}（已失败 ${d.count} 次）`);
  for (const f of result.failed) console.error(`  ❌ ${f.key}: ${f.error}`);
  return result.failed.length > 0 ? 1 : 0;
}

/** 状态文本与机器人共用（`report/status.ts`）；这里只负责打印 */
export async function cmdStatus(config: AppConfig): Promise<number> {
  console.log(buildStatusText(config, { rootDir: ROOT_DIR }));
  return 0;
}

interface CheckResult {
  ok: boolean;
  text: string;
}

export async function cmdDoctor(ctx: CommandContext, deep: boolean): Promise<number> {
  const { config, store } = ctx;
  const checks: CheckResult[] = [];

  checks.push({ ok: true, text: `配置: ${config.name} → ${config.oss.bucket}/${config.oss.prefix} @ ${config.oss.endpoint}` });

  let version = '';
  try {
    version = typeof (store as OssutilStore).version === 'function' ? await (store as OssutilStore).version() : '(自定义 store，跳过)';
    checks.push({ ok: true, text: `ossutil: ${version || '(版本未知)'} [${config.oss.binary}]` });
  } catch (err) {
    checks.push({ ok: false, text: `ossutil 不可用：${err instanceof Error ? err.message : String(err)}` });
  }

  let metas: Awaited<ReturnType<ObjectStore['list']>> = [];
  try {
    metas = await store.list(config.oss.prefix);
    const matched = metas.filter((m) => parseShardKey(m.key, config.oss.prefix) !== null);
    const unmatched = metas.length - matched.length;
    checks.push({
      ok: true,
      text: `OSS 列举: 前缀下 ${metas.length} 个对象，符合契约 ${matched.length} 个${unmatched > 0 ? `，不符合 ${unmatched} 个（会被忽略）` : ''}`,
    });
  } catch (err) {
    checks.push({ ok: false, text: `OSS 列举失败：${err instanceof Error ? err.message : String(err)}` });
  }

  for (const dir of [config.runtime.dataDir, config.runtime.stateDir, config.runtime.logDir]) {
    const probe = path.join(dir, '.write-probe');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.rmSync(probe, { force: true });
      checks.push({ ok: true, text: `目录可写: ${path.relative(ROOT_DIR, dir) || '.'}` });
    } catch (err) {
      checks.push({ ok: false, text: `目录不可写: ${path.relative(ROOT_DIR, dir)}（${err instanceof Error ? err.message : String(err)}）` });
    }
  }

  const shards = listLocalShards(config.runtime.dataDir);
  checks.push({ ok: true, text: `本地分片: ${shards.length} 个，共 ${formatBytes(shards.reduce((s, x) => s + x.size, 0))}` });

  // 连接类事件是**稀疏**的 ⇒ 拿单个分片判"上传侧有没有导出连接事件"没有检出力（absence 是常态，
  // 会把真故障也说成"不用降级"）。这里改成看**本地全部分片**的累计出现情况，给一个有基数的事实。
  if (deep && shards.length > 0) {
    const connSeen = new Map<string, number>();
    let scanned = 0;
    for (const s of shards) {
      try {
        const st = await readShard(s.filePath, { countIncludesHeader: config.sync.countIncludesHeader });
        scanned++;
        for (const [name, n] of Object.entries(st.eventCounts)) if (isConnection(name)) connSeen.set(name, (connSeen.get(name) ?? 0) + n);
      } catch {
        // 个别分片读不出来时跳过：doctor 的主判据不是它，读失败本身会在其它检查里体现
      }
    }
    const total = [...connSeen.values()].reduce((a, b) => a + b, 0);
    checks.push({
      ok: true,
      text: `连接类事件（本地 ${scanned}/${shards.length} 个分片累计）: ${total} 条` +
        (total === 0
          ? ' —— 一个都没见着：**值得查**（白名单里它们本来就有；也可能是本地分片太少/实例太安静）'
          : `（${[...connSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`).join('、')}）`),
    });
  }

  if (deep) {
    const newest = metas
      .filter((m) => parseShardKey(m.key, config.oss.prefix) !== null)
      .sort((a, b) => a.key.localeCompare(b.key))
      .pop();
    if (!newest) {
      checks.push({ ok: true, text: '契约核对: 前缀下还没有符合契约的对象（等上传侧第一批数据）' });
    } else {
      const parsed = parseShardKey(newest.key, config.oss.prefix);
      if (parsed) {
        const tmp = verifyTmpPathOf(config, parsed.instance, parsed.date);
        try {
          await store.getTo(newest.key, tmp);
          const stats = await readShard(tmp, { countIncludesHeader: config.sync.countIncludesHeader });
          const connEvents = Object.keys(stats.eventCounts).filter((e) => isConnection(e));
          checks.push({
            ok: stats.ok,
            text: `契约核对 ${newest.key}: header=${stats.header ? `final=${stats.header.final} count=${stats.header.count ?? '未提供'} schema=${stats.header.schema}` : '缺失'}，数据行=${stats.dataLines}，坏行=${stats.badLines}，事件种类=${Object.keys(stats.eventCounts).length}，连接类事件=${connectionEventsNote(connEvents)}`,
          });
          for (const w of stats.warnings.slice(0, 5)) checks.push({ ok: true, text: `   ⚠️ ${w}` });
          for (const e of stats.errors) checks.push({ ok: false, text: `   ❌ ${e}` });
          fs.rmSync(tmp, { force: true });
        } catch (err) {
          checks.push({ ok: false, text: `契约核对失败（下载 ${newest.key}）：${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }
  }

  let allOk = true;
  console.log('=== doctor ===');
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`${c.ok ? '✅' : '❌'} ${c.text}`);
  }
  console.log(allOk ? '结论: 全部通过' : '结论: 有问题，见上面 ❌');
  return allOk ? 0 : 1;
}

export async function cmdList(ctx: CommandContext): Promise<number> {
  const { config, store } = ctx;
  const { state } = loadState(statePathOf(config));
  const metas = await store.list(config.oss.prefix);
  console.log(`远端 ${metas.length} 个对象：`);
  for (const m of metas.sort((a, b) => a.key.localeCompare(b.key))) {
    const parsed = parseShardKey(m.key, config.oss.prefix);
    const known = state.objects[m.key];
    const mark = !parsed ? '✗ 不符合契约' : !known ? '· 本地没有' : known.etag === m.etag ? '✓ 已同步' : '↻ 远端已变（待重拉）';
    console.log(`  ${mark}  ${m.key}  ${formatBytes(m.size)}  etag=${m.etag.slice(0, 8)}  ${m.lastModified}`);
  }
  return 0;
}

export async function cmdVerify(ctx: CommandContext, key: string): Promise<number> {
  const { config, store } = ctx;
  if (!key) {
    console.error('用法: node dist/bin/analysis.js verify <key>（如 snapshot/boye888/2026-10-02.jsonl.gz）');
    return 1;
  }
  const parsed = parseShardKey(key, config.oss.prefix);
  if (!parsed) {
    console.error(`键不符合契约（前缀 ${config.oss.prefix}）：${key}`);
    return 1;
  }
  const tmp = verifyTmpPathOf(config, parsed.instance, parsed.date);
  await store.getTo(key, tmp);
  const stats = await readShard(tmp, { countIncludesHeader: config.sync.countIncludesHeader });
  fs.rmSync(tmp, { force: true });

  const h = stats.header;
  console.log(`=== verify ${key} ===`);
  console.log(`header: ${h ? `schema=${h.schema} instance=${h.instance} date=${h.date} final=${h.final} count=${h.count ?? '(未提供)'} firstTs=${h.firstTs ?? '-'} lastTs=${h.lastTs ?? '-'} whitelistVersion=${h.whitelistVersion ?? '(未提供)'}` : '缺失/非法'}`);
  console.log(`数据行=${stats.dataLines} 坏行=${stats.badLines} 空行=${stats.blankLines} 首事件=${stats.firstTs ?? '-'} 末事件=${stats.lastTs ?? '-'}`);
  const top = Object.entries(stats.eventCounts).sort((a, b) => b[1] - a[1]);
  console.log(`事件种类=${top.length}：`);
  for (const [name, n] of top.slice(0, 15)) console.log(`  ${String(n).padStart(7)}  ${name}`);
  const symbols = Object.entries(stats.symbolCounts).sort((a, b) => b[1] - a[1]);
  console.log(`symbol 分布: ${symbols.slice(0, 10).map(([s, n]) => `${s}=${n}`).join(' ')}`);
  const conn = top.filter(([name]) => isConnection(name));
  // 与 doctor --deep 用**同一句**判词（`connectionEventsNote`）：同一个分片在两个命令里必须给同一结论
  console.log(`连接类事件（断流分析依赖）: ${conn.length > 0 ? conn.map(([n, c]) => `${n}=${c}`).join(' ') : connectionEventsNote([])}`);
  for (const w of stats.warnings) console.log(`⚠️  ${w}`);
  for (const e of stats.errors) console.log(`❌ ${e}`);
  console.log(stats.ok ? '结论: 校验通过' : '结论: 校验失败（该分片不会被入库）');
  return stats.ok ? 0 : 1;
}

/** LP 报告调试：daily 渲染日报 / triggers 跑触发判定。只打印不推送（send 桩返回 false）。 */
export async function cmdLp(config: AppConfig, logger: ILogger, sub: string, args: string[]): Promise<number> {
  if (!config.lp || config.lp.accounts.length === 0) {
    console.error('未配置 lp 段（env.json 里加 lp.accounts 再试）');
    return 1;
  }
  const instanceArg = args[0];
  const sendFlag = args.includes('--send');
  const { state } = loadState(statePathOf(config));
  const source = new LocalEventSource({
    dataDir: config.runtime.dataDir,
    prefix: config.oss.prefix,
    state,
    countIncludesHeader: config.sync.countIncludesHeader,
  });
  const sentLog: Array<{ cid: string; text: string }> = [];
  // --send：真发（走企业机器人 sendGroupMessage）；不带则只渲染
  let bot: DingTalkBot | null = null;
  if (sendFlag) {
    if (!config.bot || config.bot.type !== 'dingtalk') {
      console.error('--send 需要配置 bot 段（dingtalk clientId/clientSecret）');
      return 1;
    }
    bot = new DingTalkBot(
      { clientId: config.bot.appId, clientSecret: config.bot.appSecret, allowedStaffIds: config.bot.allowedStaffIds },
      logger.child('bot'),
    );
  }
  const reporter = new LpReporter({
    configLp: config.lp,
    source,
    stateDir: config.runtime.stateDir,
    send: async (cid, text) => {
      if (!bot) { sentLog.push({ cid, text }); return false; }
      return bot.sendGroupMessage(cid, text);
    },
    logger,
  });
  if (sub === 'daily') {
    const results = await reporter.runDaily(instanceArg);
    if (results.length === 0) { console.log('（没有可生成的日报：检查实例名与本地数据）'); return 1; }
    for (const r of results) {
      console.log(`========== LP 日报（${r.sent ? '已发送' : '未发送'}） ==========`);
      console.log(r.text);
    }
    return 0;
  }
  if (sub === 'triggers') {
    const results = await reporter.runTriggers();
    if (results.length === 0) { console.log('（无新触发；已触发的记录在 stateDir/lp-reporter-state.json，不重复推送）'); return 0; }
    for (const r of results) {
      for (const h of r.hits) {
        console.log(`========== 触发 ${r.account} / ${h.kind}（未发送） ==========`);
        console.log(h.message);
      }
    }
    return 0;
  }
  console.error(`未知 lp 子命令: ${sub}（支持 daily / triggers）`);
  return 1;
}

export function cmdAnalyses(): number {
  const registry = createAnalysisRegistry();
  console.log(registry.helpText());
  console.log('\n用法: node dist/bin/analysis.js analyze <名字> [symbol] [window] [instance] [top=N]');
  console.log('      裸参数里长得像窗口的（2026-10-01 / 昨天 / 近24h / 2026-10-01~2026-10-03）一律当 window；');
  console.log('      其余裸参数按 symbol → instance → top 的顺序填，多出来的忽略。key=value 写法永远优先。');
  console.log('例:   node dist/bin/analysis.js analyze r eth 昨天');
  console.log('      node dist/bin/analysis.js analyze health instance=boye888 window=近24h');
  return 0;
}

export async function cmdAnalyze(config: AppConfig, logger: ILogger, name: string, params: Record<string, string>): Promise<number> {
  const registry = createAnalysisRegistry();
  try {
    const out = await runAnalysis({ config, name, params, registry });
    console.log(out.rendered.text);
    if (out.rendered.truncated) logger.warn('报告超长已截断', { maxChars: config.report.inlineMaxChars });
    logger.debug('分析完成', { analysis: out.analysis.name, ms: out.elapsedMs, warnings: out.result.warnings.length });
    return 0;
  } catch (err) {
    if (err instanceof AnalysisRunError) {
      console.error(err.message);
      if (err.kind === 'unknown-analysis') console.error(registry.helpText());
      return 1;
    }
    if (err instanceof WindowParseError || err instanceof WindowTooLongError) {
      console.error(err.message);
      return 1;
    }
    console.error(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function usage(): void {
  console.log(`dream-analysis CLI

用法: node dist/bin/analysis.js <命令> [参数]

命令:
  run                常驻：定时同步 + 机器人（配了 bot 段才启）
  sync [--force]     手动拉取一次（--force 忽略 ETag/静默期强制重扫）
  status             数据新鲜度 / 上次同步结果 / 本地分片
  doctor [--deep]    自检（--deep 会下载最新分片做契约核对）
  list               远端对象 vs 本地状态对照
  verify <key>       下载并校验某个分片（不入库、不动水位线）
  analyses           列出可用分析器（含参数说明）
  analyze <名字> [symbol] [window] [instance] [top=N]
                     跑一次分析并打印报告（长得像窗口的裸参数一律当 window）
  help               本说明
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  }

  let config: AppConfig;
  let warnings: string[];
  try {
    const loaded = loadConfig({ rootDir: ROOT_DIR });
    config = loaded.config;
    warnings = loaded.warnings;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const logger = buildLogger(config);
  for (const w of warnings) logger.warn('配置提醒', { detail: w });

  switch (command) {
    case 'run':
      return cmdRun(config, logger);
    case 'sync':
      return cmdSync(buildContext(config, logger), argv.includes('--force'));
    case 'status':
      return cmdStatus(config);
    case 'doctor':
      return cmdDoctor(buildContext(config, logger), argv.includes('--deep'));
    case 'list':
      return cmdList(buildContext(config, logger));
    case 'verify':
      return cmdVerify(buildContext(config, logger), argv[1] ?? '');
    case 'analyses':
      return cmdAnalyses();
    case 'lp':
      return cmdLp(config, logger, argv[1] ?? 'daily', argv.slice(2));
    case 'analyze': {
      // tokens[0] = 分析器名；位置参数顺序按该分析器自己声明的 params 决定
      const parsed = parseAnalyzeCommand(argv.slice(1), (n) => createAnalysisRegistry().get(n));
      if (!parsed.name) {
        console.error('用法: analyze <名字> [symbol] [window] [key=value ...]');
        console.error(createAnalysisRegistry().helpText());
        return 1;
      }
      return cmdAnalyze(config, logger, parsed.name, parsed.params);
    }
    default:
      console.error(`未知命令: ${command}`);
      usage();
      return 1;
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`执行失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

export { ROOT_DIR };
