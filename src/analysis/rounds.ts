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
  /** 轮次账本：键 = 实例+币种+计数器，值 = 该计数器下按时间排列的出现记录（可能多轮，计数器会复用/回绕） */
  ledger: Map<string, RoundOccurrence[]>;
  /** 没配上开轮记录的完成事件数（窗口前开的轮在本窗口完成 / 没有 roundId） */
  unmatchedCompletions: number;
  /** 其中来自 `R000-ERR-RCV` 这类**恢复错误态 id** 的条数（归因不可靠，要单独报出来） */
  errorIdCompletions: number;
  /** 属于"开轮不在本窗口"的轮的成交/复位事件数（这些轮看不到起点与建仓，列会偏低） */
  orphanEvents: number;
}

interface WorstRound {
  symbol: string;
  roundId: string;
  durationHours: number;
  profitCents: number;
  crash: boolean;
  /** 首笔→末笔买入的时长（"补仓过程"占多久）；没有买入时间戳时为 null */
  refillHours: number | null;
}

/**
 * 轮次身份：**以完整 roundId 字符串为主键**，只对一种情况放宽 —— 带仓重启的改名。
 *
 * 主仓 `dream_develop/src/grid/spot-worker.ts` 实证（2026-10-03 只读核对）：
 * - `L113 private round: number = 0;` —— 计数器是**进程内成员变量**；
 * - `L1140 this.round = (this.round + 1) % 3844;` —— 递增且 **3844 取模**（会回绕）；
 * - `L735-757` 启动恢复：`if (!state.isInGaming)` 直接 early-return（`round: 0`），
 *   即**空仓/无持仓启动时计数器不恢复** ⇒ 下一次开轮必然又是 `R001-<新时间戳>`；
 * - `L763 this.roundId = `R${pad(state.round,3)}-${ts}-RCV`` —— 恢复改名**只加 `-RCV` 后缀并换时间戳**。
 *
 * 结论（两次 P5 换来的教训）：
 * ① **不能**把身份降级成计数器 —— 计数器会复用（空仓重启）也会回绕（取模 3844），
 *    合并两轮会把"真在开的轮"报成已完成 ⇒ 未完成数**少算**，比多算一行幽灵更难发现；
 * ② **要**修的是改名：真分片实测 counter=596 的同一轮，`NEW_ROUND` 是 `R596-190959`，
 *    而同轮的 `ROUND_FIRST_FILL`/`ROUND_COMPLETED` 已是 `R596-191307-RCV` —— 按整串比
 *    会让它永远配不上完成事件（未完成列永久 +1 且凭空一行 aging）。
 *
 * 所以按 (实例, 币种, 计数器) 记**一串出现记录**（同一计数器下可以有多轮）：
 * 完成事件先按完整字符串精确匹配，匹配不到且带 `-RCV` 时，才认领同计数器**最新的未完成**那轮。
 */
export interface RoundOccurrence {
  /** 最近一次见到的完整 id（恢复改名后报告里显示现状） */
  displayId: string;
  /** 所属实例（"是否已被新轮取代"必须按 (实例,币种) 判，不能跨实例比时间） */
  instance: string;
  /** 这一轮首次出现的时间（与 displayId 同属一条记录，不会和张冠李戴的时长拼在一起） */
  firstMs: number;
  completed: boolean;
  /** 首笔/末笔买入成交的时间（"补仓过程"多久、持仓等了多久都靠它） */
  firstBuyMs: number | null;
  lastBuyMs: number | null;
  /** 复位原因（`RESET_CANCEL_SUCCESS.reason`；`SELL_FILLED` = 正常卖出，其余如 `PRICE_DEVIATION` = 掐断重开） */
  resetReason: string | null;
  /** 复位事件的时间（掐断型轮的"存活时长"要算到这一刻，不能算到窗口结束 —— 否则窗口越长数字越大） */
  resetMs: number | null;
  /** 是否"窗口内最新"（窗口外有没有更新的轮，本窗口看不见，所以措辞必须留余地） */
  newestInWindow?: boolean;
  /** 该轮的存活时长（小时）：掐断 → 到复位那一刻；被取代 → 到下一轮开轮；否则 → 到参考时刻 */
  aliveHours?: number;
}

