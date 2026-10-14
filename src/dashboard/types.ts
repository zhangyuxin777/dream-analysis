/**
 * dashboard 聚合器的输出类型 —— 与 `web/src/types/summary.ts` 完全一致
 * （那边是前端消费的真源，这里是生产侧的同形状声明；两边刻意不互相 import，
 * web 是独立子工程）。
 *
 * 口径真源：`docs/legacy/build_summary.py`（Python 实现，对拍基准，已退役）。
 * 2026-10-11 由 Python 逐条翻译为 TS，同分片产物逐字段 diff 全过后切换。
 */

/** 单个权益快照里某币种的持仓明细（市值/数量从 balances 直接读，价格 = 市值÷数量反推） */
export interface DashboardCoinHolding {
  qty: number;
  value: number;
  price: number;
}

export interface DashboardEquityPoint {
  t: string;
  total: number;
  free: number;
  locked: number;
  idlePct: number;
  /** 该快照时刻各币种的持仓（无持仓的币种不出现；账户级字段拆不到币，所以另给这个） */
  coins: Record<string, DashboardCoinHolding>;
}

export interface DashboardDailyStat {
  date: string;
  profit: number;
  /** 权益口径每日净盈亏（该日无快照对比时缺省此键，与 Python 输出对齐） */
  net?: number | null;
  rounds: number;
  new: number;
  resets: number;
  crashIn: number;
  crashOut: number;
  sells: number;
}

export interface DashboardCompletedRound {
  symbol: string;
  roundNo: string;
  t: string;
  profit: number;
  hours: number;
  accCost: number;
  isCrash: boolean;
  avgBuy: number;
  sell: number;
  resets: number;
}

export interface DashboardStuckRound {
  symbol: string;
  roundNo: string;
  since: string;
  hours: number;
  avgBuy: number;
  qty: number;
  accCost: number;
  lastPrice: number | null;
  floating: number | null;
  floatingPct: number | null;
  /** 当前挂卖单价（段内最新 PROFIT_PLACE_PARAMS；卖单撤下未重挂时可能为 null） */
  sellPrice: number | null;
  resets: number;
  reductions: number;
  crash: boolean;
  lastEvent: string;
}

export interface DashboardCrashEvent {
  symbol: string;
  start: string;
  dropPct: number;
  end: string | null;
}

export interface DashboardInstanceStats {
  firstEquity: number | null;
  lastEquity: number | null;
  equityDelta: number | null;
  realizedProfit: number;
  completedCount: number;
  newCount: number;
  resetCount: number;
  resetKilledCount: number;
  medianRoundHours: number | null;
  crashRoundCount: number;
  idleMedian: number | null;
  idleCurrent: number | null;
  avgProfitPerRound: number | null;
  resetsInsideRounds: number;
}

export interface DashboardInstanceData {
  instance: string;
  datasetEnd: string;
  /** 数据末尾当天分片还不是 final（当天数据会随后续快照修订，展示侧应标「暂定」） */
  datasetEndProvisional: boolean;
  range: { from: string | null; to: string | null };
  equity: DashboardEquityPoint[];
  daily: DashboardDailyStat[];
  /** 按币种的日维度（键 = 去掉 FDUSD 后缀的币种，如 BTC/ETH）；net 是账户级口径拆不到币，此处的条目一律无 net */
  dailyByCoin: Record<string, DashboardDailyStat[]>;
  completedRounds: DashboardCompletedRound[];
  stuck: DashboardStuckRound[];
  crashes: DashboardCrashEvent[];
  deposits: Array<{ t: string; amount: number }>;
  stats: DashboardInstanceStats;
}

export interface DashboardSummary {
  generatedAt: string;
  timezone: string;
  instances: Record<string, DashboardInstanceData>;
}
