/**
 * `ObjectStore` 的 ossutil 实现。
 *
 * 为什么走 CLI 而不是 SDK：ossutil v1.7.19 已在 `dream-002` 上装好并验证（内网 endpoint 免流量费），
 * 零 npm 依赖；而且排障时运维可以手动跑同一条命令。
 *
 * 两个关键约定：
 * 1. **凭证只从 ossutil 自己的配置文件读**（`-c`，缺省 `~/.ossutilconfig`）——
 *    本项目不接触 AK/SK，日志里也不会出现。
 * 2. **endpoint 从 env.json 显式传 `-e`** —— 让 env.json 成为唯一真源，
 *    不依赖配置文件里恰好写了哪个 endpoint（本机/服务器换域名只改一处）。
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { redactText } from '../common/redact';
import { ObjectMeta, ObjectStore, ObjectStoreError } from './store';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

export interface OssutilStoreOptions {
  binary: string;
  endpoint: string;
  bucket: string;
  configFile?: string;
  /** 测试注入点 */
  exec?: ExecFn;
}

/** 单条命令的输出上限（递归列举一个前缀可能输出几 MB） */
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * 把 `env.json` 里的凭据落成 ossutil 能读的配置文件（0600），返回该文件路径。
 *
 * 为什么不直接 `-i/-k` 传：**命令行参数在 `ps` 里对同机其他用户可见**（Linux 上 `/proc/<pid>/cmdline` 默认可读），
 * 等于把 AK 广播出去。落成一个只有本用户可读的文件、用 `-c` 指过去，就没有这个问题。
 * 内容一致时不重写（避免每次启动都动磁盘/改 mtime）。
 */
export function materializeOssutilCredentials(opts: {
  filePath: string;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
}): string {
  // ★ 段头 `[Credentials]` 不能省：ossutil v1.7 靠它定位凭据段，缺了就报
  //   "Unable to find Credentials" 或 "accessKeyID and ecsUrl are both empty"（2026-10-02 实测踩过）
  const content = `[Credentials]\nlanguage=EN\naccessKeyID=${opts.accessKeyId}\nendpoint=${opts.endpoint}\naccessKeySecret=${opts.accessKeySecret}\n`;
  fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(opts.filePath, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== content) {
    fs.writeFileSync(opts.filePath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(opts.filePath, 0o600); // Windows 上是空操作，Linux 上确保 0600
    } catch {
      // 权限设置失败不该阻止使用（文件仍在本用户目录下）
    }
  }
  return opts.filePath;
}

/**
 * 解析 `ossutil ls` 的长格式输出。
 *
 * 真实样例（v1.7.19，2026-10-02 实测）：
 * ```
 * LastModifiedTime                   Size(B)  StorageClass   ETAG                                  ObjectName
 * 2026-10-02 20:10:49 +0800 CST           63      Standard   FA1765809EB3C61C5C198B86917E2217      oss://dream-ana/snapshot/.keep
 * Object Number is: 1
 * ```
 * **从右往左切**：对象名 / ETAG / StorageClass / Size / 其余为时间。
 * 左切会在"时间里有空格"上翻车；右切只在"对象名含空格"时不可靠，
 * 而契约（`snapshot/<instance>/<date>.jsonl.gz`）不允许空格 —— 且我们**只认匹配正则的键**，不匹配一律忽略 + warn。
 */
