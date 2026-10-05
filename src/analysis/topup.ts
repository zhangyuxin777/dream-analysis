/**
 * `topup` 分析器（别名 `tu`）：**补仓行为** —— 补了多少、补到哪一档、为什么没补、以及"补不动了"的信号。
 *
 * 为什么单独一个视图：回测里最长的"卡住"（165 天）就是补仓走完最后一档后**只能等**；
 * 而 `TOPUP_LAST_TIER_REACHED{profitPercent, elapsedHours}` 是**程序自己**在说"我到最后一档、已经卡了 N 小时" ——
 * 这是"是不是卡住"最直接的官方判据，比我从事件反推的更权威。
 *
 * 事件语义**照主仓模板注释**（别自己编）：
 * - `TOPUP_EXECUTED{cost,quantity,buyPrice,remainingTopUp}` = **限价单已下单**（是否成交另算）⇒ 只叫"下单"，不叫"买入"；
 * - `TOPUP_ORDER_FILLED{clientOrderId,price,qty}` = **真的成交了**（notify:false，稀疏）；
 * - `TOPUP_SKIPPED{drawdown,threshold,avgPrice,bidPrice}` = 到最后一档但跌幅不够 ⇒ **为什么没补**；
 * - `TOPUP_LAST_TIER_REACHED{profitPercent,elapsedHours}` = 到最后一档（附带卡了多久）；
 * - `TOPUP_EXHAUSTED{}` = 额度用尽（本轮不再补）；
 * - `TOPUP_REPLACE_FAILED{error}` = 补仓**已成交**但换卖单失败（模板注释：不会自动重挂，需人工）——与"下单失败"两回事；
 * - `TOPUP_FAILED{error}` = 补仓单没下成（额度未扣）；
 * - `TOPUP_TRIGGERED{topUpAmount,remaining,bidPrice,quantity}` / `TOPUP_PROFIT_RESET{...}` = 触发与止盈重置。
 *
 * 金额口径：事件里的 `cost`/`topUpAmount`/`remaining` 是**报价币的浮点**（模板按 f2 打印）⇒
 * 内部一律转成**整数分**再累加（避免浮点累加误差），展示时再除以 100。
 */
import { Analysis, AnalysisContext, AnalysisResult, MAX_WINDOW_HOURS, Section, numOf } from './types';
import { windowHours } from '../common/time';
import { TOPUP_EVENTS, detailOf } from './events';

/** 明细保留条数上限（窗口内可能很多） */
export const DETAIL_KEEP = 500;

const cents = (v: number | null): number => (v === null ? 0 : Math.round(v * 100));
const money = (c: number): string => (c / 100).toFixed(2);

interface Row {
  ts: string;
  instance: string;
  symbol: string;
  round: string;
  event: string;
  detail: string;
  costCents: number;
  qty: number | null;
  elapsedHours: number | null;
}

