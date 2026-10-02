/**
 * `rounds` 分析器（别名 `r`）：轮次与成交。
 *
 * 口径（对齐主仓事件模板表，字段名取自 `logTpl`，别凭印象写）：
 * - `NEW_ROUND`      （bidPrice/atrRatio）              → 新轮开始
 * - `ROUND_FIRST_FILL`（buyPrice/accCost）             → 该轮首单成交
 * - `BUY_FILLED`     （index/buyPrice/accCost）        → 买单成交
 * - `SELL_FILLED`    （price/qty/profit/totalProfit）  → 止盈卖出（**逐笔利润**）
 * - `ROUND_COMPLETED`（profit/sellPrice/avgBuyPrice/accCost/qty/durationHours/atrRatio/isCrashMode）→ 整轮利润
 * - `ORDER_FILLED`   （orderInfo）                     → 订单级成交（只做计数，不做金额）
 *
 * ⚠️ **两种利润口径不要混**：`SELL_FILLED.profit` 是逐笔止盈，`ROUND_COMPLETED.profit` 是整轮结算。
 * 报告里分两列列出，**不做加法**（那会重复计算）。
 *
 * 金额累加用**整数分**（`Math.round(v*100)`）再转回，避免浮点误差累积（项目规范：钱不能靠浮点累加）。
 */
import { Analysis, AnalysisContext, AnalysisResult, MAX_WINDOW_HOURS, Section, numOf, strOf } from './types';
import { formatShanghai, windowHours } from '../common/time';

const cents = (v: number): number => Math.round(v * 100);
const yuan = (c: number): string => (c / 100).toFixed(2);

interface SymbolStats {
  newRounds: number;
  completedRounds: number;
  buyFills: number;
  sellFills: number;
  orderFills: number;
  crashEntered: number;
  sellProfitCents: number;
  roundProfitCents: number;
  completedRoundIds: Set<string>;
  newRoundIds: Set<string>;
}

interface WorstRound {
  symbol: string;
  roundId: string;
  durationHours: number;
  profitCents: number;
  crash: boolean;
}

function newStat(): SymbolStats {
  return {
    newRounds: 0, completedRounds: 0, buyFills: 0, sellFills: 0, orderFills: 0, crashEntered: 0,
    sellProfitCents: 0, roundProfitCents: 0,
    completedRoundIds: new Set(), newRoundIds: new Set(),
  };
}