/** 计数器：`R596-190959` / `R596-191307-RCV` → `R596` */
export function counterOfRoundId(roundId: string): string {
  return roundId.split('-')[0] ?? roundId;
}

/** 轮次账本键 = 实例 + 币种 + 计数器（计数器只在同一 (实例,币种) 内计数） */
export function roundLedgerKey(instance: string, symbol: string, roundId: string): string {
  return `${instance}\u0000${symbol}\u0000${counterOfRoundId(roundId)}`;
}

/**
 * 恢复抛异常时主仓会落地一个**常量** id `R000-ERR-RCV`（spot-worker.ts:723）：
 * 它带 `-RCV` 但**不是改名** —— 计数器信息已经丢了（解析出来是假的 `R000`），
 * 所以既不能拿它当改名证据去认领记录，也不能让计数器为 `R000` 的真轮被它抢走。
 */
export function isErrorRoundId(roundId: string): boolean {
  return roundId.includes('-ERR-');
}

/** 带仓重启的改名标记（主仓 spot-worker.ts:763；错误态 id 除外） */
export function isRecoveredRoundId(roundId: string): boolean {
  return roundId.endsWith('-RCV') && !isErrorRoundId(roundId);
}

/** 按实例分组（"是否被新轮取代"只在同一 (实例,币种) 内有意义） */
function groupByInstance(occurrences: RoundOccurrence[]): Map<string, RoundOccurrence[]> {
  const out = new Map<string, RoundOccurrence[]>();
  for (const o of occurrences) {
    const list = out.get(o.instance);
    if (list) list.push(o);
    else out.set(o.instance, [o]);
  }
  return out;
}

/**
 * 未收口轮的结局 —— 全部来自观测，不猜：
 * - `复位掐断(<reason>)`：这一轮收到过 `RESET_CANCEL_SUCCESS` 且原因不是正常卖出（如 `PRICE_DEVIATION`）
 * - `本窗口内未见收口`：它是该 (实例,币种) 在**本窗口内**最后出现的轮。
 *   ⚠️ 这个措辞是刻意的：**不等于"现在还在开"** —— 窗口之外的复位/完成事件本窗口看不见。
 * - `已被新轮取代`：它后面又开了一轮 ⇒ 它已经以某种方式结束了（完成事件缺失 / 被复位掐断）
 */
export function outcomeOf(occ: RoundOccurrence): string {
  if (occ.resetReason !== null && occ.resetReason !== 'SELL_FILLED') return `复位掐断(${occ.resetReason})`;
  return occ.newestInWindow ? '本窗口内未见收口' : '已被新轮取代';
}

/** 与"仓位"直接相关的事件：只有它们才需要挂到某一轮上（其余如 ATR/配置类事件不参与账本） */
const POSITION_EVENTS = new Set(['BUY_FILLED', 'SELL_FILLED', 'ROUND_FIRST_FILL', 'RESET_CANCEL_SUCCESS']);

