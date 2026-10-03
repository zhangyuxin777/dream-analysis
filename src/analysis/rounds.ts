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

/**
 * 轮次身份键 = **实例 + 币种 + 计数器**（不是整个 roundId 字符串）。
 *
 * 两条都是隔夜真分片里**实测到**的（不是推演）：
 * ① `roundId` 只在 (实例, 币种) 内唯一 —— 计数器各币种独立从 1 起（真数据：BTC=168…、XRP=595…、ETH=001…），
 *    所以同一实例里两个币种、或两个实例的同名币种，完全可能撞上同一个字符串；
 *    只按 roundId 建键会让后出现的轮套用别人的首现时刻 ⇒ "已运行时长"错、Top-N 被顶掉。
 * ② 带仓重启会给同一轮**换后缀**：真分片里 counter=596 的轮，`NEW_ROUND` 是 `R596-190959`，
 *    而同轮的 `ROUND_FIRST_FILL` 已经是 `R596-191307-RCV`（counter 不变、时间后缀变了）。
 *    按整串比 ⇒ 该轮永远配不上 `ROUND_COMPLETED`，未完成列永久 +1 且凭空多一行 aging。
 * 计数器在 (实例, 币种) 内随轮递增，所以"计数器"是这一层里稳定的身份。
 */
export function roundKeyOf(instance: string, symbol: string, roundId: string): string {
  const counter = roundId.split('-')[0] ?? roundId;
  return `${instance}\u0000${symbol}\u0000${counter}`;
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
      /** 轮次身份键 → 该轮在窗口内第一次出现的时间 + 最近一次见到的完整 id（恢复改名后显示更贴近现状） */
      const roundFirst = new Map<string, { symbol: string; displayId: string; firstMs: number }>();
      /** 算"已运行时长"的参考时刻：窗口还没结束时用"此刻"，避免把未来的时间算进去 */
      const referenceMs = Math.min(ctx.window.toMs, ctx.now.getTime());
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
          const ms = Date.parse(e.ts);
          const roundKey = roundId === '' ? '' : roundKeyOf(e.instance, symbol, roundId);
          if (roundKey !== '') {
            const prev = roundFirst.get(roundKey);
            if (!prev) roundFirst.set(roundKey, { symbol, displayId: roundId, firstMs: ms });
            else prev.displayId = roundId; // 保留最近一次见到的完整 id
          }
          switch (e.event) {
            case 'NEW_ROUND':
              s.newRounds++;
              if (roundKey) s.newRoundIds.add(roundKey);
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
              if (roundKey) s.completedRoundIds.add(roundKey);
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
      if (stats.failedShards.length > 0) {
        warnings.push(
          `有 ${stats.failedShards.length} 个分片**读不出来**（这些天的轮数/利润没算进来；读取中途失败的，已读到的部分可能已计入）: ` +
            stats.failedShards.slice(0, 3).map((f) => `${f.key}（${f.errors.join('；')}）`).join(' | '),
        );
      }
      if (stats.shardWarnings.length > 0) {
        warnings.push(
          `有 ${stats.shardWarnings.length} 个分片带数据告警（行数不符/缺前段等）⇒ 轮数与利润可能偏低：` +
            stats.shardWarnings.slice(0, 3).map((s) => `${s.key}: ${s.warnings.slice(0, 2).join('；')}`).join(' | '),
        );
      }
      if (events === 0) warnings.push('窗口内没有任何轮次/成交类事件');

      const rows: string[][] = [];
      const unfinishedAging: Array<{ symbol: string; roundId: string; ageHours: number }> = [];
      let totalNew = 0;
      let totalCompleted = 0;
      let totalUnfinished = 0;
      let totalSellProfitCents = 0;
      let totalRoundProfitCents = 0;

      for (const [symbol, s] of [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        // 未完成轮：**带 roundId 与不带 roundId 的事件要分别算**（旧版本日志不带 roundId，跨版本窗口会混）
        // 只走"集合分支"会漏掉"新轮带 id、完成轮不带 id"这一侧 ⇒ 未完成被少算（M2 review 的 Warning）
        const idlessNew = Math.max(0, s.newRounds - s.newRoundIds.size);
        const idlessCompleted = Math.max(0, s.completedRounds - s.completedRoundIds.size);
        const unfinishedIds = [...s.newRoundIds].filter((id) => !s.completedRoundIds.has(id));
        const unfinished = unfinishedIds.length + Math.max(0, idlessNew - idlessCompleted);

        for (const key of unfinishedIds) {
          const first = roundFirst.get(key);
          // ⚠️ 参考时刻必须取 min(窗口结束, 此刻)：今天的窗口结束在**未来**，
          // 直接减窗口结束会报出一个还没发生过的时长（实测踩到：刚开 1 小时的轮显示"已运行 15.4h"）。
          // 再夹一层 0：注入时钟早于窗口时，负数时长比"0"更让人困惑
          if (first) {
            unfinishedAging.push({ symbol, roundId: first.displayId, ageHours: Math.max(0, referenceMs - first.firstMs) / 3_600_000 });
          }
        }

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
          heading: `最长卡轮 Top ${worstSorted.length}（已结束的轮，按 ROUND_COMPLETED.durationHours = 首笔买入→卖出）`,
          headers: ['币种', '轮次', '时长(h)', '整轮利润', '深跌'],
          rows: worstSorted.map((w) => [w.symbol, w.roundId || '-', w.durationHours.toFixed(2), yuan(w.profitCents), w.crash ? '是' : '']),
        });
      }

      // 正在开的轮也要能看出"卡了多久" —— 只看已结束的轮会把"哪一轮卡住了"答反（M2 review 的 Warning）
      const agingSorted = [...unfinishedAging].sort((a, b) => b.ageHours - a.ageHours).slice(0, topN);
      if (agingSorted.length > 0) {
        const referenceLabel = ctx.window.toMs > ctx.now.getTime() ? '此刻' : '窗口结束';
        sections.push({
          heading: `未完成轮 Top ${agingSorted.length}（已运行时长，越大越像卡住）`,
          headers: ['币种', '轮次', '已运行(h)'],
          rows: agingSorted.map((a) => [a.symbol, a.roundId, a.ageHours.toFixed(1)]),
          note: `已运行 = ${referenceLabel} − 该轮在窗口内的首条事件（窗口还没结束时按"此刻"算，不把未来时间算进去）；窗口结束不等于"卖出"，所以它衡量的是"还在开多久"。`,
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
