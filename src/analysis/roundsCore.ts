/**
 * 轮次状态的**唯一收集器**（rounds 与 stuck 共用）。
 *
 * 身份规则（大哥 2026-10-04 定）：**取第一段中划线之前的 `R<计数器>`** ——
 * `R596-190959` / `R596-191307-RCV` / `R000-ERR-RCV` 都归到 `R596` / `R000`。
 * 主仓重启时能从本地缓存恢复出准确的计数器，所以计数器就是稳定的轮次身份；
 * `-RCV` 与时间戳后缀只是**同一轮的显示名**（恢复时会换），不参与识别。
 *
 * 这条规则取代了此前那套"按 (实例,币种,计数器) 记一串出现记录 + `-RCV` 兜底 + 错误态 id 排除"的账本 ——
 * 那套东西是在消费端重建身份，属于**过度设计**（数据侧本来就规整，消费端只该过滤与关联）。
 *
 * 仍然保留两个**安全网**（都不该触发，触发就是数据侧或假设出了问题，必须能看见）：
 * ① 同一个 `R<计数器>` 又出现 `NEW_ROUND`（计数器被复用）⇒ 当作"上一轮被顶掉 + 新的一轮"，并计数告警；
 * ② 一条轮次状态是被**非开轮事件**创建的（开轮不在扫描范围内，比如窗口把它切了一半）⇒ 标记
 *    `startOutsideScan`，让上层把"存活时长"当下界显示，而不是假装知道起点。
 */
import { LoadedEventLike, numOf, strOf } from './types';

/** 轮次身份：第一段中划线之前（`R596-191307-RCV` → `R596`） */
export function roundCounterOf(roundId: string): string {
  const seg = roundId.split('-')[0];
  return seg === '' ? roundId : seg;
}

/** 账户观测（`ACCOUNT_OBSERVED`）—— 仓位/市值只能从这里**直接观测**，不靠推断 */
export interface AccountSnapshot {
  instance: string;
  ms: number;
  totalValue: number | null;
  exchange: string | null;
  /** 资产 → { 可用/锁仓数量, 市值 } */
  balances: Map<string, { qtyFree: number; qtyLocked: number; value: number | null }>;
}

export interface RoundState {
  /** `R<计数器>` */
  counter: string;
  instance: string;
  /** 币种（收集时就带上，省得报表层反查） */
  symbol: string;
  /** 最近一次见到的完整 id（显示用；恢复改名后显示现状） */
  displayId: string;
  /** 首次见到的时间 */
  firstMs: number;
  /** 开轮（NEW_ROUND）不在扫描范围内 ⇒ firstMs 只是"范围内首条事件"，存活时长只是下界 */
  startOutsideScan: boolean;
  completed: boolean;
  /** 首笔 / 末笔买入成交时间（补仓过程多久、建仓后等了多久都靠它） */
  firstBuyMs: number | null;
  lastBuyMs: number | null;
  /** 复位原因（`RESET_CANCEL_SUCCESS.reason`；`SELL_FILLED` = 正常卖出，其余 = 掐断重开） */
  resetReason: string | null;
  resetMs: number | null;
  /** 买入成交笔数（补仓次数 ≈ 笔数 − 1） */
  buyFills: number;
  /** 累计买入成本（最近一条 BUY_FILLED 的 `accCost`，事件里的**观测值**） */
  accCost: number | null;
  /** 完成事件带来的字段（都在事件里，直接取，不派生） */
  completedAtMs: number | null;
  /** `ROUND_COMPLETED.durationHours`（主仓口径：**末次买入→卖出**） */
  durationHours: number | null;
  /** `ROUND_COMPLETED.profit`（整数分） */
  profitCents: number | null;
  /** `ROUND_COMPLETED.isCrashMode` */
  isCrashMode: boolean;
  /** 同一计数器又开了一轮（计数器被复用）—— 不该发生，发生就告警 */
  reusedCount: number;
}

export interface SymbolRoundStats {
  newRounds: number;
  completedRounds: number;
  buyFills: number;
  sellFills: number;
  orderFills: number;
  crashEntered: number;
  /** 金额一律整数分累加 */
  sellProfitCents: number;
  roundProfitCents: number;
  /** 键 = `实例\\0币种\\0R<计数器>`（同一 symbol 下多实例不会串） */
  rounds: Map<string, RoundState>;
  /** 不带 roundId 的 NEW_ROUND 数（旧版本日志；只能按计数差兜底） */
  newRoundsWithoutId: number;
  /** 不带 roundId 的完成事件数（与上面的新轮配对） */
  idlessCompletions: number;
  /** 同一轮重复上报的完成事件数（重复计数，供告警） */
  duplicateCompletions: number;
}

