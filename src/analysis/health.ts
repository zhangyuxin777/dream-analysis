/**
 * `health` 分析器（别名 `hc`）：这份数据本身健不健康 + 程序有没有停摆。
 *
 * 判据来源（全部来自事件，不含任何外部状态）：
 * - **数据完整性**：窗口覆盖的本地日里缺哪几天（缺口必须出现在结果里）
 * - **事件密度**：总事件数 / 分片数 / 窗口时长
 * - **心跳**：`ACCOUNT_OBSERVED` 是账户级观测（上传侧每小时跑一次），把它当"程序还活着"的脉搏；
 *   相邻两条间隔超过阈值 ⇒ 疑似停摆/断流。**注意**：白名单当前不一定包含 `UDS_*`/`MARKET_STREAM_*`，
 *   所以这里只能报"疑似停摆"，分不清断流、停机还是单纯没成交 —— 这句话必须写进结论里，别让人误读。
 * - **异常计数**：事件名命中 `_ERROR/_FAILED/UNRECOVERED/_ALERT` 的按类型计数
 */
import { Analysis, AnalysisContext, AnalysisResult, MAX_WINDOW_HOURS, Section, numOf, strOf } from './types';
import { formatShanghai, windowHours } from '../common/time';

const ERROR_EVENT_RE = /(_ERROR|_FAILED|UNRECOVERED|_ALERT)$/;
/**
 * 配置回显类事件（每次启动各打一遍：`WORKER_CONFIG_*` / `WORKER_ENV_*`）。
 *
 * **只在展示层折叠**，原始行一行不少地留在分片里 —— 参数溯源、崩溃环排查都要靠它们。
 * 为什么不在导出侧做去重：那是把一个**可逆、可解释的展示问题**，变成**不可逆、要写契约、要维护状态的存储问题**
 * （"缺失 = 未变"这个语义对条件发射类事件还不成立）。层次错了，再省也只有 6.5% 的行数（gzip 后约 0.3KB/天）。
 * 这条是上传侧给的结论，我认：降噪属于"读的时候怎么呈现"。
 */
export const ECHO_EVENT_RE = /^WORKER_(CONFIG|ENV)_/;
/** 心跳间隔超过这个值 ⇒ 疑似停摆（上传侧每小时一次观测，2 小时足够宽松） */
export const HEARTBEAT_GAP_ALERT_MS = 2 * 3_600_000;

export interface InstanceHeartbeat {
  instance: string;
  count: number;
  lastMs: number;
  maxGapMs: number | null;
  lastTotalValue: number | null;
  lastExchange: string | null;
}

export interface HealthTotals {
  events: number;
  shards: number;
  badLines: number;
  firstTs: number | null;
  lastTs: number | null;
  eventCounts: Map<string, number>;
  symbolCounts: Map<string, number>;
  errorCounts: Map<string, number>;
  heartbeatCount: number;
  heartbeatMaxGapMs: number | null;
  /** 最大间隔出现在哪个实例（多实例混成一条游标会既漏报又错值 —— M2 review 的 Warning） */
  heartbeatWorstInstance: string | null;
  heartbeats: Map<string, InstanceHeartbeat>;
  /** 最近一次观测的估值（按"最新那条心跳"取，而不是扫描顺序里最后一条） */
  lastTotalValue: number | null;
  lastExchange: string | null;
}

/** 计数降序 + 名字升序（并列时顺序必须确定，否则同一份数据两次跑出的报告可能不一样） */
function byCountThenName(a: [string, number], b: [string, number]): number {
  return b[1] - a[1] || a[0].localeCompare(b[0]);
}

