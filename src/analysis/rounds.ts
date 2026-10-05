/**
 * `rounds` 分析器（别名 `r`）：**窗口内**的轮次与成交。
 *
 * 轮次身份与统计全部走 `roundsCore.ts` 的收集器（与 `stuck` 共用同一套规则）：
 * 身份 = `R<计数器>`（`-RCV`/时间戳后缀只是显示名）。本文件只做**窗口内的过滤 + 报表**。
 *
 * 口径（字段名取自主仓 `logTpl`，别凭印象写）：
 * - `NEW_ROUND` → 新轮；`BUY_FILLED{index,buyPrice,accCost}` → 买入成交
 * - `SELL_FILLED{profit}` → 逐笔止盈；`ROUND_COMPLETED{profit,durationHours,isCrashMode}` → 整轮结算
 * - `RESET_CANCEL_SUCCESS{reason}` → 撤单复位（`SELL_FILLED` = 正常卖出；其余 = 掐断重开）
 * - `durationHours` 的实测口径是 **末次买入→卖出**（真数据 R003：末笔 02:39:40→卖 08:37:11 = 5.958h ≈ 字段 5.95；
 *   首笔→卖出是 8.49h）。曾经标成"首笔买入→卖出"，是错的。
 */
import { Analysis, AnalysisContext, AnalysisResult, MAX_WINDOW_HOURS, Section } from './types';
import { windowHours } from '../common/time';
import {
  RoundState,
  aliveHours,
  createRoundCollector,
  groupByInstance,
  nextFirstMsOf,
  outcomeOf,
} from './roundsCore';

