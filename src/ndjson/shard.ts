/**
 * 天分片读取（`.jsonl.gz`）：流式解压 → 逐行校验 → 统计。
 *
 * 设计取舍：
 * - **流式**（`createReadStream` + `createGunzip`）：单天分片可能十几 MB，绝不整体读进内存。
 * - **不做随机访问**：gz 不可按字节切片（`DESIGN.md` §3.2 第 3 条），分析器要按天整体过一遍。
 * - **校验只降级为 warning 的一部分**：行数不符/时间越界进 `warnings`（仍入库，报告里标注），
 *   而"解压失败 / 首行不是 header / 文件不存在"是 `errors`（不入库，下轮重试）。
 *   为什么这样分：前者是"数据可疑但仍可用"，后者是"根本读不出来"，处置动作完全不同。
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import { StringDecoder } from 'string_decoder';
import { DATE_RE, DayShardHeader, EventRecord, isEventRecord, isShardHeader, localDateOf } from './types';

/**
 * "已封存分片的前段空白"告警阈值（4 小时）。
 * **这是经验值，不是契约**：上传侧只导尾部 2MB，覆盖多少小时取决于事件密度；
 * 4h 只能抓住"明显只导了后半天"的情形，抓不住"中段整段缺失"（要彻底解决得靠上传侧补 manifest/心跳基准）。
 */
export const EARLY_SEGMENT_THRESHOLD_MS = 4 * 3600_000;

export interface ShardStats {
  filePath: string;
  /** 首行 header；缺失/非法时为 null（同时进 errors） */
  header: DayShardHeader | null;
  /** 有效事件行数（不含 header） */
  dataLines: number;
  /** JSON 解析失败 / 缺必填字段 / ts 非法 的行数 */
  badLines: number;
  /** 空行数（末尾空行属正常，单独计数便于区分"脏"与"正常"） */
  blankLines: number;
  firstTs: string | null;
  lastTs: string | null;
  eventCounts: Record<string, number>;
  symbolCounts: Record<string, number>;
  errors: string[];
  warnings: string[];
  /** errors 为空即 true（warnings 不影响） */
  ok: boolean;
}

export interface ReadShardOptions {
  /** `header.count` 是否把 header 行算在内（上传侧口径，见 env.json.md） */
  countIncludesHeader?: boolean;
  /** 逐事件回调（同步；M2 的分析器在这里聚合） */
  onEvent?: (event: EventRecord, lineNo: number) => void;
}

function emptyStats(filePath: string): ShardStats {
  return {
    filePath,
    header: null,
    dataLines: 0,
    badLines: 0,
    blankLines: 0,
    firstTs: null,
    lastTs: null,
    eventCounts: {},
    symbolCounts: {},
    errors: [],
    warnings: [],
    ok: false,
  };
}