function newStat(): SymbolStats {
  return {
    newRounds: 0, completedRounds: 0, buyFills: 0, sellFills: 0, orderFills: 0, crashEntered: 0,
    sellProfitCents: 0, roundProfitCents: 0,
    ledger: new Map(), unmatchedCompletions: 0, errorIdCompletions: 0, orphanEvents: 0,
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
      /** 轮次账本（按币种分桶，键含实例与计数器） */
      const ledgerOf = (s: SymbolStats, key: string): RoundOccurrence[] => {
        let list = s.ledger.get(key);
        if (!list) {
          list = [];
          s.ledger.set(key, list);
        }
        return list;
      };
      /** 找这一轮对应的记录：先按完整 id 精确匹配，再退回"最后一条未完成"（改名场景） */
      const occurrenceOf = (list: RoundOccurrence[], roundId: string): RoundOccurrence | undefined => {
        for (let i = list.length - 1; i >= 0; i--) if (list[i].displayId === roundId) return list[i];
        for (let i = list.length - 1; i >= 0; i--) if (!list[i].completed) return list[i];
        return undefined;
      };
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
          const ledgerKey = roundId === '' ? '' : roundLedgerKey(e.instance, symbol, roundId);
          if (ledgerKey !== '') {
            const list = ledgerOf(s, ledgerKey);
            if (e.event === 'NEW_ROUND') {
              // 同一轮的重复 NEW_ROUND（同字符串）不新开记录；换了字符串就是另一轮（计数器复用/改名后重发）
              const last = list[list.length - 1];
              if (!last || last.displayId !== roundId) {
                list.push({ displayId: roundId, instance: e.instance, firstMs: ms, completed: false, firstBuyMs: null, lastBuyMs: null, resetReason: null, resetMs: null });
              }
            } else if (e.event !== 'ROUND_COMPLETED') {
              // ⚠️ 只让**非完成**事件更新显示名（如恢复后的 ROUND_FIRST_FILL 带 -RCV）。
              // 如果完成事件也在这里改写 displayId，下面"精确匹配"就必然命中 ⇒ `-RCV` 门槛变成死代码，
              // **任何**整串认不出的完成事件都会认领同计数器的另一轮（第三轮 P5 的 Critical，已修）
              const occ = occurrenceOf(list, roundId);
              if (occ && !occ.completed) {
                occ.displayId = roundId;
                if (e.event === 'BUY_FILLED') {
                  // 首笔/末笔买入：补仓过程多长、建仓完等了多久，都从这两个时间戳算
                  if (occ.firstBuyMs === null) occ.firstBuyMs = ms;
                  occ.lastBuyMs = ms;
                } else if (e.event === 'RESET_CANCEL_SUCCESS') {
                  occ.resetReason = strOf(e.data, 'reason'); // SELL_FILLED = 正常卖出；PRICE_DEVIATION = 掐断重开
                  occ.resetMs = ms;
                }
              } else if (POSITION_EVENTS.has(e.event)) {
                // 这一轮的 NEW_ROUND 不在本窗口（短窗口每轮都会被切一刀）⇒ 这些成交/复位事件无处安放。
                // 不许假装它"已建仓=否"：只计数 + 出告警，把"这两列会偏低"说清楚
                s.orphanEvents++;
              }
            }
          }
          switch (e.event) {
            case 'NEW_ROUND':
              s.newRounds++;
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
              let matched: RoundOccurrence | undefined;
              if (ledgerKey !== '') {
                const list = ledgerOf(s, ledgerKey);
                // ① 精确匹配：同一计数器下最近一条**未完成**且字符串相同的记录
                const exact = [...list].reverse().find((o) => !o.completed && o.displayId === roundId);
                if (exact) {
                  exact.completed = true;
                  matched = exact;
                } else if (isRecoveredRoundId(roundId)) {
                  // ② 改名兜底：只认 `-RCV`（主仓 L763）。计数器会被复用/回绕，所以绝不无条件放宽
                  const open = [...list].reverse().find((o) => !o.completed);
                  if (open) {
                    open.completed = true;
                    open.displayId = roundId;
                    matched = open;
                  } else {
                    s.unmatchedCompletions++;
                  }
                } else {
                  s.unmatchedCompletions++; // 完成事件没有对应的开轮记录（窗口前开的轮在本窗口完成）
                  if (isErrorRoundId(roundId)) s.errorIdCompletions++;
                }
              } else {
                s.unmatchedCompletions++;
              }
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
                  // 补仓时长（首笔→末笔买入）：自己 join BUY_FILLED；没有买入时间戳就给 null（不猜）
                  refillHours:
                    matched && matched.firstBuyMs !== null && matched.lastBuyMs !== null
                      ? (matched.lastBuyMs - matched.firstBuyMs) / 3_600_000
                      : null,
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

      // 开轮不在本窗口的轮：它们的成交挂不到账本上 ⇒ "已建仓/存活"会偏低，必须说出来
      const orphans = [...bySymbol.values()].reduce((n, s) => n + s.orphanEvents, 0);
      if (orphans > 0) {
        warnings.push(
          `有 ${orphans} 条成交/复位事件属于**开轮不在本窗口**的轮（窗口把这一轮切成了两半）` +
            ' ⇒ 下面"已建仓/末笔买入后"对这些轮会偏低甚至显示为否；把窗口开长一点，或等批二的 stuck 视图（跨窗口）',
        );
      }

      // 恢复错误态 id 单独报：这类完成事件归因不可靠，必须让人看见"未完成列可能多算"
      const errorIdCompletions = [...bySymbol.values()].reduce((n, s) => n + s.errorIdCompletions, 0);
      if (errorIdCompletions > 0) {
        warnings.push(
          `有 ${errorIdCompletions} 条完成事件的轮次 id 是**恢复错误态**（R000-ERR-RCV）—— 主仓在启动恢复抛异常时会把轮次 id 落成这个常量，` +
            '计数器信息已丢失、无法与开轮记录配对 ⇒ "未完成"列可能多算，这些轮也不参与"最长卡轮"',
        );
      }

      const rows: string[][] = [];
      /** 未收口的轮：已建仓 / 末笔买入后多久 / 结局（仍在开 or 已被新轮取代/复位掐断） */
      interface OpenRoundRow {
        symbol: string;
        roundId: string;
        ageHours: number;
        hasPosition: boolean;
        lastBuyHours: number | null;
        outcome: string;
      }
      const unfinishedAging: OpenRoundRow[] = [];
      let totalNew = 0;
      let totalCompleted = 0;
      let totalUnfinished = 0;
      let totalSellProfitCents = 0;
      let totalRoundProfitCents = 0;

      for (const [symbol, s] of [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        // 未完成轮 = 账本里"开过但没配上完成事件"的出现记录。
        // NEW_ROUND 不带 roundId 的（旧版本日志）走计数差兜底：带 id 的新轮 = 账本记录数，
        // 没配上开轮记录的完成事件 = 无 id 完成的 + 窗口前开、本窗口完成的。
        const occurrences = [...s.ledger.values()].flat();
        const openOccurrences = occurrences.filter((o) => !o.completed);
        // "窗口内最新"必须按 (实例,币种) 判：同一 symbol 下不同实例的轮次时间不可比。
        // 同时把"存活到哪一刻"定下来：掐断 → 复位那一刻；被下一轮取代 → 下一轮开轮那一刻；
        // 否则 → 参考时刻。**不能一律算到参考时刻** —— 那会让"掐断型轮"的时长随查询窗口无限虚高
        // （真数据 R004：开轮 08:37、17:03 被 PRICE_DEVIATION 掐断，算到窗口结束是 15.4h，实际只活了 8.4h）。
        for (const list of groupByInstance(occurrences).values()) {
          const sorted = [...list].sort((a, b) => a.firstMs - b.firstMs);
          for (let i = 0; i < sorted.length; i++) {
            const occ = sorted[i];
            const nextMs = i + 1 < sorted.length ? sorted[i + 1].firstMs : null;
            occ.newestInWindow = nextMs === null;
            const cutMs = occ.resetReason !== null && occ.resetReason !== 'SELL_FILLED' ? occ.resetMs : null;
            const endMs = cutMs ?? nextMs ?? referenceMs;
            occ.aliveHours = Math.max(0, endMs - occ.firstMs) / 3_600_000;
          }
        }
        const idlessNew = Math.max(0, s.newRounds - occurrences.length);
        const idlessCompleted = s.unmatchedCompletions;
        const unfinished = openOccurrences.length + Math.max(0, idlessNew - idlessCompleted);

        for (const occ of openOccurrences) {
          // ⚠️ 参考时刻必须取 min(窗口结束, 此刻)：今天的窗口结束在**未来**，
          // 直接减窗口结束会报出一个还没发生过的时长（实测踩到：刚开 1 小时的轮显示"已运行 15.4h"）。
          // 再夹一层 0：注入时钟早于窗口时，负数时长比"0"更让人困惑
          //
          // "已建仓"这一列是**必须**的：真数据里出现过"8.4 小时一笔没成交、价格涨上去被偏离复位掐断"的轮，
          // 它压根没持仓，却被老版本的"未完成轮 Top（越大越像卡住）"排在第 1 名 —— 把"没接到货"答成了"卡单"。
          unfinishedAging.push({
            symbol,
            roundId: occ.displayId,
            ageHours: occ.aliveHours ?? 0,
            hasPosition: occ.firstBuyMs !== null,
            lastBuyHours: occ.lastBuyMs === null ? null : Math.max(0, referenceMs - occ.lastBuyMs) / 3_600_000,
            outcome: outcomeOf(occ),
          });
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
          heading: `最长卡轮 Top ${worstSorted.length}（已结束的轮）`,
          headers: ['币种', '轮次', '等待(h)', '补仓(h)', '整轮利润', '深跌'],
          note: '等待 = ROUND_COMPLETED.durationHours（主仓口径：**末次买入→卖出**，即"建完仓等价格回到止盈位"等了多久）。'
            + '补仓 = 首笔→末笔买入（自己 join BUY_FILLED；缺时间戳时为 "-"）。两段相加 ≈ 整轮跨度。',
          rows: worstSorted.map((w) => [
            w.symbol,
            w.roundId || '-',
            w.durationHours.toFixed(2),
            w.refillHours === null ? '-' : w.refillHours.toFixed(2),
            yuan(w.profitCents),
            w.crash ? '是' : '',
          ]),
        });
      }

      // 正在开的轮也要能看出"卡了多久" —— 只看已结束的轮会把"哪一轮卡住了"答反（M2 review 的 Warning）。
      // 排序：**已建仓的排在前面**（"卡"的经济含义是手里有仓位在等），同一类里再按已运行时长。
      // 真数据教训：R004 八小时零成交、被偏离复位掐断，却因为"已运行 15.4h"排在第一位 ⇒ 把"没接到货"答成了"卡单"。
      const agingSorted = [...unfinishedAging]
        .sort((a, b) => (a.hasPosition === b.hasPosition ? b.ageHours - a.ageHours : a.hasPosition ? -1 : 1))
        .slice(0, topN);
      if (agingSorted.length > 0) {
        const referenceLabel = ctx.window.toMs > ctx.now.getTime() ? '此刻' : '窗口结束';
        sections.push({
          heading: `未完成轮 Top ${agingSorted.length}（已建仓的在前）`,
          headers: ['币种', '轮次', '存活(h)', '已建仓', '末笔买入后(h)', '结局'],
          rows: agingSorted.map((a) => [
            a.symbol,
            a.roundId,
            a.ageHours.toFixed(1),
            a.hasPosition ? '是' : '否',
            a.lastBuyHours === null ? '-' : a.lastBuyHours.toFixed(1),
            a.outcome,
          ]),
          note: `存活 = 从开轮算到"结束那一刻"（复位掐断的算到复位、被下一轮取代的算到下一轮开轮，`
            + `${referenceLabel === '此刻' ? '否则算到此刻' : '否则算到窗口结束'}）；`
            + '已建仓（有无买入成交）才是"卡"的前提 —— "否"表示这一轮一直没等到买单成交（空等/被复位掐断），不是持仓卡住。'
            + ' 末笔买入后 = 建完仓又等了多久（更接近"卡了多久"）。'
            + ' 结局的"本窗口内未见收口"**不等于"现在还在开"**：窗口外的事件本窗口看不见（跨窗口现状见批二 stuck 视图）。',
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
