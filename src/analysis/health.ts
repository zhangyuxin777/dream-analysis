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
/** 心跳间隔超过这个值 ⇒ 疑似停摆（上传侧每小时一次观测，2 小时足够宽松） */
export const HEARTBEAT_GAP_ALERT_MS = 2 * 3_600_000;

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
        heartbeatCount: 0, heartbeatMaxGapMs: null, lastTotalValue: null, lastExchange: null,
      };
      let lastHeartbeatMs: number | null = null;

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
          if (lastHeartbeatMs !== null) {
            const gap = ms - lastHeartbeatMs;
            if (totals.heartbeatMaxGapMs === null || gap > totals.heartbeatMaxGapMs) totals.heartbeatMaxGapMs = gap;
          }
          lastHeartbeatMs = ms;
          const value = numOf(e.data, 'totalValue');
          if (value !== null) totals.lastTotalValue = value;
          const exchange = strOf(e.data, 'exchange');
          if (exchange) totals.lastExchange = exchange;
        }
      });
      totals.shards = stats.shards;
      totals.badLines = stats.badLines;

      const warnings: string[] = [];
      if (stats.missingDays.length > 0) {
        warnings.push(`窗口内缺 ${stats.missingDays.length} 天的本地数据: ${stats.missingDays.join(', ')}（结果按现有数据算，不要把缺口当成"没有异常"）`);
      }
      if (stats.badLines > 0) warnings.push(`有 ${stats.badLines} 行无法解析（分片本身可疑，见 verify）`);
      if (totals.events === 0) warnings.push('窗口内没有任何事件 —— 先确认上传侧是否在产出、本机是否同步过（doctor --deep）');
      if (totals.heartbeatMaxGapMs !== null && totals.heartbeatMaxGapMs > HEARTBEAT_GAP_ALERT_MS) {
        warnings.push(
          `ACCOUNT_OBSERVED 最大间隔 ${(totals.heartbeatMaxGapMs / 3_600_000).toFixed(1)}h（阈值 ${HEARTBEAT_GAP_ALERT_MS / 3_600_000}h）—— 疑似停摆/断流；` +
            '当前数据源不含 UDS_*/MARKET_STREAM_* 连接事件，无法区分"断流"与"进程停机"',
        );
      }
      if (totals.heartbeatCount === 0 && totals.events > 0) {
        warnings.push('窗口内没有 ACCOUNT_OBSERVED —— 无法用心跳判断停摆（上传侧白名单里是否包含它？）');
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

      sections.push({
        heading: '事件 Top 15',
        headers: ['事件', '次数'],
        rows: [...totals.eventCounts.entries()].sort(byCountThenName).slice(0, 15).map(([name, n]) => [name, String(n)]),
      });

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
