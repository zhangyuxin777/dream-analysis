#!/usr/bin/env node
/**
 * CLI 入口。命令：
 *   run              常驻：定时同步（M3 起再挂机器人）
 *   sync [--force]   手动拉取一次
 *   status           数据新鲜度 / 上次同步结果 / 本地分片
 *   doctor [--deep]  自检（配置 / ossutil / OSS 连通 / 目录 / 新鲜度；--deep 加契约核对）
 *   list             远端对象 vs 本地状态对照
 *   verify <key>     下载并校验某个分片（不入库、不动水位线）—— 契约核对用
 *
 * 约定：所有输出都不含凭据（AK/SK 只存在于 ossutil 配置文件里，本项目从不读取）。
 * 可测性：命令函数接受显式 `CommandContext`（config/logger/store 全部注入），
 * 单测可以用假 store + 临时目录把每条命令真正跑一遍，而不是只测参数解析。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfig, ConfigError, loadConfig } from '../config';
import { createLogger, ILogger } from '../common/logger';
import { formatBytes, formatCount, formatDurationMs } from '../common/format';
import { OssutilStore } from '../oss/ossutilStore';
import { ObjectStore } from '../oss/store';
import { runSync, statePathOf } from '../sync/puller';
import { createScheduler } from '../sync/scheduler';
import { loadState, listLocalShards } from '../sync/state';
import { readShard } from '../ndjson/shard';
import { parseShardKey } from '../ndjson/types';

const ROOT_DIR = path.resolve(__dirname, '..', '..');
/** 连接类稀疏事件的前缀：契约核对里要确认上传侧把它们放进来了（DESIGN §3.4-③） */
const CONNECTION_EVENT_PREFIXES = ['UDS_', 'MARKET_STREAM_', 'WORKER_WS_', 'ORDER_CANCELED'];

export interface CommandContext {
  config: AppConfig;
  logger: ILogger;
  store: ObjectStore;
}