/** 读取并校验一个天分片；**不抛异常**（失败通过 errors 表达，调用方决定重试/跳过） */
export function readShard(filePath: string, opts: ReadShardOptions = {}): Promise<ShardStats> {
  const stats = emptyStats(filePath);
  const countIncludesHeader = opts.countIncludesHeader ?? false;

  if (!fs.existsSync(filePath)) {
    stats.errors.push('文件不存在');
    return Promise.resolve(stats);
  }

  return new Promise<ShardStats>((resolve) => {
    let pending = '';
    const decoder = new StringDecoder('utf8');
    let lineNo = 0;
    let sawHeader = false;
    let headerLineCounted = false;
    const dateMismatch = { n: 0, sample: '' };
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      finalize();
      resolve(stats);
    };

    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      stats.errors.push(msg);
      finalize();
      resolve(stats);
    };

    const handleLine = (raw: string): void => {
      const line = raw.replace(/\r$/, '');
      if (line.trim() === '') {
        stats.blankLines++;
        return;
      }
      lineNo++;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        stats.badLines++;
        if (stats.warnings.length < 20) stats.warnings.push(`第 ${lineNo} 行不是合法 JSON`);
        return;
      }

      if (!sawHeader) {
        if (!isShardHeader(parsed)) {
          fail(`首行不是合法 header（期望 {type:"meta",…}，实际 ${describeShape(parsed)}）`);
          return;
        }
        sawHeader = true;
        stats.header = parsed;
        headerLineCounted = true;
        return;
      }

      if (!isEventRecord(parsed)) {
        stats.badLines++;
        if (stats.warnings.length < 20) stats.warnings.push(`第 ${lineNo} 行不是合法事件行`);
        return;
      }

      stats.dataLines++;
      stats.eventCounts[parsed.event] = (stats.eventCounts[parsed.event] ?? 0) + 1;
      const sym = parsed.symbol ?? '(none)';
      stats.symbolCounts[sym] = (stats.symbolCounts[sym] ?? 0) + 1;
      if (stats.firstTs === null) stats.firstTs = parsed.ts;
      stats.lastTs = parsed.ts;

      if (stats.header) {
        // 日期归属有两层判据，缺一层就会变成"死判据"（第二轮 review 的教训）：
        // (1) **行内自洽**：上传侧盖的 localDate 必须与 ts 按契约时区推算的结果一致
        //     —— 只信 localDate 的话，上传侧把桶日期盖在每行上时这条校验永远不会触发；
        // (2) **与分片日期比对**：优先用 localDate（对外的权威值），缺失才用 ts 推算，±2h 跨夜容差。
        const tsDate = localDateOf(parsed.ts);
        const declared = typeof parsed.localDate === 'string' && DATE_RE.test(parsed.localDate) ? parsed.localDate : null;
        if (declared && tsDate && declared !== tsDate) {
          dateMismatch.n++;
          if (dateMismatch.sample === '') dateMismatch.sample = `ts=${parsed.ts}（推算 ${tsDate}）与 localDate=${declared} 不符`;
        } else {
          const effective = declared ?? tsDate;
          if (effective !== null && effective !== stats.header.date) {
            const eventMs = Date.parse(parsed.ts);
            const dayMs = Date.parse(`${stats.header.date}T00:00:00+08:00`);
            const driftMs = eventMs - dayMs;
            const withinTolerance = Number.isFinite(driftMs) && (driftMs < 0 ? driftMs >= -2 * 3600_000 : driftMs <= 26 * 3600_000);
            if (!withinTolerance) {
              dateMismatch.n++;
              if (dateMismatch.sample === '') dateMismatch.sample = `ts=${parsed.ts}（归属 ${effective}）`;
            }
          }
        }
      }

      if (opts.onEvent) opts.onEvent(parsed, lineNo);
    };

    const finalize = (): void => {
      if (!sawHeader && stats.errors.length === 0) stats.errors.push('文件为空或没有 header 行');

      const header = stats.header;
      if (header && header.count !== undefined) {
        const expected = countIncludesHeader ? header.count - 1 : header.count;
        if (expected !== stats.dataLines) {
          stats.warnings.push(`行数不符：header.count=${header.count}（口径${countIncludesHeader ? '含' : '不含'} header）实际数据行=${stats.dataLines}`);
        }
      }
      if (header && header.firstTs && stats.firstTs && stats.firstTs < header.firstTs) {
        stats.warnings.push(`首条事件早于 header.firstTs（${stats.firstTs} < ${header.firstTs}）`);
      }
      if (header && header.lastTs && stats.lastTs && stats.lastTs > header.lastTs) {
        stats.warnings.push(`末条事件晚于 header.lastTs（${stats.lastTs} > ${header.lastTs}）`);
      }
      if (dateMismatch.n > 0) {
        stats.warnings.push(`${dateMismatch.n} 行的事件日期与 header.date 不一致（例：${dateMismatch.sample}）`);
      }
      // 独立性最弱的那个信号恰恰最重要：header.count/firstTs 都是**上传侧自报**的，
      // 只有"我们自己算出来的首条事件时间"是独立的 —— 已封存的分片却从下午才开始，基本就是
      // "只导出了尾部窗口"（DESIGN §3.4-①）而不是"当天上午真的没事件"。
      if (header && header.final && stats.firstTs) {
        const dayMs = Date.parse(`${header.date}T00:00:00+08:00`);
        const firstMs = Date.parse(stats.firstTs);
        if (Number.isFinite(dayMs) && Number.isFinite(firstMs) && firstMs - dayMs > EARLY_SEGMENT_THRESHOLD_MS) {
          stats.warnings.push(
            `已封存分片（final=true）的首条事件在 ${stats.firstTs}，晚于当天 04:00 —— 当天前段可能没有导出（阈值 4h 是经验值，不是契约；>4h 的空白仍可能漏检）`,
          );
        }
      }
      if (headerLineCounted && stats.dataLines === 0 && stats.badLines === 0) {
        stats.warnings.push('只有 header、没有数据行');
      }
      stats.ok = stats.errors.length === 0;
    };

    const onData = (chunk: Buffer): void => {
      // 必须用 StringDecoder：gunzip 输出块按 16384B 硬切，多字节字符（中文）会被切在两块之间，
      // 用 chunk.toString('utf8') 会各自解成 U+FFFD 且**不报错**（静默数据损坏）。
      pending += decoder.write(chunk);
      let idx: number;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        handleLine(line);
        if (settled) return;
      }
    };

    try {
      const reader = fs.createReadStream(filePath);
      const gunzip = zlib.createGunzip();
      reader.on('error', (err: Error) => fail(`读取失败：${err.message}`));
      gunzip.on('error', (err: Error) => fail(`gzip 解压失败：${err.message}`));
      gunzip.on('data', (chunk: Buffer) => onData(chunk));
      gunzip.on('end', () => {
        if (settled) return;
        pending += decoder.end(); // 收尾：吐出被留住的最后一截多字节序列
        if (pending.trim() !== '') handleLine(pending);
        finish();
      });
      reader.pipe(gunzip);
    } catch (err) {
      fail(`打开文件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

function describeShape(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).slice(0, 5);
    return `object{${keys.join(',')}}`;
  }
  return typeof v;
}