export function healthAnalysis(): Analysis {
  return {
    name: 'health',
    aliases: ['hc'],
    help: '数据新鲜度 / 事件密度 / 心跳缺口 / 异常计数',
    params: [
      { name: 'instance', description: '实例名（默认全部实例）', example: 'boye888' },
      { name: 'window', description: `时间窗口（最长 ${MAX_WINDOW_HOURS}h）`, example: '昨天' },
    ],
    async run(ctx: AnalysisContext): Promise<AnalysisResult> {
      const totals: HealthTotals = {
        events: 0, shards: 0, badLines: 0, firstTs: null, lastTs: null,
        eventCounts: new Map(), symbolCounts: new Map(), errorCounts: new Map(),
        heartbeatCount: 0, heartbeatMaxGapMs: null, heartbeatWorstInstance: null, heartbeats: new Map(),
        lastTotalValue: null, lastExchange: null,
      };

      const stats = await ctx.source.scan({ window: ctx.window, instance: ctx.params.instance }, (e) => {
        totals.events++;
        totals.eventCounts.set(e.event, (totals.eventCounts.get(e.event) ?? 0) + 1);
        const symbol = e.symbol ?? '(无 symbol)';
        totals.symbolCounts.set(symbol, (totals.symbolCounts.get(symbol) ?? 0) + 1);
        if (ERROR_EVENT_RE.test(e.event)) totals.errorCounts.set(e.event, (totals.errorCounts.get(e.event) ?? 0) + 1);

        const ms = Date.parse(e.ts);
        if (totals.firstTs === null || ms < totals.firstTs) totals.firstTs = ms;
        if (totals.lastTs === null || ms > totals.lastTs) totals.lastTs = ms;

        if (e.event === 'ACCOUNT_OBSERVED') {
          totals.heartbeatCount++;
          // 按实例各记一条游标：多实例混成一条会把"实例 A 停了 5 小时"和"实例 B 正常"互相抵消
          const hb: InstanceHeartbeat = totals.heartbeats.get(e.instance) ?? {
            instance: e.instance, count: 0, lastMs: 0, maxGapMs: null, lastTotalValue: null, lastExchange: null,
          };
          hb.count++;
          if (hb.lastMs > 0) {
            const gap = ms - hb.lastMs;
            if (hb.maxGapMs === null || gap > hb.maxGapMs) hb.maxGapMs = gap;
          }
          hb.lastMs = ms;
          const value = numOf(e.data, 'totalValue');
          if (value !== null) hb.lastTotalValue = value;
          const exchange = strOf(e.data, 'exchange');
          if (exchange) hb.lastExchange = exchange;
          totals.heartbeats.set(e.instance, hb);

          if (hb.maxGapMs !== null && (totals.heartbeatMaxGapMs === null || hb.maxGapMs > totals.heartbeatMaxGapMs)) {
            totals.heartbeatMaxGapMs = hb.maxGapMs;
            totals.heartbeatWorstInstance = e.instance;
          }
        }
      });
      totals.shards = stats.shards;
      totals.badLines = stats.badLines;

      // "最近账户估值"取**最新那条心跳**（而不是扫描顺序里最后一条，否则会显示几小时前的旧值）
      const latest = [...totals.heartbeats.values()].sort((a, b) => b.lastMs - a.lastMs)[0];
      if (latest) {
        totals.lastTotalValue = latest.lastTotalValue;
        totals.lastExchange = latest.lastExchange;
      }

      const warnings: string[] = [];
      if (stats.missingDays.length > 0) {
        warnings.push(`窗口内缺 ${stats.missingDays.length} 天的本地数据: ${stats.missingDays.join(', ')}（结果按现有数据算，不要把缺口当成"没有异常"）`);
      }
      if (stats.failedShards.length > 0) {
        warnings.push(
          `有 ${stats.failedShards.length} 个分片**读不出来**（这些天的数据没算进来；若读取中途失败，已读到的部分可能已经计入 ⇒ 统计可能不完整）: ` +
            stats.failedShards.slice(0, 3).map((f) => `${f.key}（${f.errors.join('；')}）`).join(' | '),
        );
      }
      if (stats.shardWarnings.length > 0) {
        const detail = stats.shardWarnings
          .slice(0, 3)
          .map((s) => `${s.key}: ${s.warnings.slice(0, 2).join('；')}`)
          .join(' | ');
        warnings.push(`有 ${stats.shardWarnings.length} 个分片带数据告警（行数不符/缺前段/日期不一致等）⇒ 结果完整性打折：${detail}`);
      }
      if (stats.badLines > 0) warnings.push(`有 ${stats.badLines} 行无法解析（分片本身可疑，见 verify）`);
      if (totals.events === 0) warnings.push('窗口内没有任何事件 —— 先确认上传侧是否在产出、本机是否同步过（doctor --deep）');
      if (totals.heartbeatMaxGapMs !== null && totals.heartbeatMaxGapMs > HEARTBEAT_GAP_ALERT_MS) {
        warnings.push(
          `ACCOUNT_OBSERVED 最大间隔 ${(totals.heartbeatMaxGapMs / 3_600_000).toFixed(1)}h（实例 ${totals.heartbeatWorstInstance ?? '-'}，阈值 ${HEARTBEAT_GAP_ALERT_MS / 3_600_000}h）—— 疑似停摆/断流；` +
            '当前数据源不含 UDS_*/MARKET_STREAM_* 连接事件，无法区分"断流"与"进程停机"',
        );
      }
      if (totals.heartbeatCount === 0 && totals.events > 0) {
        warnings.push('窗口内没有 ACCOUNT_OBSERVED —— 无法用心跳判断停摆（上传侧白名单里是否包含它？）');
      }
      if (totals.heartbeats.size > 1) {
        warnings.push(`窗口里有 ${totals.heartbeats.size} 个实例在发心跳，心跳间隔与估值按实例分别统计（别把多实例混着看）`);
      }

      const sections: Section[] = [
        {
          heading: '概览',
          headers: ['指标', '值'],
          rows: [
            ['窗口', `${ctx.window.label}（${windowHours(ctx.window).toFixed(1)}h，${ctx.window.days.length} 天）`],
            ['分片 / 事件', `${totals.shards} / ${totals.events}`],
            ['坏行', String(totals.badLines)],
            ['首 / 末事件', `${totals.firstTs ? formatShanghai(totals.firstTs) : '-'} → ${totals.lastTs ? formatShanghai(totals.lastTs) : '-'}`],
            ['异常类事件', String([...totals.errorCounts.values()].reduce((s, n) => s + n, 0))],
            ['心跳次数 / 最大间隔', `${totals.heartbeatCount} / ${totals.heartbeatMaxGapMs === null ? '-' : (totals.heartbeatMaxGapMs / 60_000).toFixed(0) + 'min'}`],
            ['最近账户估值', totals.lastTotalValue === null ? '-' : `${totals.lastTotalValue.toFixed(2)}${totals.lastExchange ? ` @${totals.lastExchange}` : ''}`],
          ],
        },
      ];

      if (totals.errorCounts.size > 0) {
        sections.push({
          heading: '异常事件',
          headers: ['事件', '次数'],
          rows: [...totals.errorCounts.entries()].sort(byCountThenName).map(([name, n]) => [name, String(n)]),
        });
      }

      // Top-N 只排**业务事件**；配置回显类折叠成一行（展示层修复，理由见 ECHO_EVENT_RE 的注释）
      const allEvents = [...totals.eventCounts.entries()];
      const echoEntries = allEvents.filter(([name]) => ECHO_EVENT_RE.test(name));
      const echoTotal = echoEntries.reduce((sum, [, n]) => sum + n, 0);
      const echoFamilies = echoEntries.length;
      const topBusiness = allEvents
        .filter(([name]) => !ECHO_EVENT_RE.test(name))
        .sort(byCountThenName)
        .slice(0, 15);
      // 折叠行里要**列出成员名**：否则"深跌保护被关掉（WORKER_CONFIG_CRASH_DISABLED）"这类
      // 真状态变更会被一句"N 类共 M 条"彻底抹掉（review 指出的可观察风险）
      const echoMembers = echoEntries
        .sort(byCountThenName)
        .slice(0, 4)
        .map(([name, n]) => `${name.replace(/^WORKER_/, '')} ${n}`)
        .join(' / ');

      // 0 事件时不要推一个只有表头的空表（"窗口内没有事件"已经在 summary 里说了）
      if (topBusiness.length > 0 || echoTotal > 0) {
        sections.push({
          heading: '事件 Top 15（配置回显已折叠）',
          headers: ['事件', '次数'],
          note: '配置回显类（WORKER_CONFIG_*/WORKER_ENV_*）只在**展示层**折叠成一行；原始行仍在分片里，参数溯源与崩溃环排查用它。',
          rows: [
            ...topBusiness.map(([name, n]) => [name, String(n)]),
            ...(echoTotal > 0
              ? [[`（配置回显 ${echoFamilies} 类共 ${echoTotal} 条已折叠：${echoMembers}${echoFamilies > 4 ? ' …' : ''}）`, String(echoTotal)]]
              : []),
          ],
        });
      }

      if (totals.heartbeats.size > 0) {
        sections.push({
          heading: '心跳（按实例）',
          headers: ['实例', '次数', '最大间隔', '最近观测', '最近估值'],
          rows: [...totals.heartbeats.values()]
            .sort((a, b) => b.lastMs - a.lastMs)
            .map((hb) => [
              hb.instance,
              String(hb.count),
              hb.maxGapMs === null ? '-' : `${(hb.maxGapMs / 60_000).toFixed(0)}min`,
              formatShanghai(hb.lastMs),
              hb.lastTotalValue === null ? '-' : `${hb.lastTotalValue.toFixed(2)}${hb.lastExchange ? ` @${hb.lastExchange}` : ''}`,
            ]),
          note: '心跳 = ACCOUNT_OBSERVED（上传侧每小时一次）。间隔按实例分开算：多实例混成一条游标会既漏报又错值。',
        });
      }

      const symbolRows = [...totals.symbolCounts.entries()].sort(byCountThenName).map(([sym, n]) => [sym, String(n)]);
      if (symbolRows.length > 0) sections.push({ heading: '按 symbol', headers: ['symbol', '事件数'], rows: symbolRows });
      return {
        title: `健康检查 · ${ctx.window.label}`,
        summary:
          totals.events === 0
            ? '窗口内没有事件（数据没到或没同步）'
            : `${totals.shards} 个分片 / ${totals.events} 条事件，异常类事件 ${[...totals.errorCounts.values()].reduce((s, n) => s + n, 0)} 条` +
              (totals.heartbeatMaxGapMs === null ? '' : `，心跳最大间隔 ${(totals.heartbeatMaxGapMs / 60_000).toFixed(0)}min`),
        sections,
        warnings,
        provisional: stats.provisional,
      };
    },
  };
}