export function newSymbolRoundStats(): SymbolRoundStats {
  return {
    newRounds: 0, completedRounds: 0, buyFills: 0, sellFills: 0, orderFills: 0, crashEntered: 0,
    sellProfitCents: 0, roundProfitCents: 0,
    rounds: new Map(), newRoundsWithoutId: 0, idlessCompletions: 0, duplicateCompletions: 0,
  };
}

export interface RoundCollector {
  /** 喂一条事件（必须按 (实例, 时间) 升序） */
  onEvent(e: LoadedEventLike & { instance: string }): void;
  symbols(): Map<string, SymbolRoundStats>;
  accounts(): Map<string, AccountSnapshot>;
  /** 实例 → 最后一条事件的时间（判断"这个实例还在产出吗"，别把停了的实例的旧轮当成正在卡住） */
  lastSeen(): Map<string, number>;
}

export function createRoundCollector(): RoundCollector {
  const bySymbol = new Map<string, SymbolRoundStats>();
  const accounts = new Map<string, AccountSnapshot>();
  const lastSeen = new Map<string, number>();

  const statsOf = (symbol: string): SymbolRoundStats => {
    let s = bySymbol.get(symbol);
    if (!s) {
      s = newSymbolRoundStats();
      bySymbol.set(symbol, s);
    }
    return s;
  };

  const onEvent = (e: LoadedEventLike & { instance: string }): void => {
    const ms = Date.parse(e.ts);
    if (Number.isFinite(ms)) {
      const prev = lastSeen.get(e.instance);
      if (prev === undefined || ms > prev) lastSeen.set(e.instance, ms);
    }

    if (e.event === 'ACCOUNT_OBSERVED') {
      const balances: AccountSnapshot['balances'] = new Map();
      const raw = (e.data as Record<string, unknown> | undefined)?.balances;
      if (Array.isArray(raw)) {
        for (const b of raw) {
          if (!b || typeof b !== 'object') continue;
          const item = b as Record<string, unknown>;
          const asset = typeof item.asset === 'string' ? item.asset : '';
          if (asset === '') continue;
          balances.set(asset, {
            qtyFree: Number(item.qtyFree ?? 0),
            qtyLocked: Number(item.qtyLocked ?? 0),
            value: item.value === undefined || item.value === null ? null : Number(item.value),
          });
        }
      }
      const prev = accounts.get(e.instance);
      if (!prev || ms >= prev.ms) {
        accounts.set(e.instance, {
          instance: e.instance, ms,
          totalValue: numOf(e.data, 'totalValue'),
          exchange: strOf(e.data, 'exchange'),
          balances,
        });
      }
      return;
    }

    const symbol = e.symbol ?? '(无 symbol)';
    const s = statsOf(symbol);
    const roundId = e.roundId ?? strOf(e.data, 'roundId') ?? '';
    const counter = roundId === '' ? '' : roundCounterOf(roundId);

    if (counter !== '') {
      const key = `${e.instance}\u0000${symbol}\u0000${counter}`;
      let r = s.rounds.get(key);
      if (!r) {
        // 被非开轮事件创建（开轮在扫描范围外）⇒ 起点只是下界，必须标出来
        r = {
          counter, instance: e.instance, symbol, displayId: roundId, firstMs: ms,
          startOutsideScan: e.event !== 'NEW_ROUND', completed: false,
          firstBuyMs: null, lastBuyMs: null, resetReason: null, resetMs: null, buyFills: 0, accCost: null,
          completedAtMs: null, durationHours: null, profitCents: null, isCrashMode: false, reusedCount: 0,
        };
        s.rounds.set(key, r);
      } else {
        r.displayId = roundId;
      }

      switch (e.event) {
        case 'NEW_ROUND':
          // 正常开轮：这条记录刚创建时 firstMs === ms；时间不同 ⇒ 同一个计数器被复用（不该发生）
          if (r.firstMs !== ms) {
            r.reusedCount++;
            r.firstMs = ms;
            r.startOutsideScan = false;
            r.completed = false;
            r.firstBuyMs = null;
            r.lastBuyMs = null;
            r.resetReason = null;
            r.resetMs = null;
            r.buyFills = 0;
            r.accCost = null;
          }
          s.newRounds++;
          break;
        case 'ROUND_COMPLETED':
          s.completedRounds++;
          if (!r.completed) {
            r.completed = true;
            r.displayId = roundId;
            r.completedAtMs = ms;
            r.durationHours = numOf(e.data, 'durationHours');
            const p = numOf(e.data, 'profit');
            r.profitCents = p === null ? null : Math.round(p * 100);
            r.isCrashMode = (e.data as Record<string, unknown> | undefined)?.isCrashMode === true;
          } else {
            s.duplicateCompletions++; // 同一轮重复上报完成
          }
          {
            const profit = numOf(e.data, 'profit');
            if (profit !== null) s.roundProfitCents += Math.round(profit * 100);
          }
          break;
        case 'BUY_FILLED': {
          s.buyFills++;
          r.buyFills++;
          if (r.firstBuyMs === null) r.firstBuyMs = ms;
          r.lastBuyMs = ms;
          const accCost = numOf(e.data, 'accCost');
          if (accCost !== null) r.accCost = accCost;
          break;
        }
        case 'SELL_FILLED': {
          s.sellFills++;
          const profit = numOf(e.data, 'profit');
          if (profit !== null) s.sellProfitCents += Math.round(profit * 100);
          break;
        }
        case 'RESET_CANCEL_SUCCESS':
          r.resetReason = strOf(e.data, 'reason');
          r.resetMs = ms;
          break;
        case 'ORDER_FILLED': s.orderFills++; break;
        case 'CRASH_ENTERED': s.crashEntered++; break;
        default: break; // ROUND_FIRST_FILL / ATR / 配置类等：只用来认轮（上面的 get/create 已完成）
      }
      return;
    }

    // 没有 roundId（旧版本日志）：只能按事件计数，无法归轮
    switch (e.event) {
      case 'NEW_ROUND': s.newRounds++; s.newRoundsWithoutId++; break;
      case 'ROUND_COMPLETED': {
        s.completedRounds++;
        s.idlessCompletions++;
        const profit = numOf(e.data, 'profit');
        if (profit !== null) s.roundProfitCents += Math.round(profit * 100);
        break;
      }
      case 'BUY_FILLED': s.buyFills++; break;
      case 'SELL_FILLED': {
        s.sellFills++;
        const profit = numOf(e.data, 'profit');
        if (profit !== null) s.sellProfitCents += Math.round(profit * 100);
        break;
      }
      case 'ORDER_FILLED': s.orderFills++; break;
      case 'CRASH_ENTERED': s.crashEntered++; break;
      default: break;
    }
  };

  return { onEvent, symbols: () => bySymbol, accounts: () => accounts, lastSeen: () => lastSeen };
}