export function topupAnalysis(): Analysis {
  return {
    name: 'topup',
    aliases: ['tu'],
    help: '补仓行为：触发/下单/成交/跳过/失败/耗尽次数、补了多少、补到哪一档、为什么没补、卡了多久',
    params: [
      { name: 'instance', description: '实例名（默认全部实例）', example: 'zyx666' },
      { name: 'symbol', description: '币种（支持短名，默认全部）', example: 'eth' },
      { name: 'window', description: `时间窗口（最长 ${MAX_WINDOW_HOURS}h）`, example: '近7d' },
      { name: 'top', description: '明细取前 N（默认 10）', example: '30' },
    ],
    async run(ctx: AnalysisContext): Promise<AnalysisResult> {
      const topN = Math.max(1, Math.min(200, Number(ctx.params.top ?? '10') || 10));
      const byType = new Map<string, number>();
      const bySymbol = new Map<string, { costCents: number; orders: number; fills: number; skips: number; exhausted: number; lastTier: number; replaceFailed: number; failed: number }>();
      const lastTierRows: Row[] = [];
      const exhaustedRows: Row[] = [];
      const replaceFailedRows: Row[] = [];
      const failedRows: Row[] = [];
      const skippedRows: Row[] = [];
      const byRound = new Map<string, { instance: string; symbol: string; round: string; orders: number; fills: number; costCents: number; lastTier: number }>();

      let costCents = 0;      // Σ 下单金额
      let filledCents = 0;    // Σ 成交金额（price×qty，观测量自己算）
      let lastRemainingCents: number | null = null; // 最近一次下单后的剩余额度

      const stats = await ctx.source.scan(
        { window: ctx.window, instance: ctx.params.instance },
        (e) => {
          if (!TOPUP_EVENTS.includes(e.event)) return;
          // ⚠️ 币种过滤必须在**计数之前**：否则概览会算上被过滤掉的币种（明细表却是过滤后的 ⇒ 自相矛盾）
          const symbol = e.symbol ?? '(无 symbol)';
          if (ctx.params.symbol && !symbol.toUpperCase().startsWith(ctx.params.symbol.toUpperCase())) return;
          byType.set(e.event, (byType.get(e.event) ?? 0) + 1);

          const round = e.roundId ?? '-';
          const row: Row = {
            ts: e.ts, instance: e.instance, symbol, round, event: e.event,
            detail: detailOf(e.data, 4), costCents: 0, qty: null, elapsedHours: null,
          };

          const per = bySymbol.get(symbol) ?? { costCents: 0, orders: 0, fills: 0, skips: 0, exhausted: 0, lastTier: 0, replaceFailed: 0, failed: 0 };
          const rk = `${e.instance}\u0000${symbol}\u0000${round}`;
          const perRound = byRound.get(rk) ?? { instance: e.instance, symbol, round, orders: 0, fills: 0, costCents: 0, lastTier: 0 };

          switch (e.event) {
            case 'TOPUP_EXECUTED': {
              // ⚠️ 这是"已下单"，不是"已成交"（模板注释特意强调过）
              const c = cents(numOf(e.data, 'cost'));
              row.costCents = c; row.qty = numOf(e.data, 'quantity');
              costCents += c; per.orders++; per.costCents += c; perRound.orders++; perRound.costCents += c;
              const rem = numOf(e.data, 'remainingTopUp');
              if (rem !== null) lastRemainingCents = cents(rem);
              break;
            }
            case 'TOPUP_ORDER_FILLED': {
              const px = numOf(e.data, 'price');
              const q = numOf(e.data, 'qty');
              row.qty = q;
              if (px !== null && q !== null) {
                const c = cents(px * q);
                row.costCents = c; filledCents += c; per.fills++; perRound.fills++;
              } else {
                per.fills++; perRound.fills++;
              }
              break;
            }
            case 'TOPUP_SKIPPED':
              per.skips++; skippedRows.push(row);
              break;
            case 'TOPUP_EXHAUSTED':
              per.exhausted++; exhaustedRows.push(row);
              break;
            case 'TOPUP_LAST_TIER_REACHED': {
              per.lastTier++; perRound.lastTier++;
              row.elapsedHours = numOf(e.data, 'elapsedHours');
              lastTierRows.push(row);
              break;
            }
            case 'TOPUP_REPLACE_FAILED':
              per.replaceFailed++; replaceFailedRows.push(row);
              break;
            case 'TOPUP_FAILED':
              per.failed++; failedRows.push(row);
              break;
            default:
              break; // TRIGGERED / PROFIT_RESET 只计数
          }

          bySymbol.set(symbol, per);
          byRound.set(rk, perRound);
          if (skippedRows.length > DETAIL_KEEP) skippedRows.shift();
          if (exhaustedRows.length > DETAIL_KEEP) exhaustedRows.shift();
          if (lastTierRows.length > DETAIL_KEEP) lastTierRows.shift();
          if (replaceFailedRows.length > DETAIL_KEEP) replaceFailedRows.shift();
          if (failedRows.length > DETAIL_KEEP) failedRows.shift();
        },
      );

      const orders = byType.get('TOPUP_EXECUTED') ?? 0;
      const fills = byType.get('TOPUP_ORDER_FILLED') ?? 0;
      const skips = byType.get('TOPUP_SKIPPED') ?? 0;
      const exhausted = byType.get('TOPUP_EXHAUSTED') ?? 0;
      const lastTier = byType.get('TOPUP_LAST_TIER_REACHED') ?? 0;
      const replaceFailed = byType.get('TOPUP_REPLACE_FAILED') ?? 0;
      const failed = byType.get('TOPUP_FAILED') ?? 0;

      const warnings: string[] = [];
      if (stats.missingDays.length > 0) warnings.push(`窗口内缺 ${stats.missingDays.length} 天的本地数据: ${stats.missingDays.join(', ')}（补仓次数会偏低）`);
      if (stats.failedShards.length > 0) warnings.push(`有 ${stats.failedShards.length} 个分片**读不出来** ⇒ 补仓统计不完整: ` + stats.failedShards.slice(0, 3).map((f) => f.key).join(' | '));
      if (replaceFailed > 0) {
        warnings.push(
          `最该立刻看：${replaceFailed} 次**补仓已成交但换卖单失败** —— 模板注释写"程序不会自动重挂卖单，下一笔买单成交时会再挂"，` +
            '也就是说这轮在下一笔买单成交前**不会卖出**（表现就是卡住）；注释同时说要人工核对挂单与持仓',
        );
      }
      if (exhausted > 0) {
        warnings.push(`${exhausted} 次补仓额度**已用尽**（本轮不再补仓）—— 之后只能等价格回来卖出；这就是"卡住"的典型成因`);
      }
      if (lastTier > 0) {
        const longest = lastTierRows.reduce((m, r) => Math.max(m, r.elapsedHours ?? 0), 0);
        warnings.push(
          `有 ${lastTier} 次走到**最后一档**（程序自己的判据）` + (longest > 0 ? `，其中报出的最长已卡 ${longest.toFixed(1)}h` : '') +
            ' —— 到最后一档后补仓只能靠通道 B（跌幅够才补），横盘/慢跌时会一直等',
        );
      }
      if (failed > 0) warnings.push(`有 ${failed} 次补仓**下单失败**（额度未扣；模板注释：程序每 60 秒自动重试，持续刷屏多为补仓额/精度配置问题）`);
      if (orders > fills && orders - fills > 0) {
        warnings.push(`下单 ${orders} 次但只看到 ${fills} 次成交 —— 差值可能是"补仓单挂着还没成交"（也可能成交事件是 notify:false 采得少），看挂单要核对交易所`);
      }
      if (skips > 0 && orders === 0) warnings.push(`有 ${skips} 次"到最后一档但跌幅不够"的跳过、一次补仓都没下 —— 触发条件可能偏紧，看下面的跌幅 vs 阈值`);
      if (byType.size === 0 && stats.events > 0) warnings.push('窗口内没有补仓事件（这本身是有用信息：这段没触发过补仓）');

      const sections: Section[] = [
        {
          heading: '概览',
          headers: ['指标', '值'],
          rows: [
            ['窗口', `${ctx.window.label}（${windowHours(ctx.window).toFixed(1)}h）`],
            ['分片 / 事件', `${stats.shards} / ${stats.events}`],
            ['触发 / 下单 / 成交', `${byType.get('TOPUP_TRIGGERED') ?? 0} / ${orders} / ${fills}`],
            ['跳过（跌幅不够）/ 最后档 / 耗尽', `${skips} / ${lastTier} / ${exhausted}`],
            ['下单失败 / 换卖单失败', `${failed} / ${replaceFailed}`],
            ['补仓下单金额合计', money(costCents)],
            ['补仓成交金额合计', money(filledCents)],
            ['最近一次下单后的剩余额度', lastRemainingCents === null ? '-' : money(lastRemainingCents)],
          ],
          note: '**下单 ≠ 成交**：`TOPUP_EXECUTED` 是限价单已下单（模板注释明确说不能说"成功买入"），成交看 `TOPUP_ORDER_FILLED`。'
            + '金额按事件里的报价币浮点转整数分累加。',
        },
      ];

      if (lastTierRows.length > 0 || exhaustedRows.length > 0 || replaceFailedRows.length > 0) {
        const rows: string[][] = [];
        for (const r of [...replaceFailedRows].reverse().slice(0, topN)) {
          rows.push(['换卖单失败(需人工)', r.ts.replace('T', ' ').slice(0, 19), r.instance, r.symbol, r.round, r.detail]);
        }
        for (const r of [...lastTierRows].reverse().slice(0, topN)) {
          rows.push(['到最后一档', r.ts.replace('T', ' ').slice(0, 19), r.instance, r.symbol, r.round, `已卡 ${r.elapsedHours === null ? '-' : r.elapsedHours.toFixed(1)}h ${r.detail}`]);
        }
        for (const r of [...exhaustedRows].reverse().slice(0, topN)) {
          rows.push(['额度用尽', r.ts.replace('T', ' ').slice(0, 19), r.instance, r.symbol, r.round, r.detail]);
        }
        sections.push({
          heading: '补不动了的信号（按时间倒序）',
          headers: ['类型', '时间', '实例', '币种', '轮次', '细节'],
          rows,
          note: '"到最后一档"是**程序自己**报的（`TOPUP_LAST_TIER_REACHED.elapsedHours` = 它认为已经卡了多久）；'
            + '"额度用尽"之后本轮不再补仓；"换卖单失败"需人工核对（程序不会自动重挂）。',
        });
      }

      if (orders > 0 || fills > 0) {
        const topRounds = [...byRound.values()]
          .filter((r) => r.orders > 0 || r.fills > 0)
          .sort((a, b) => (b.orders - a.orders) || (b.costCents - a.costCents))
          .slice(0, topN);
        sections.push({
          heading: `补仓最多的轮 Top ${topRounds.length}`,
          headers: ['实例', '币种', '轮次', '下单', '成交', '下单金额', '最后档'],
          rows: topRounds.map((r) => [r.instance, r.symbol, r.round, String(r.orders), String(r.fills), money(r.costCents), r.lastTier > 0 ? '是' : '-']),
        });
      }

      if (skippedRows.length > 0) {
        const shown = [...skippedRows].reverse().slice(0, topN);
        sections.push({
          heading: `为什么没补（到最后一档但跌幅不够）最近 ${shown.length} 条`,
          headers: ['时间', '实例', '币种', '轮次', '细节'],
          rows: shown.map((r) => [r.ts.replace('T', ' ').slice(0, 19), r.instance, r.symbol, r.round, r.detail]),
          note: '字段是 `drawdown`（当前回撤）/`threshold`（触发阈值）/`avgPrice`/`bidPrice` —— 差多少一目了然。',
        });
      }

      if (failedRows.length > 0) {
        const shown = [...failedRows].reverse().slice(0, topN);
        sections.push({
          heading: `补仓下单失败最近 ${shown.length} 条`,
          headers: ['时间', '实例', '币种', '轮次', 'error'],
          rows: shown.map((r) => [r.ts.replace('T', ' ').slice(0, 19), r.instance, r.symbol, r.round, r.detail]),
        });
      }

      if (bySymbol.size > 1) {
        sections.push({
          heading: '按币种',
          headers: ['币种', '下单', '成交', '跳过', '最后档', '耗尽', '失败', '换卖单失败', '下单金额'],
          rows: [...bySymbol.entries()]
            .sort((a, b) => (b[1].orders - a[1].orders) || a[0].localeCompare(b[0]))
            .map(([sym, v]) => [sym, String(v.orders), String(v.fills), String(v.skips), String(v.lastTier), String(v.exhausted), String(v.failed), String(v.replaceFailed), money(v.costCents)]),
        });
      }

      const summary = byType.size === 0
        ? (stats.events === 0 ? '窗口内没有事件（数据没到或没同步）' : '窗口内没有补仓事件')
        : `下单 ${orders} / 成交 ${fills} / 跳过 ${skips} / 最后档 ${lastTier} / 耗尽 ${exhausted}` + (costCents > 0 ? `，下单金额 ${money(costCents)}` : '');

      return {
        title: `补仓 · ${ctx.window.label}${ctx.params.symbol ? ` · ${ctx.params.symbol.toUpperCase()}` : ''}`,
        summary,
        sections,
        warnings,
        provisional: stats.provisional,
      };
    },
  };
}
