/**
 * 分析层契约（`Analysis` / `AnalysisResult`）+ 注册表。
 *
 * 三条硬规矩（DESIGN §六）：
 * 1. 分析器是**纯函数**：不读环境变量、不取 `Date.now()`（时钟由 `ctx.now` 注入）、不写盘；
 * 2. `help` 与指令表**由注册表生成**，不手写两份（防漂移）；
 * 3. **数据缺口与"未封存"必须如实报告** —— 不许静默跳过、不许把 `final:false` 的结论当定论。
 */
import { Window } from '../common/time';

/**
 * 单次分析允许的最大窗口（30 天）。**实现只有一处**（`common/time.ts`），
 * 这里 re-export 是为了给 CLI/机器人一个稳定的导入面；并把限制交给 `parseWindow` 在**枚举天数之前**执行。
 */
export { MAX_WINDOW_HOURS } from '../common/time';

/**
 * 裸参数按顺序当作这些参数名（与机器人指令 `r ETH 昨天` 的写法一致）。
 * ⚠️ `window` **不在这里**：长得像窗口的裸参数一律直接当 window（见 `WINDOW_ARG_RE`），
 * 否则 `analyze health 2026-10-02` 会把日期当成币种 —— 这是实测踩过的坑。
 */
export const POSITIONAL_PARAMS = ['symbol', 'instance', 'top'] as const;

/** 一眼可辨的窗口写法（日期 / 区间 / 相对窗口）；命中就优先当 window */
export const WINDOW_ARG_RE = /^(近\d+[hd]|今天|昨天|\d{4}-\d{2}-\d{2}(~\d{4}-\d{2}-\d{2})?)$/i;

export interface Section {
  heading: string;
  headers?: string[];
  rows: string[][];
  /** 表格前的补充说明 */
  note?: string;
}

export interface AnalysisResult {
  title: string;
  /** 1~3 行结论（群里第一眼看到的） */
  summary: string;
  sections?: Section[];
  /** 数据缺口 / 口径变更 / 未封存 —— 必须如实写 */
  warnings: string[];
  /** true = 结论含未封存（final:false）的数据，仅供参考 */
  provisional?: boolean;
}

export interface ParamSpec {
  name: string;
  description: string;
  required?: boolean;
  example?: string;
}

export interface AnalysisContext {
  source: EventSourceLike;
  now: Date;
  window: Window;
  /** 原始参数（已做简单切分；分析器自己校验缺失/非法） */
  params: Record<string, string>;
}

export interface Analysis {
  name: string;
  aliases: string[];
  /** 一行用法说明（自动进 help） */
  help: string;
  params?: ParamSpec[];
  /**
   * 这个分析器允许的最大窗口（小时），默认 `MAX_WINDOW_HOURS`。
   * 例：`stuck` 要回看几个月（卡住轮本来就可能跨越几个月）⇒ 自己声明更大的上限，
   * 否则 `window=近90d` 会先被通用上限拦掉（真数据踩过）。
   */
  maxWindowHours?: number;
  run(ctx: AnalysisContext): Promise<AnalysisResult>;
}

/** 分析器看到的只读事件源（实现见 `src/store/eventSource.ts`） */
export interface LoadedEventLike {
  ts: string;
  event: string;
  symbol?: string;
  roundId?: string;
  data?: Record<string, unknown>;
  instance: string;
  date: string;
  lineNo: number;
}

export interface ScanStats {
  shards: number;
  events: number;
  badLines: number;
  /** 窗口内、按实例应有的本地日里，本地没有分片的那些（如 '2026-10-01'） */
  missingDays: string[];
  /** 扫描到的分片里是否有未封存（final=false）的 */
  provisional: boolean;
  /**
   * **存在但读不出来**的分片（gzip 坏 / 首行不是 header / IO 失败）。
   * 绝不能把它们当成"这天已覆盖、只是没事件" —— 那正是静默低报（M2 review 的 Critical）。
   * 注意：若读取在中途失败，失败前的事件**已经**回调出去了 ⇒ 统计可能不完整，必须配一条告警说清。
   */
  failedShards: Array<{ key: string; errors: string[] }>;
  /** 分片级告警（同步时记下的"行数不符/缺前段" + 本次读取发现的），必须在报告里露出来 */
  shardWarnings: Array<{ key: string; warnings: string[] }>;
}

export interface ShardInfo {
  key: string;
  instance: string;
  date: string;
  filePath: string;
  size: number;
  final: boolean;
  dataLines: number;
  warnings: string[];
}

export interface EventSourceLike {
  instances(): string[];
  shards(instance?: string): ShardInfo[];
  availableDays(instance?: string): string[];
  scan(
    filter: { window: Window; instance?: string; symbol?: string },
    onEvent: (event: LoadedEventLike) => void,
  ): Promise<ScanStats>;
}

/** 从事件 `data` 里安全取数字（外部数据一律校验后再用） */
export function numOf(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 从事件 `data` 里安全取字符串 */
export function strOf(data: Record<string, unknown> | undefined, key: string): string | null {
  const v = data?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

export class AnalysisRegistry {
  private byName = new Map<string, Analysis>();

  register(analysis: Analysis): void {
    const names = [analysis.name, ...analysis.aliases];
    for (const name of names) {
      const key = name.toLowerCase();
      if (this.byName.has(key)) {
        throw new Error(`分析名冲突: "${name}"（已被 ${this.byName.get(key)!.name} 占用）`);
      }
    }
    for (const name of names) this.byName.set(name.toLowerCase(), analysis);
  }

  get(name: string): Analysis | undefined {
    return this.byName.get(name.trim().toLowerCase());
  }

  all(): Analysis[] {
    return [...new Set(this.byName.values())].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 指令表里那一段（由注册表生成，不手写） */
  helpText(): string {
    const lines = ['分析器:'];
    for (const a of this.all()) {
      const alias = a.aliases.length > 0 ? ` (${a.aliases.join('/')})` : '';
      lines.push(`  ${a.name}${alias}  ${a.help}`);
      for (const p of a.params ?? []) {
        lines.push(`      ${p.name}${p.required ? '（必填）' : ''}  ${p.description}${p.example ? ` 例: ${p.example}` : ''}`);
      }
    }
    return lines.join('\n');
  }
}

/** 默认注册表：加分析器 = 在这里挂一行（指令表自动跟着变） */
export function createDefaultRegistry(analyses: Analysis[]): AnalysisRegistry {
  const registry = new AnalysisRegistry();
  for (const a of analyses) registry.register(a);
  return registry;
}
