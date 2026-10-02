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

function buildStore(config: AppConfig): ObjectStore {
  return new OssutilStore({
    binary: config.oss.binary,
    endpoint: config.oss.endpoint,
    bucket: config.oss.bucket,
    configFile: config.oss.configFile || undefined,
  });
}

function buildLogger(config: AppConfig): ILogger {
  return createLogger({
    level: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
    filePath: path.join(config.runtime.logDir, 'analysis.log'),
  });
}

function applyNice(config: AppConfig, logger: ILogger): void {
  const nice = config.process.nice;
  if (!nice) return;
  try {
    os.setPriority(process.pid, nice);
    logger.info('已降低进程优先级（让位于实盘）', { nice });
  } catch (err) {
    logger.warn('设置 nice 失败（Windows 上属正常）', { nice, detail: err instanceof Error ? err.message : String(err) });
  }
}

async function cmdRun(config: AppConfig, logger: ILogger): Promise<number> {
  applyNice(config, logger);
  const store = buildStore(config);
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

async function cmdSync(config: AppConfig, logger: ILogger, force: boolean): Promise<number> {
  const started = Date.now();
  const result = await runSync({ store: buildStore(config), config, logger: logger.child('sync') }, { force });
  console.log(`列举 ${result.listed} 个，拉取 ${result.pulled.length}，跳过 ${result.skipped}，忽略 ${result.ignored}，失败 ${result.failed.length}，共 ${formatBytes(result.bytes)}，耗时 ${formatDurationMs(Date.now() - started)}`);
  for (const f of result.failed) console.error(`  ❌ ${f.key}: ${f.error}`);
  return result.failed.length > 0 ? 1 : 0;
}

/**
 * `verify` / `doctor --deep` 用的临时路径：**故意与同步用的 `.tmp/<instance>/<date>.jsonl.gz` 分开**
 * —— 否则在校验进行中触发同步（或反过来），两边会互相覆盖/删除同一个 tmp 文件，导致一次假失败。
 */
function verifyTmpPathOf(config: AppConfig, instance: string, date: string): string {
  return path.join(config.runtime.dataDir, '.tmp', 'verify', `${instance}-${date}.jsonl.gz`);
}

async function cmdStatus(config: AppConfig): Promise<number> {
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
    const warn = obj.warnings.length > 0 ? `  ⚠️ ${obj.warnings.length} 条告警` : '';
    console.log(`  ${label}  ${flag}  ${formatCount(obj.dataLines)} 行  ${formatBytes(obj.size)}  拉于 ${obj.pulledAt}${warn}`);
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

  const suspects = Object.entries(state.suspects).filter(([, n]) => n > 0);
  if (suspects.length > 0) {
    console.log(`连续失败中的分片: ${suspects.length} 个`);
    for (const [k, n] of suspects.slice(0, 5)) console.log(`  ⚠️ ${k}（已失败 ${n} 次）`);
  }
  return 0;
}

interface CheckResult {
  ok: boolean;
  text: string;
  fatal?: boolean;
}

async function cmdDoctor(config: AppConfig, logger: ILogger, deep: boolean): Promise<number> {
  const store = buildStore(config);
  const checks: CheckResult[] = [];

  checks.push({ ok: true, text: `配置: ${config.name} → ${config.oss.bucket}/${config.oss.prefix} @ ${config.oss.endpoint}` });

  let version = '';
  try {
    version = await (store as OssutilStore).version();
    checks.push({ ok: true, text: `ossutil: ${version || '(版本未知)'} [${config.oss.binary}]` });
  } catch (err) {
    checks.push({ ok: false, fatal: true, text: `ossutil 不可用：${err instanceof Error ? err.message : String(err)}` });
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

async function cmdList(config: AppConfig): Promise<number> {
  const store = buildStore(config);
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

async function cmdVerify(config: AppConfig, key: string): Promise<number> {
  if (!key) {
    console.error('用法: node dist/bin/analysis.js verify <key>（如 snapshot/boye888/2026-10-02.jsonl.gz）');
    return 1;
  }
  if (!parseShardKey(key, config.oss.prefix)) {
    console.error(`键不符合契约（前缀 ${config.oss.prefix}）：${key}`);
    return 1;
  }
  const parsed = parseShardKey(key, config.oss.prefix)!;
  const tmp = verifyTmpPathOf(config, parsed.instance, parsed.date);
  const store = buildStore(config);
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
  sync [--force]     手动拉取一次（--force 忽略 ETag 强制重扫）
  status             数据新鲜度 / 上次同步结果 / 本地分片
  doctor [--deep]    自检（--deep 会下载最新分片做契约核对）
  list               远端对象 vs 本地状态对照
  verify <key>       下载并校验某个分片（不入库、不动水位线）
  help               本说明
`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
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
      return cmdSync(config, logger, argv.includes('--force'));
    case 'status':
      return cmdStatus(config);
    case 'doctor':
      return cmdDoctor(config, logger, argv.includes('--deep'));
    case 'list':
      return cmdList(config);
    case 'verify':
      return cmdVerify(config, argv[1] ?? '');
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

export { main };