export function parseLsOutput(stdout: string): { objects: ObjectMeta[]; unparsed: string[] } {
  const objects: ObjectMeta[] = [];
  const unparsed: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    // 对象行一定含 `oss://`（对象名那一列）；表头与 `Object Number is:` 不含 —— 用这个判据，
    // **不能**用"行首是 oss://"：长格式的行首是时间戳（2026-10-02 20:10:49 +0800 CST …）。
    if (line.indexOf('oss://') < 0) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 8) {
      unparsed.push(line);
      continue;
    }
    const key = parts[parts.length - 1].replace(/^oss:\/\/[^/]+\//, '');
    const etag = parts[parts.length - 2];
    const storageClass = parts[parts.length - 3];
    const sizeStr = parts[parts.length - 4];
    const timeStr = parts.slice(0, parts.length - 4).join(' ');
    const size = Number(sizeStr);
    const looksLikeEtag = /^[0-9A-Za-z-]{8,}$/.test(etag);
    const looksLikeClass = /^[A-Za-z]+$/.test(storageClass);
    if (!Number.isFinite(size) || !looksLikeEtag || !looksLikeClass) {
      unparsed.push(line);
      continue;
    }
    const ms = parseOssTime(timeStr);
    objects.push({
      key,
      size,
      etag,
      lastModified: timeStr,
      lastModifiedMs: ms,
    });
  }
  return { objects, unparsed };
}

/**
 * 解析 OSS 形如 `2026-10-02 20:10:49 +0800 CST` 的时间。
 * 关键点：**按 +0800 时区解释**，不能拿本机时区硬套（服务器 UTC、本机 +08:00 会差 8 小时）。
 */
export function parseOssTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*([+-]\d{4}))?/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  let offsetMinutes = 0;
  if (tz) {
    const sign = tz.startsWith('-') ? -1 : 1;
    offsetMinutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return utc - offsetMinutes * 60_000;
}

export class OssutilStore implements ObjectStore {
  private readonly exec: ExecFn;
  private readonly globalArgs: string[];

  constructor(private readonly opts: OssutilStoreOptions) {
    this.exec = opts.exec ?? defaultExec;
    this.globalArgs = ['-e', opts.endpoint];
    if (opts.configFile) this.globalArgs.push('-c', opts.configFile);
  }

  /** 桶内 URL（`oss://bucket/key`） */
  private url(key = ''): string {
    return `oss://${this.opts.bucket}/${key}`;
  }

  async list(prefix: string): Promise<ObjectMeta[]> {
    const res = await this.run(['ls', this.url(prefix)]);
    if (res.code !== 0) {
      throw new ObjectStoreError(`列举失败（退出码 ${res.code}）`, 'list', redactText(res.stderr.trim()));
    }
    const { objects, unparsed } = parseLsOutput(res.stdout);
    if (unparsed.length > 0) {
      throw new ObjectStoreError(`列举输出有 ${unparsed.length} 行无法解析（ossutil 版本变了？）`, 'list', redactText(unparsed[0]));
    }
    return objects;
  }

  async getTo(key: string, destPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const res = await this.run(['cp', this.url(key), destPath, '-f']);
    if (res.code !== 0) {
      throw new ObjectStoreError(`下载失败（退出码 ${res.code}）`, 'download', redactText((res.stderr || res.stdout).trim()));
    }
    if (!fs.existsSync(destPath)) {
      throw new ObjectStoreError('下载命令成功但目标文件不存在', 'download', destPath);
    }
  }

  /** 自检用：确认 ossutil 可执行且版本可读 */
  async version(): Promise<string> {
    const res = await this.run(['--version']);
    if (res.code !== 0) {
      throw new ObjectStoreError('ossutil 不可用', 'config', redactText(res.stderr.trim()));
    }
    return (res.stdout || res.stderr).trim().split(/\r?\n/)[0] ?? '';
  }

  private run(args: string[]): Promise<ExecResult> {
    return this.exec(this.opts.binary, [...args, ...this.globalArgs]).catch((err: Error) => {
      throw new ObjectStoreError(`无法执行 ${this.opts.binary}`, 'config', redactText(err.message));
    }) as Promise<ExecResult>;
  }
}

/** 默认执行器：不用 shell（避免注入与转义问题），失败也不抛（靠 code/stderr 判断） */
const defaultExec: ExecFn = (file, args) =>
  new Promise<ExecResult>((resolve) => {
    execFile(file, args, { maxBuffer: DEFAULT_MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });
