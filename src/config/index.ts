/**
 * `env.json` 解析 + 强校验（fail-fast）。
 *
 * 原则：
 * - **一次报出所有问题**（别让人改一条跑一次）；错误信息里**只出现字段名**，绝不回显值（防凭据泄漏）。
 * - **凭据不在本项目里**：AK/SK 由 `ossutil` 自己的配置文件持有，本项目只读 endpoint/bucket/prefix。
 * - 缺省值只在"确实安全"的地方给（`runtime`/`report`）；关键字段缺失一律报错。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface OssConfig {
  provider: 'ossutil';
  binary: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  /** 空串 = 用 ossutil 默认配置（`~/.ossutilconfig`） */
  configFile: string;
}

export interface SyncConfig {
  intervalMinutes: number;
  minAgeSeconds: number;
  countIncludesHeader: boolean;
  maxDiskGB: number;
  retentionDays: number;
  concurrency: number;
}

export interface BotConfig {
  type: 'dingtalk' | 'lark';
  appId: string;
  appSecret: string;
  allowedStaffIds: string[];
  adminStaffIds: string[];
  notify: { warn: string };
}

export interface AppConfig {
  name: string;
  oss: OssConfig;
  sync: SyncConfig;
  process: { nice: number };
  runtime: { dataDir: string; stateDir: string; logDir: string };
  report: { inlineMaxChars: number; signTtlHours: number };
  /** null = 未配置（M1/M2 不需要机器人，允许为空） */
  bot: BotConfig | null;
  rootDir: string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`配置有问题（${problems.length} 条）：\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'ConfigError';
  }
}

export interface ParseResult {
  config: AppConfig;
  warnings: string[];
}

const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,32}$/;
const ENDPOINT_RE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const PREFIX_RE = /^[A-Za-z0-9!_.*'()/-]*\/$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 纯函数：把 `env.json` 的原始内容变成配置，或抛出 `ConfigError`。
 * `rootDir` 用于把相对目录解析成绝对路径（不依赖 `process.cwd()`，测试可注入）。
 */
export function parseConfig(raw: unknown, opts: { rootDir: string }): ParseResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isObject(raw)) throw new ConfigError(['根节点必须是对象']);

  // ---- name ----
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!NAME_RE.test(name)) problems.push('name 必须是 1~32 位的 [A-Za-z0-9._-]（它决定 pm2 进程名）');

  // ---- oss ----
  const ossRaw = isObject(raw.oss) ? raw.oss : {};
  const provider = ossRaw.provider === undefined ? 'ossutil' : String(ossRaw.provider);
  if (provider !== 'ossutil') problems.push(`oss.provider 目前只支持 "ossutil"（收到 ${provider}）`);

  const binary = typeof ossRaw.binary === 'string' && ossRaw.binary !== '' ? ossRaw.binary : '';
  if (!binary) problems.push('oss.binary 必填（如 "ossutil" 或 "/usr/local/bin/ossutil"）');

  const endpoint = typeof ossRaw.endpoint === 'string' ? ossRaw.endpoint : '';
  if (!endpoint) problems.push('oss.endpoint 必填');
  else if (!ENDPOINT_RE.test(endpoint)) problems.push('oss.endpoint 形如 oss-cn-hongkong.aliyuncs.com（不要带 https:// 和路径）');
  else if (endpoint.includes('-internal') && endpoint.includes('.aliyuncs.com')) {
    warnings.push('oss.endpoint 用的是内网域名 —— 只有阿里云同区域机器能解析（本机开发请改公网域名）');
  }

  const bucket = typeof ossRaw.bucket === 'string' ? ossRaw.bucket : '';
  if (!BUCKET_RE.test(bucket)) problems.push('oss.bucket 必须是合法的 OSS 桶名（小写字母/数字/连字符，3~63 位）');

  const prefix = typeof ossRaw.prefix === 'string' ? ossRaw.prefix : '';
  if (!PREFIX_RE.test(prefix)) problems.push('oss.prefix 必须以 "/" 结尾且只含安全字符（如 "snapshot/"）');
  if (prefix && !prefix.endsWith('/')) problems.push('oss.prefix 必须以 "/" 结尾');

  const configFile = typeof ossRaw.configFile === 'string' ? ossRaw.configFile : '';

  // ---- sync ----
  const syncRaw = isObject(raw.sync) ? raw.sync : {};
  const sync: SyncConfig = {
    intervalMinutes: num(syncRaw.intervalMinutes, 60),
    minAgeSeconds: num(syncRaw.minAgeSeconds, 60),
    countIncludesHeader: bool(syncRaw.countIncludesHeader, false),
    maxDiskGB: num(syncRaw.maxDiskGB, 2),
    retentionDays: num(syncRaw.retentionDays, 90),
    concurrency: num(syncRaw.concurrency, 1),
  };
  if (sync.intervalMinutes < 1 || sync.intervalMinutes > 1440) problems.push('sync.intervalMinutes 应在 1~1440 之间');
  if (sync.minAgeSeconds < 0 || sync.minAgeSeconds > 3600) problems.push('sync.minAgeSeconds 应在 0~3600 之间');
  if (sync.maxDiskGB <= 0) problems.push('sync.maxDiskGB 必须为正数');
  if (sync.retentionDays < 1) problems.push('sync.retentionDays 至少 1 天');
  if (sync.concurrency !== 1) warnings.push('sync.concurrency 建议保持 1（002 上还有实盘，别抢 IO/CPU）');
  if (sync.intervalMinutes < 30) {
    warnings.push('sync.intervalMinutes 小于 30 分钟：当天分片每次重算 ETag 都会变，会反复全量重下（建议与产出同频 = 60）');
  }

  // ---- process / runtime / report ----
  const processRaw = isObject(raw.process) ? raw.process : {};
  const nice = num(processRaw.nice, 10);
  if (nice < 0 || nice > 19) problems.push('process.nice 应在 0~19 之间（正数 = 降优先级）');

  const runtimeRaw = isObject(raw.runtime) ? raw.runtime : {};
  const runtime = {
    dataDir: str(runtimeRaw.dataDir, 'data'),
    stateDir: str(runtimeRaw.stateDir, 'runtime'),
    logDir: str(runtimeRaw.logDir, 'logs'),
  };

  const reportRaw = isObject(raw.report) ? raw.report : {};
  const report = {
    inlineMaxChars: num(reportRaw.inlineMaxChars, 3500),
    signTtlHours: num(reportRaw.signTtlHours, 24),
  };
  if (report.inlineMaxChars < 200) problems.push('report.inlineMaxChars 太小（建议 ≥ 200）');
  if (report.signTtlHours < 1) problems.push('report.signTtlHours 至少 1 小时');

  // ---- bot（可选；三个关键字段要么全空要么全填）----
  let bot: BotConfig | null = null;
  const botRaw = isObject(raw.bot) ? raw.bot : null;
  if (botRaw) {
    const type = String(botRaw.type ?? 'dingtalk');
    const appId = typeof botRaw.appId === 'string' ? botRaw.appId : '';
    const appSecret = typeof botRaw.appSecret === 'string' ? botRaw.appSecret : '';
    const anyFilled = appId !== '' || appSecret !== '' || type !== 'dingtalk';
    if (anyFilled) {
      if (type !== 'dingtalk' && type !== 'lark') problems.push('bot.type 只能是 "dingtalk" 或 "lark"');
      if (!appId) problems.push('bot.appId 必填（填了 appSecret 就必须填 appId）');
      if (!appSecret) problems.push('bot.appSecret 必填');
      const allowedStaffIds = strArray(botRaw.allowedStaffIds, 'bot.allowedStaffIds', problems);
      const adminStaffIds = strArray(botRaw.adminStaffIds, 'bot.adminStaffIds', problems);
      if (allowedStaffIds.length === 0) warnings.push('bot.allowedStaffIds 为空 ⇒ 群内**所有人**都能发指令');
      const notifyRaw = isObject(botRaw.notify) ? botRaw.notify : {};
      bot = { type: type as BotConfig['type'], appId, appSecret, allowedStaffIds, adminStaffIds, notify: { warn: str(notifyRaw.warn, '') } };
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    config: {
      name,
      oss: { provider: 'ossutil', binary, endpoint, bucket, prefix, configFile },
      sync,
      process: { nice },
      runtime: {
        dataDir: path.resolve(opts.rootDir, runtime.dataDir),
        stateDir: path.resolve(opts.rootDir, runtime.stateDir),
        logDir: path.resolve(opts.rootDir, runtime.logDir),
      },
      report,
      bot,
      rootDir: opts.rootDir,
    },
    warnings,
  };
}

/** 读取 `env.json`（默认在仓库根）。文件不存在也报 ConfigError（别用"默认配置"跑起来）。 */
export function loadConfig(opts: { envPath?: string; rootDir: string }): ParseResult {
  const envPath = opts.envPath ?? path.join(opts.rootDir, 'env.json');
  if (!fs.existsSync(envPath)) {
    throw new ConfigError([`找不到配置文件 ${envPath}（从 env.json.example 复制一份）`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  } catch (err) {
    throw new ConfigError([`${envPath} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`]);
  }
  return parseConfig(raw, { rootDir: opts.rootDir });
}

function num(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}
function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}
function str(v: unknown, def: string): string {
  return typeof v === 'string' ? v : def;
}
function strArray(v: unknown, field: string, problems: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    problems.push(`${field} 必须是字符串数组`);
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || item === '') {
      problems.push(`${field} 里有非法项（必须是非空字符串）`);
      continue;
    }
    out.push(item);
  }
  return out;
}