export function buildStore(config: AppConfig): ObjectStore {
  return new OssutilStore({
    binary: config.oss.binary,
    endpoint: config.oss.endpoint,
    bucket: config.oss.bucket,
    configFile: config.oss.configFile || undefined,
  });
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

export async function cmdRun(config: AppConfig, logger: ILogger, store: ObjectStore = buildStore(config)): Promise<number> {
  applyNice(config, logger);
  logger.info('启动常驻服务', {
    name: config.name,
    host: os.hostname(),
    endpoint: config.oss.endpoint,
    bucket: config.oss.bucket,
    prefix: config.oss.prefix,
    intervalMinutes: config.sync.intervalMinutes,
    node: process.version,
  });

  const syncLogger = logger.child('sync');
  const scheduler = createScheduler({
    intervalMinutes: config.sync.intervalMinutes,
    logger: syncLogger,
    run: () => runSync({ store, config, logger: syncLogger }),
  });
  scheduler.start();
  await scheduler.triggerNow();

  // 保活：调度器的定时器是 unref 的（它不该单独决定进程生死），这里显式持有一个常驻句柄
  const keepAlive = setInterval(() => undefined, 60_000);
  const shutdown = (signal: string): void => {
    logger.info('收到退出信号，正在停止', { signal });
    scheduler.stop();
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
  console.log(`列举 ${result.listed} 个，拉取 ${result.pulled.length}，跳过 ${result.skipped}，忽略 ${result.ignored}，失败 ${result.failed.length}，退避 ${result.deferred.length}，共 ${formatBytes(result.bytes)}，耗时 ${formatDurationMs(Date.now() - started)}`);
  for (const c of result.whitelistChanges) console.log(`  ⚠️ 数据口径变更: ${c}`);
  for (const d of result.deferred) console.log(`  ⏸ ${d.key}（已失败 ${d.count} 次，约 ${formatDurationMs(d.retryAfterMs)} 后重试）`);
  for (const f of result.failed) console.error(`  ❌ ${f.key}: ${f.error}`);
  return result.failed.length > 0 ? 1 : 0;
}

export async function cmdStatus(config: AppConfig): Promise<number> {
  const stateFile = statePathOf(config);
  const { state, warnings } = loadState(stateFile);
  for (const w of warnings) console.warn(`⚠️  ${w}`);

  console.log('=== 同步状态 ===');
  console.log(`状态文件: ${path.relative(ROOT_DIR, stateFile)}`);
  if (!state.lastRun) {
    console.log('上次同步: 从未跑过（先执行 npm run sync）');
  } else {
    const r = state.lastRun;
    const dur = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
    console.log(
      `上次同步: ${r.finishedAt} 用时 ${formatDurationMs(dur)} | 列举 ${r.listed} / 拉取 ${r.pulled} / 跳过 ${r.skipped} / 忽略 ${r.ignored} / 失败 ${r.failed} (${formatBytes(r.bytes)})`,
    );
    if (r.refusedByLock) console.log('  本轮因"已有同步在进行"被跳过（跨进程互斥）');
    if (r.deferred) console.log(`  退避中: ${r.deferred} 个分片（同内容按 30min×2^n 退避，换内容立刻重试）`);
    for (const c of r.whitelistChanges ?? []) console.log(`  ⚠️ 数据口径变更: ${c}`);
    for (const e of r.errors.slice(0, 5)) console.log(`  ❌ ${e}`);
  }

  const shards = listLocalShards(config.runtime.dataDir);
  const total = shards.reduce((s, x) => s + x.size, 0);
  console.log(`本地分片: ${shards.length} 个，共 ${formatBytes(total)}`);
  const entries = Object.entries(state.objects).sort((a, b) => b[0].localeCompare(a[0]));
  for (const [key, obj] of entries.slice(0, 20)) {
    const parsed = parseShardKey(key, config.oss.prefix);
    const label = parsed ? `${parsed.instance.padEnd(10)} ${parsed.date}` : key;
    const flag = obj.final ? '已封存' : '未封存';
    const wl = obj.whitelistVersion ? `  口径=${obj.whitelistVersion}` : '';
    const warn = obj.warnings.length > 0 ? `  ⚠️ ${obj.warnings.length} 条告警` : '';
    console.log(`  ${label}  ${flag}  ${formatCount(obj.dataLines)} 行  ${formatBytes(obj.size)}  拉于 ${obj.pulledAt}${wl}${warn}`);
  }
  if (entries.length > 20) console.log(`  … 另有 ${entries.length - 20} 条`);

  const latestFinal = entries
    .filter(([, o]) => o.final)
    .map(([k]) => parseShardKey(k, config.oss.prefix)?.date ?? '')
    .filter((d) => d !== '')
    .sort()
    .pop();
  const todayShanghai = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  if (latestFinal) {
    const lagDays = Math.round((Date.parse(`${todayShanghai}T00:00:00Z`) - Date.parse(`${latestFinal}T00:00:00Z`)) / 86400_000);
    console.log(`已封存最新日期: ${latestFinal}（今天 ${todayShanghai}，落后 ${lagDays} 天）`);
    if (lagDays > 2) console.warn('⚠️  数据落后超过 2 天 —— 上游导出或本服务同步可能停了');
  } else {
    console.log('还没有已封存的分片（final=true）');
  }

  const suspects = Object.entries(state.suspects).filter(([, s]) => s.count > 0);
  if (suspects.length > 0) {
    console.log(`失败退避中的分片: ${suspects.length} 个`);
    for (const [k, s] of suspects.slice(0, 5)) console.log(`  ⏸ ${k}（已失败 ${s.count} 次，最后失败于 ${s.lastErrorAt}）`);
  }
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
      checks.push({ ok: true, text: `目录可写: ${path.relative(ROOT_DIR, dir)}` });
    } catch (err) {
      checks.push({ ok: false, text: `目录不可写: ${path.relative(ROOT_DIR, dir)}（${err instanceof Error ? err.message : String(err)}）` });
    }
  }

  const shards = listLocalShards(config.runtime.dataDir);
  checks.push({ ok: true, text: `本地分片: ${shards.length} 个，共 ${formatBytes(shards.reduce((s, x) => s + x.size, 0))}` });

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
          const connEvents = Object.keys(stats.eventCounts).filter((e) => CONNECTION_EVENT_PREFIXES.some((p) => e === p || e.startsWith(p)));
          checks.push({
            ok: stats.ok,
            text: `契约核对 ${newest.key}: header=${stats.header ? `final=${stats.header.final} count=${stats.header.count ?? '未提供'} schema=${stats.header.schema}` : '缺失'}，数据行=${stats.dataLines}，坏行=${stats.badLines}，事件种类=${Object.keys(stats.eventCounts).length}，连接类事件=${connEvents.length > 0 ? connEvents.slice(0, 5).join(',') : '无（③ 未满足，断流分析将降级）'}`,
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
  const conn = top.filter(([name]) => CONNECTION_EVENT_PREFIXES.some((p) => name === p || name.startsWith(p)));
  console.log(`连接类事件（断流分析依赖）: ${conn.length > 0 ? conn.map(([n, c]) => `${n}=${c}`).join(' ') : '❌ 无 —— DESIGN §3.4-③ 未满足，断流分析只能降级'}`);
  for (const w of stats.warnings) console.log(`⚠️  ${w}`);
  for (const e of stats.errors) console.log(`❌ ${e}`);
  console.log(stats.ok ? '结论: 校验通过' : '结论: 校验失败（该分片不会被入库）');
  return stats.ok ? 0 : 1;
}

function usage(): void {
  console.log(`dream-analysis CLI

用法: node dist/bin/analysis.js <命令> [参数]

命令:
  run                常驻：定时同步（启动立即跑一次）
  sync [--force]     手动拉取一次（--force 忽略 ETag/静默期强制重扫）
  status             数据新鲜度 / 上次同步结果 / 本地分片
  doctor [--deep]    自检（--deep 会下载最新分片做契约核对）
  list               远端对象 vs 本地状态对照
  verify <key>       下载并校验某个分片（不入库、不动水位线）
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

export { ROOT_DIR, CONNECTION_EVENT_PREFIXES };