export function roundsAnalysis(): Analysis {
  return {
    name: 'rounds',
    aliases: ['r'],
    help: '轮数 / 买卖成交 / 止盈与整轮利润 / 未完成轮 / 最长卡轮 Top N',
    params: [
      { name: 'symbol', description: '币种（支持短名，默认全部）', example: 'eth' },
      { name: 'instance', description: '实例名（默认全部实例）', example: 'boye888' },
      { name: 'window', description: `时间窗口（最长 ${MAX_WINDOW_HOURS}h）`, example: '昨天' },
      { name: 'top', description: '最长卡轮取前 N（默认 5）', example: '10' },
    ],
    async run(ctx: AnalysisContext): Promise<AnalysisResult> {
      const bySymbol = new Map<string, SymbolStats>();
      const worst: WorstRound[] = [];
      const topN = Math.max(1, Math.min(50, Number(ctx.params.top ?? '5') || 5));
      let events = 0;

      const statOf = (symbol: string): SymbolStats => {
        let s = bySymbol.get(symbol);
        if (!s) {
          s = newStat();
          bySymbol.set(symbol, s);
        }
        return s;
      };

      const stats = await ctx.source.scan(
        { window: ctx.window, instance: ctx.params.instance, symbol: ctx.params.symbol },
        (e) => {
          events++;
          const symbol = e.symbol ?? '(无 symbol)';
          const s = statOf(symbol);
          const roundId = e.roundId ?? strOf(e.data, 'roundId') ?? '';
          switch (e.event) {
            case 'NEW_ROUND':
              s.newRounds++;
              if (roundId) s.newRoundIds.add(roundId);
              break;
            case 'ROUND_FIRST_FILL':
              break; // 首单成交对"轮数/利润"没有独立贡献（BUY_FILLED 已计），只在需要时再加
            case 'BUY_FILLED':
              s.buyFills++;
              break;
            case 'SELL_FILLED': {
              s.sellFills++;
              const profit = numOf(e.data, 'profit');
              if (profit !== null) s.sellProfitCents += cents(profit);
              break;
            }
            case 'ORDER_FILLED':
              s.orderFills++;
              break;
            case 'CRASH_ENTERED':
              s.crashEntered++;
              break;
            case 'ROUND_COMPLETED': {
              s.completedRounds++;
              if (roundId) s.completedRoundIds.add(roundId);
              const profit = numOf(e.data, 'profit');
              if (profit !== null) s.roundProfitCents += cents(profit);
              const durationHours = numOf(e.data, 'durationHours');
              if (durationHours !== null) {
                worst.push({
                  symbol,
                  roundId: roundId || '-',
                  durationHours,
                  profitCents: profit === null ? 0 : cents(profit),
                  crash: e.data?.isCrashMode === true,
                });
              }
              break;
            }
            default:
              break;
          }
        },
      );

      const warnings: string[] = [];
      if (stats.missingDays.length > 0) {
        warnings.push(`窗口内缺 ${stats.missingDays.length} 天的本地数据: ${stats.missingDays.join(', ')}（下面的轮数/利润按现有数据算，会偏低）`);
      }
      if (events === 0) warnings.push('窗口内没有任何轮次/成交类事件');

      const rows: string[][] = [];
      let totalNew = 0;
      let totalCompleted = 0;
      let totalUnfinished = 0;
      let totalSellProfitCents = 0;
      let totalRoundProfitCents = 0;

      for (const [symbol, s] of [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        // 未完成轮：以"有 NEW_ROUND 但没有 ROUND_COMPLETED"的 roundId 计算；没有 roundId 时退化为计数差
        const unfinished = s.newRoundIds.size > 0 || s.completedRoundIds.size > 0
          ? [...s.newRoundIds].filter((id) => !s.completedRoundIds.has(id)).length
          : Math.max(0, s.newRounds - s.completedRounds);
        totalNew += s.newRounds;
        totalCompleted += s.completedRounds;
        totalUnfinished += unfinished;
        totalSellProfitCents += s.sellProfitCents;
        totalRoundProfitCents += s.roundProfitCents;
        rows.push([
          symbol,
          String(s.newRounds),
          String(s.completedRounds),
          String(unfinished),
          String(s.buyFills),
          String(s.sellFills),
          String(s.orderFills),
          String(s.crashEntered),
          yuan(s.sellProfitCents),
          yuan(s.roundProfitCents),
        ]);
      }

      const sections: Section[] = [
        {
          heading: '按币种',
          headers: ['币种', '新轮', '完成轮', '未完成', '买单', '卖单', '订单成交', '深跌', '止盈利润', '整轮利润'],
          rows,
          note: '止盈利润 = ΣSELL_FILLED.profit（逐笔）；整轮利润 = ΣROUND_COMPLETED.profit（整轮结算）。两者口径不同，**不要相加**。未完成 = 窗口内开了新轮但没看到 ROUND_COMPLETED（窗口末尾还在跑的轮也会算进来，不等于"失败"）。',
        },
        {
          heading: '概览',
          headers: ['指标', '值'],
          rows: [
            ['窗口', `${ctx.window.label}（${windowHours(ctx.window).toFixed(1)}h，${ctx.window.days.length} 天）`],
            ['分片 / 事件', `${stats.shards} / ${stats.events}`],
            ['新轮 / 完成轮 / 未完成', `${totalNew} / ${totalCompleted} / ${totalUnfinished}`],
            ['止盈利润合计', yuan(totalSellProfitCents)],
            ['整轮利润合计', yuan(totalRoundProfitCents)],
          ],
        },
      ];

      const worstSorted = [...worst].sort((a, b) => b.durationHours - a.durationHours).slice(0, topN);
      if (worstSorted.length > 0) {
        sections.push({
          heading: `最长卡轮 Top ${worstSorted.length}（按 ROUND_COMPLETED.durationHours）`,
          headers: ['币种', '轮次', '时长(h)', '整轮利润', '深跌'],
          rows: worstSorted.map((w) => [w.symbol, w.roundId || '-', w.durationHours.toFixed(2), yuan(w.profitCents), w.crash ? '是' : '']),
        });
      }

      const span = stats.events > 0 ? `，覆盖 ${stats.shards} 个分片` : '';
      return {
        title: `轮次与成交 · ${ctx.window.label}${ctx.params.symbol ? ` · ${ctx.params.symbol.toUpperCase()}` : ''}`,
        summary:
          events === 0
            ? '窗口内没有轮次/成交事件'
            : `新轮 ${totalNew} / 完成 ${totalCompleted} / 未完成 ${totalUnfinished}；止盈利润合计 ${yuan(totalSellProfitCents)}${span}`,
        sections,
        warnings,
        provisional: stats.provisional,
      };
    },
  };
}
