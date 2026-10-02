/**
 * 极简日志器（零依赖）。
 *
 * 为什么不用 log4js：本服务日志量很小（每小时几行 + 分析摘要），
 * 为了它引一个依赖不划算；而且"绝不打印凭据"这条要靠自己的上下文白名单守住（见 `redact.ts`）。
 * 文件输出失败**绝不影响主流程**（日志是辅助，不是业务）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { logSafeJson } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface ILogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  /** 带模块前缀的子日志器（`sync` / `oss` / `bot` …） */
  child(scope: string): ILogger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 追加写入的文件；父目录自动创建 */
  filePath?: string;
  scope?: string;
  /** 注入时钟（可测性：日志时间戳不该取真实时钟） */
  now?: () => Date;
  /** 测试用：捕获输出而不是打到 console */
  sink?: (line: string, level: LogLevel) => void;
}

export function createLogger(opts: LoggerOptions = {}): ILogger {
  const level = opts.level ?? 'info';
  const now = opts.now ?? (() => new Date());
  const threshold = LEVEL_ORDER[level];

  const emit = (lvl: LogLevel, msg: string, ctx?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const scope = opts.scope ? ` [${opts.scope}]` : '';
    const line = `${now().toISOString()} [${lvl.toUpperCase()}]${scope} ${msg}${ctx ? ' ' + logSafeJson(ctx) : ''}`;

    if (opts.sink) opts.sink(line, lvl);
    else if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);

    if (opts.filePath) {
      try {
        fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
        fs.appendFileSync(opts.filePath, line + '\n', 'utf8');
      } catch {
        // 故意吞掉：日志写失败（磁盘满/权限）不能把同步或分析带崩
      }
    }
  };

  const logger: ILogger = {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (childScope: string) =>
      createLogger({ ...opts, scope: opts.scope ? `${opts.scope}:${childScope}` : childScope }),
  };
  return logger;
}
