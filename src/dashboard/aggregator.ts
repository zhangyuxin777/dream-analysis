/**
 * dashboard 聚合器：事件分片 → 看板聚合数据（`DashboardSummary`，写 summary.json）。
 *
 * 口径逐条翻译自 `docs/legacy/build_summary.py`（Python 实现，对拍基准）——
 * 三条最难的隐含知识（与 ops 备忘 / DESIGN 一致）：
 * 1. **轮号会重号**：roundId 第一段（R059）不是唯一逻辑轮（实盘 R059 在 10-06、10-07 各开过一次），
 *    按 (symbol, 轮号) 聚合、按时间排序、遇 completed 切段，最后未完成的段 = 活轮；
 * 2. **恢复接管链**：`-RCV` 新 roundId 没有 BUY_FILLED，但仓位是真的 —— 段内多个 id 合并
 *    （买入累加、accCost 按链上差额算每笔花费）；
 * 3. **市价不从事件流取**：深跌防守期间 bidPrice 停更，一律从最新 ACCOUNT_OBSERVED
 *    的持仓估值反推（value / 数量）。
 *
 * 时区：事件 ts 为 UTC，展示与日期归属一律北京时间（UTC+8，与契约时区一致）。
 * 纯函数：事件源与"现在"都注入，不写盘（写盘在 CLI/常驻接线层）。
 */
import { EventSourceLike, LoadedEventLike } from '../analysis/types';
import {
  DashboardCrashEvent,
  DashboardCompletedRound,
  DashboardDailyStat,
  DashboardEquityPoint,
  DashboardInstanceData,
  DashboardStuckRound,
  DashboardSummary,
} from './types';

const BEIJING_OFFSET_MS = 8 * 3600_000;

/** 北京时间 ISO（+08:00 带毫秒），替代 toISOString（UTC） */
export function beijingIsoOf(ms: number): string {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return d.toISOString().replace('Z', '+08:00');
}

/** 北京时间日期 YYYY-MM-DD */
export function beijingDayOfMs(ms: number): string {
  return beijingIsoOf(ms).slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** 轮号 = roundId 第一段（`R596-191307-RCV` → `R596`）；与 roundsCore.roundCounterOf 同规则 */
function roundNoOf(roundId: string): string {
  const seg = roundId.split('-')[0];
  return seg === '' ? roundId : seg;
}

/** 交易对去掉 FDUSD 后缀（ETHFDUSD → ETH）——与快照 balances 的 asset 键对齐 */
function coinOf(symbol: string): string {
  return symbol.replace(/FDUSD$/, '');
}

function num(v: unknown): number {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : 0;
}

interface RawEvent {
  tsMs: number;
  seq: number;
  event: string;
  symbol: string;
  roundId: string;
  data: Record<string, unknown>;
}

interface Segment {
  events: RawEvent[];
  completed: boolean;
  symbol: string;
  roundNo: string;
}

/** 收集一个实例的全部事件（按 ts、seq 升序，与分片内序一致）；顺带返回是否有非 final 分片（当天数据「暂定」） */
async function loadEvents(source: EventSourceLike, instance: string): Promise<{ events: RawEvent[]; provisional: boolean }> {
  const days = source.availableDays(instance);
  const window = { label: '全部', fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, days };
  const events: RawEvent[] = [];
  let provisional = false;
  const stats = await source.scan({ window, instance }, (e: LoadedEventLike) => {
    const tsMs = Date.parse(e.ts);
    if (!Number.isFinite(tsMs)) return;
    events.push({
      tsMs,
      seq: typeof (e as unknown as { seq?: unknown }).seq === 'number' ? (e as unknown as { seq: number }).seq : 0,
      event: e.event,
      symbol: e.symbol ?? '',
      roundId: typeof e.roundId === 'string' ? e.roundId : '',
      data: (e.data ?? {}) as Record<string, unknown>,
    });
  });
  provisional = stats.provisional;
  events.sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq);
  return { events, provisional };
}