/** 分 → 元（显示用） */
function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
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
      const collector = createRoundCollector();
      const referenceMs = Math.min(ctx.window.toMs, ctx.now.getTime());
      const topN = Math.max(1, Math.min(50, Number(ctx.params.top ?? '5') || 5));

      const stats = await ctx.source.scan(
        { window: ctx.window, instance: ctx.params.instance, symbol: ctx.params.symbol },
        (e) => collector.onEvent(e),
      );
      const bySymbol = collector.symbols();

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
      if (stats.badLines > 0) warnings.push(`有 ${stats.badLines} 行无法解析（分片本身可疑，见 verify）`);
      if (stats.events === 0) warnings.push('窗口内没有任何轮次/成交类事件');

      const allRounds = [...bySymbol.values()].flatMap((s) => [...s.rounds.values()]);
      const outsideScan = allRounds.filter((r) => r.startOutsideScan).length;
      if (outsideScan > 0) {
        warnings.push(
          `有 ${outsideScan} 轮的开轮事件不在本窗口内（窗口把这一轮切成了两半）⇒ 它们的"存活"是**下界**（已用 ≥ 标出），`
            + '也可能显示成"未建仓"；要看全貌请用 stuck（卡住轮）视图',
        );
      }
      const reused = allRounds.filter((r) => r.reusedCount > 0).length;
      if (reused > 0) {
        warnings.push(`有 ${reused} 个计数器被复用（同一个 R<计数器> 又开了一轮）—— 理论上不该发生，请核对主仓的轮次计数器`);
      }
      const dup = [...bySymbol.values()].reduce((n, s) => n + s.duplicateCompletions, 0);
      if (dup > 0) warnings.push(`有 ${dup} 条完成事件是同一轮的重复上报（只计一次，供核对）`);

      // ---- 报表 ----
      const rows: string[][] = [];
      const openRows: Array<{ symbol: string; round: RoundState; nextFirstMs: number | null }> = [];
      let totalNew = 0;
      let totalCompleted = 0;
      let totalUnfinished = 0;
      let totalSellProfitCents = 0;
      let totalRoundProfitCents = 0;

      for (const [symbol, s] of [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const rounds = [...s.rounds.values()];
        for (const list of groupByInstance(rounds).values()) {
          for (let i = 0; i < list.length; i++) {
            if (!list[i].completed) openRows.push({ symbol, round: list[i], nextFirstMs: nextFirstMsOf(list, i) });
          }
        }
        const open = rounds.filter((r) => !r.completed).length;
        // 不带 id 的新轮（旧日志）按计数差兜底：与不带 id 的完成事件配对
        const unfinished = open + Math.max(0, s.newRoundsWithoutId - s.idlessCompletions);

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

      // 最长卡轮（已结束的轮）：等待 = 上传侧 durationHours；补仓 = 首笔→末笔买入（自己 join）
      const completed = allRounds.filter((r) => r.completed && r.durationHours !== null);
      const worst = completed
        .slice()
        .sort((a, b) => (b.durationHours ?? 0) - (a.durationHours ?? 0))
        .slice(0, topN);
      if (worst.length > 0) {
        sections.push({
          heading: `最长卡轮 Top ${worst.length}（已结束的轮）`,
          headers: ['币种', '轮次', '等待(h)', '补仓(h)', '整轮利润', '深跌'],
          note: '等待 = ROUND_COMPLETED.durationHours（主仓口径：**末次买入→卖出**，即"建完仓等价格回到止盈位"等了多久）。'
            + '补仓 = 首笔→末笔买入（自己 join BUY_FILLED；缺时间戳时为 "-"）。两段相加 ≈ 整轮跨度。',
          rows: worst.map((r) => [
            r.symbol,
            r.displayId,
            (r.durationHours ?? 0).toFixed(2),
            r.firstBuyMs !== null && r.lastBuyMs !== null ? ((r.lastBuyMs - r.firstBuyMs) / 3_600_000).toFixed(2) : '-',
            yuan(r.profitCents ?? 0),
            r.isCrashMode ? '是' : '',
          ]),
        });
      }

      // 未完成轮：已建仓的排前面（"卡"的前提是有仓位）
      const sortedOpen = [...openRows]
        .sort((a, b) => {
          const pa = a.round.firstBuyMs !== null;
          const pb = b.round.firstBuyMs !== null;
          if (pa !== pb) return pa ? -1 : 1;
          return aliveHours(b.round, b.nextFirstMs, referenceMs) - aliveHours(a.round, a.nextFirstMs, referenceMs);
        })
        .slice(0, topN);
      if (sortedOpen.length > 0) {
        const referenceLabel = ctx.window.toMs > ctx.now.getTime() ? '此刻' : '窗口结束';
        sections.push({
          heading: `未完成轮 Top ${sortedOpen.length}（已建仓的在前）`,
          headers: ['币种', '轮次', '存活(h)', '已建仓', '末笔买入后(h)', '结局'],
          rows: sortedOpen.map((o) => {
            const r = o.round;
            const alive = aliveHours(r, o.nextFirstMs, referenceMs);
            const lastBuy = r.lastBuyMs === null ? null : Math.max(0, referenceMs - r.lastBuyMs) / 3_600_000;
            return [
              o.symbol,
              r.displayId,
              `${r.startOutsideScan ? '≥' : ''}${alive.toFixed(1)}`,
              r.firstBuyMs !== null ? '是' : '否',
              lastBuy === null ? '-' : lastBuy.toFixed(1),
              outcomeOf(r, o.nextFirstMs, '本窗口'),
            ];
          }),
          note: '存活 = 从开轮算到"结束那一刻"（复位掐断的算到复位、被下一轮取代的算到下一轮开轮，'
            + `${referenceLabel === '此刻' ? '否则算到此刻' : '否则算到窗口结束'}）；带 ≥ 表示开轮不在本窗口内（只是下界）。`
            + ' 已建仓（有无买入成交）才是"卡"的前提 —— "否"表示这一轮一直没等到买单成交（空等/被复位掐断），不是持仓卡住。'
            + ' 末笔买入后 = 建完仓又等了多久（更接近"卡了多久"）。'
            + ' 结局的"窗口内未见收口"**不等于"现在还在开"**：窗口外的事件本窗口看不见（跨窗口现状见 stuck 视图）。',
        });
      }

      const span = stats.events > 0 ? `，覆盖 ${stats.shards} 个分片` : '';
      return {
        title: `轮次与成交 · ${ctx.window.label}${ctx.params.symbol ? ` · ${ctx.params.symbol.toUpperCase()}` : ''}`,
        summary:
          stats.events === 0
            ? '窗口内没有轮次/成交事件'
            : `新轮 ${totalNew} / 完成 ${totalCompleted} / 未完成 ${totalUnfinished}；止盈利润合计 ${yuan(totalSellProfitCents)}${span}`,
        sections,
        warnings,
        provisional: stats.provisional,
      };
    },
  };
}