/** 未收口轮的结局（全部来自观测）：复位掐断 / 已被新轮取代 / <scope>内未见收口 */
export function outcomeOf(state: RoundState, nextFirstMs: number | null, scopeLabel = '范围内'): string {
  if (state.resetReason !== null && state.resetReason !== 'SELL_FILLED') return `复位掐断(${state.resetReason})`;
  return nextFirstMs === null ? `${scopeLabel}内未见收口` : '已被新轮取代';
}

/**
 * 存活时长（小时）：掐断 → 复位时刻；被取代 → 下一轮开轮时刻；否则 → 参考时刻。
 * 取**先到者**（真数据里复位行总在下一次开轮之前，但不能假设这个顺序）。
 */
export function aliveHours(state: RoundState, nextFirstMs: number | null, referenceMs: number): number {
  const cutMs = state.resetReason !== null && state.resetReason !== 'SELL_FILLED' ? state.resetMs : null;
  const ends = [cutMs, nextFirstMs].filter((v): v is number => v !== null);
  const endMs = ends.length > 0 ? Math.min(...ends) : referenceMs;
  return Math.max(0, endMs - state.firstMs) / 3_600_000;
}

/** 按实例分组 + 按开轮时间排序（同一 symbol 下不同实例的轮次时间不可比） */
export function groupByInstance(rounds: RoundState[]): Map<string, RoundState[]> {
  const out = new Map<string, RoundState[]>();
  for (const r of [...rounds].sort((a, b) => a.firstMs - b.firstMs || a.counter.localeCompare(b.counter))) {
    const list = out.get(r.instance);
    if (list) list.push(r);
    else out.set(r.instance, [r]);
  }
  return out;
}

/** 每个 (实例,币种) 里"下一轮的开轮时间"（用于判断"已被新轮取代"与存活时长） */
export function nextFirstMsOf(rows: RoundState[], index: number): number | null {
  return index + 1 < rows.length ? rows[index + 1].firstMs : null;
}