/** 汇总单个实例（口径与 build_summary.py 的 summarize() 逐条对应） */
export function summarizeInstance(
  instance: string,
  events: RawEvent[],
  nowMs: number,
  opts: { provisional?: boolean } = {},
): DashboardInstanceData {
  const datasetEndMs = events.length > 0 ? events[events.length - 1].tsMs : nowMs;

  // 资金曲线：每个 ACCOUNT_OBSERVED 快照一点（FDUSD 的可用/锁定 + 总权益 + 各币种持仓）
  const equity: DashboardEquityPoint[] = [];
  // 每币种最新市价：从持仓估值反推（深跌期间 bidPrice 停更，不可靠）
  const lastPrice = new Map<string, number>();
  for (const e of events) {
    if (e.event !== 'ACCOUNT_OBSERVED') continue;
    const balances = Array.isArray(e.data.balances) ? e.data.balances as Array<Record<string, unknown>> : [];
    let free = 0;
    let locked = 0;
    for (const b of balances) {
      if (b.asset !== 'FDUSD') continue;
      free += num(b.qtyFree);
      locked += num(b.qtyLocked);
    }
    const total = num(e.data.totalValue);
    const coins: Record<string, { qty: number; value: number; price: number }> = {};
    for (const b of balances) {
      if (b.asset === 'FDUSD') continue;
      const qty = num(b.qtyFree) + num(b.qtyLocked);
      const value = num(b.value);
      if (qty > 0 && value > 0) {
        coins[coinOf(String(b.asset))] = { qty: round6(qty), value: round2(value), price: round2(value / qty) };
        lastPrice.set(String(b.asset), round2(value / qty));
      }
    }
    equity.push({
      t: beijingIsoOf(e.tsMs),
      total: round2(total),
      free: round2(free),
      locked: round2(locked),
      idlePct: total > 0 ? Math.round((free / total) * 1000) / 10 : 0,
      coins,
    });
  }

  // 入金检测：相邻快照权益跳升 > 3% 记为一次注资
  const deposits: Array<{ t: string; amount: number }> = [];
  for (let i = 1; i < equity.length; i++) {
    const a = equity[i - 1];
    const b = equity[i];
    if (a.total > 0 && b.total - a.total > a.total * 0.03) {
      deposits.push({ t: b.t, amount: round2(b.total - a.total) });
    }
  }
  const depositByT = new Map(deposits.map((d) => [d.t, d.amount]));

  // 每日净盈亏（权益口径，含浮盈浮亏）：相邻快照权益差按后一个快照的北京时间日期归属，剔除入金
  const dayNet = new Map<string, number>();
  for (let i = 1; i < equity.length; i++) {
    const a = equity[i - 1];
    const b = equity[i];
    const day = b.t.slice(0, 10);
    const net = b.total - a.total - (depositByT.get(b.t) ?? 0);
    dayNet.set(day, round2((dayNet.get(day) ?? 0) + net));
  }

  // 轮次分段：按 (symbol, 轮号) 切段，遇 completed 开始新段（-RCV 同轮号自然并入）
  const segments: Segment[] = [];
  let current = new Map<string, Segment>();
  for (const e of events) {
    if (e.roundId === '') continue;
    const roundNo = roundNoOf(e.roundId);
    const key = `${e.symbol}.${roundNo}`;
    let seg = current.get(key);
    if (!seg || seg.completed) {
      seg = { events: [], completed: false, symbol: e.symbol, roundNo };
      segments.push(seg);
      current.set(key, seg);
    }
    seg.events.push(e);
    if (e.event === 'ROUND_COMPLETED') seg.completed = true;
  }

  const completedRounds: DashboardCompletedRound[] = [];
  const stuck: DashboardStuckRound[] = [];
  let resetKilled = 0;
  // 段内最新一次挂卖单参数（两种格式都认：老格式 data.params 是 JSON 字符串，新格式 price 直接在 data 上）
  const sellPriceOf = (events: RawEvent[]): number | null => {
    let price: number | null = null;
    for (const e of events) {
      if (e.event !== 'PROFIT_PLACE_PARAMS') continue;
      let p = Number(e.data.price ?? NaN);
      if (!Number.isFinite(p)) {
        const m = /"price":([\d.]+)/.exec(typeof e.data.params === 'string' ? e.data.params : '');
        if (m) p = Number(m[1]);
      }
      if (Number.isFinite(p)) price = p;
    }
    return price;
  };
  for (const seg of segments) {
    const comp = seg.events.find((e) => e.event === 'ROUND_COMPLETED');
    if (comp) {
      completedRounds.push({
        symbol: seg.symbol,
        roundNo: seg.roundNo,
        t: beijingIsoOf(comp.tsMs),
        profit: num(comp.data.profit),
        hours: Math.round(num(comp.data.durationHours) * 100) / 100,
        accCost: num(comp.data.accCost),
        // 深跌轮判定：完成事件自带 isCrashMode 最准，但策略静默退出深跌时该标记是 false
        // （实盘 10/12：BTC R073 在深跌中开仓、完成时 isCrashMode=false，且全程无 CRASH_EXITED）
        // —— 段内出现过 CRASH_ENTERED 的完成轮，LP 视角就是"深跌模式完成轮"，两种命中都算
        isCrash: comp.data.isCrashMode === true || seg.events.some((e) => e.event === 'CRASH_ENTERED'),
        avgBuy: num(comp.data.avgBuyPrice),
        sell: num(comp.data.sellPrice),
        resets: seg.events.filter((e) => e.event === 'WORKER_DEVIATION_RESET').length,
      });
      continue;
    }
    // 未完成段
    const resets = seg.events.filter((e) => e.event === 'WORKER_DEVIATION_RESET').length;
    const buys = seg.events.filter((e) => e.event === 'BUY_FILLED');
    if (resets > 0 && buys.length === 0) resetKilled++;
    if (buys.length === 0) continue;
    const lastBuy = buys[buys.length - 1];
    // accCost 是链上累计花费：用差值算每格数量，得出真实加权均价
    let totalCost = 0;
    let totalQty = 0;
    let prev = 0;
    for (const b of buys) {
      const c = num(b.data.accCost);
      const segCost = Math.max(c - prev, 0);
      prev = c;
      const p = num(b.data.buyPrice);
      if (p > 0) {
        totalCost += segCost;
        totalQty += segCost / p;
      }
    }
    const avgBuy = totalQty > 0 ? round2(totalCost / totalQty) : num(lastBuy.data.buyPrice);
    const qty = round6(totalQty);
    const accCost = round2(prev);
    const lp = lastPrice.get(coinOf(seg.symbol)) ?? null;
    stuck.push({
      symbol: seg.symbol,
      roundNo: seg.roundNo,
      since: beijingIsoOf(lastBuy.tsMs),
      hours: Math.round(((datasetEndMs - lastBuy.tsMs) / 3600_000) * 10) / 10,
      avgBuy,
      qty,
      accCost,
      lastPrice: lp,
      floating: lp !== null && totalQty > 0 ? round2(totalQty * (lp - avgBuy)) : null,
      floatingPct: lp !== null && avgBuy > 0 ? Math.round(((lp - avgBuy) / avgBuy) * 10_000) / 100 : null,
      sellPrice: sellPriceOf(seg.events),
      resets,
      reductions: seg.events.filter((e) => e.event === 'DYNAMIC_PROFIT_REDUCED').length,
      crash: seg.events.some((e) => e.event === 'CRASH_ENTERED'),
      lastEvent: seg.events[seg.events.length - 1].event,
    });
  }
  stuck.sort((a, b) => b.hours - a.hours);

  // 日维度（北京时间）；账户级与按币级两套并行累计（币种维度的净盈亏拆不出来，不给 net）
  const dailyByDay = new Map<string, DashboardDailyStat>();
  const dailyByCoinDay = new Map<string, DashboardDailyStat>();
  const emptyDaily = (day: string): DashboardDailyStat => ({ date: day, profit: 0, rounds: 0, new: 0, resets: 0, crashIn: 0, crashOut: 0, sells: 0 });
  for (const e of events) {
    const day = beijingDayOfMs(e.tsMs);
    let d = dailyByDay.get(day);
    if (!d) {
      d = emptyDaily(day);
      dailyByDay.set(day, d);
    }
    let dc: DashboardDailyStat | null = null;
    // ACCOUNT_OBSERVED 的 symbol 是 '__account__'（账户级标记，不是币种），不进按币维度
    if (e.symbol !== '' && e.symbol !== '__account__') {
      const key = `${coinOf(e.symbol)}|${day}`;
      dc = dailyByCoinDay.get(key) ?? null;
      if (!dc) {
        dc = emptyDaily(day);
        dailyByCoinDay.set(key, dc);
      }
    }
    const bump = (stat: DashboardDailyStat | null): void => {
      if (!stat) return;
      switch (e.event) {
        case 'ROUND_COMPLETED':
          stat.profit = round2(stat.profit + num(e.data.profit));
          stat.rounds += 1;
          break;
        case 'NEW_ROUND': stat.new += 1; break;
        case 'WORKER_DEVIATION_RESET': stat.resets += 1; break;
        case 'CRASH_ENTERED': stat.crashIn += 1; break;
        case 'CRASH_EXITED': stat.crashOut += 1; break;
        case 'SELL_FILLED': stat.sells += 1; break;
        default: break;
      }
    };
    bump(d);
    bump(dc);
  }
  // 合并每日净盈亏（权益口径）；无快照的日期保持 net=null
  for (const [day, net] of dayNet) {
    const d = dailyByDay.get(day);
    if (d) d.net = net;
    else dailyByDay.set(day, { date: day, profit: 0, net, rounds: 0, new: 0, resets: 0, crashIn: 0, crashOut: 0, sells: 0 });
  }
  const daily = [...dailyByDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dailyByCoin: Record<string, DashboardDailyStat[]> = {};
  for (const [key, stat] of dailyByCoinDay) {
    const coin = key.slice(0, key.indexOf('|'));
    (dailyByCoin[coin] ??= []).push(stat);
  }
  for (const list of Object.values(dailyByCoin)) list.sort((a, b) => a.date.localeCompare(b.date));

  // 深跌事件：进入/退出按币种配对（窗口内）。
  // 退出判定（2026-10-12 方案②，LP 视角的"事实结束"）：策略静默退出深跌时**不发 CRASH_EXITED**
  // （实盘 BTC R073：10/7 进入防守、10/12 仓位获利了结，但事件流里永远没有退出）——
  // 因此"进入深跌的那一轮完成卖出"即视为事件结束（end = 完成时刻）；真 CRASH_EXITED 优先。
  const crashes: DashboardCrashEvent[] = [];
  const openCrash = new Map<string, DashboardCrashEvent & { entryMs: number; roundNo: string }>();
  const closeCrash = (symbol: string, tsMs: number): void => {
    const c = openCrash.get(symbol);
    if (!c) return;
    c.end = beijingIsoOf(tsMs);
    crashes.push(c);
    openCrash.delete(symbol);
  };
  for (const e of events) {
    if (e.event === 'CRASH_ENTERED') {
      openCrash.set(e.symbol, {
        symbol: e.symbol,
        start: beijingIsoOf(e.tsMs),
        entryMs: e.tsMs,
        roundNo: e.roundId === '' ? '' : roundNoOf(e.roundId),
        dropPct: Math.round(num(e.data.dropPercent) * 10_000) / 100,
        end: null,
      });
    } else if (e.event === 'CRASH_EXITED') {
      closeCrash(e.symbol, e.tsMs);
    } else if (e.event === 'ROUND_COMPLETED' && openCrash.has(e.symbol)) {
      // 恢复接管链的完成轮挂在 -RCV 新 id 下（roundNo 不变），按轮号匹配即可
      const c = openCrash.get(e.symbol)!;
      if (c.roundNo !== '' && roundNoOf(e.roundId) === c.roundNo && e.tsMs > c.entryMs) {
        closeCrash(e.symbol, e.tsMs);
      }
    }
  }
  crashes.push(...openCrash.values());

  const totalProfit = round2(completedRounds.reduce((s, r) => s + r.profit, 0));
  const newCount = daily.reduce((s, d) => s + d.new, 0);
  const resetCount = daily.reduce((s, d) => s + d.resets, 0);
  const resetsInsideRounds =
    completedRounds.reduce((s, r) => s + r.resets, 0) + stuck.reduce((s, r) => s + r.resets, 0);
  const durations = completedRounds.map((r) => r.hours).sort((a, b) => a - b);

  const firstEquity = equity.length > 0 ? equity[0].total : null;
  const lastEquity = equity.length > 0 ? equity[equity.length - 1].total : null;

  return {
    instance,
    datasetEnd: beijingIsoOf(datasetEndMs),
    datasetEndProvisional: opts.provisional ?? false,
    range: {
      from: equity.length > 0 ? equity[0].t : null,
      to: equity.length > 0 ? equity[equity.length - 1].t : null,
    },
    equity,
    daily,
    dailyByCoin,
    completedRounds,
    stuck,
    crashes,
    deposits,
    stats: {
      firstEquity,
      lastEquity,
      equityDelta: firstEquity !== null && lastEquity !== null ? round2(lastEquity - firstEquity) : null,
      realizedProfit: totalProfit,
      completedCount: completedRounds.length,
      newCount,
      resetCount,
      resetKilledCount: resetKilled,
      medianRoundHours: durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null,
      crashRoundCount: completedRounds.filter((r) => r.isCrash).length,
      idleMedian: equity.length > 0 ? equity.map((p) => p.idlePct).sort((a, b) => a - b)[Math.floor(equity.length / 2)] : null,
      idleCurrent: equity.length > 0 ? equity[equity.length - 1].idlePct : null,
      avgProfitPerRound: completedRounds.length > 0 ? round2(totalProfit / completedRounds.length) : null,
      resetsInsideRounds,
    },
  };
}

/**
 * 汇总全部实例。`nowMs` 注入（可测性）：只在"完全没有事件"时兜底用。
 * 跳过 localtest / .tmp（与 Python 的 SKIP_DIRS 一致）。
 */
export async function aggregateDashboard(
  source: EventSourceLike,
  nowMs: number,
  opts: { skipInstances?: string[] } = {},
): Promise<DashboardSummary> {
  const skip = new Set(opts.skipInstances ?? ['localtest', '.tmp']);
  const instances: Record<string, DashboardInstanceData> = {};
  for (const instance of source.instances()) {
    if (skip.has(instance) || instance.startsWith('.')) continue;
    const { events, provisional } = await loadEvents(source, instance);
    instances[instance] = summarizeInstance(instance, events, nowMs, { provisional });
  }
  return {
    generatedAt: beijingIsoOf(nowMs),
    timezone: 'Asia/Shanghai',
    instances,
  };
}
