export interface CoinHolding {
  qty: number
  value: number
  price: number
}

export interface EquityPoint {
  t: string
  total: number
  free: number
  locked: number
  idlePct: number
  /** 该快照时刻各币种持仓（价格 = 市值÷数量，由聚合器反推） */
  coins: Record<string, CoinHolding>
}

export interface DailyStat {
  date: string
  profit: number
  net: number | null
  rounds: number
  new: number
  resets: number
  crashIn: number
  crashOut: number
  sells: number
}

export interface CompletedRound {
  symbol: string
  roundNo: string
  t: string
  profit: number
  hours: number
  accCost: number
  isCrash: boolean
  avgBuy: number
  sell: number
  resets: number
}

export interface StuckRound {
  symbol: string
  roundNo: string
  since: string
  hours: number
  avgBuy: number
  qty: number
  accCost: number
  lastPrice: number | null
  floating: number | null
  floatingPct: number | null
  /** 当前挂卖单价（卖单撤下未重挂时为 null） */
  sellPrice: number | null
  resets: number
  reductions: number
  crash: boolean
  lastEvent: string
}

export interface CrashEvent {
  symbol: string
  start: string
  /** 深跌进入时刻（ms），聚合器直出 */
  entryMs: number
  /** 进入深跌时的轮号（恢复接管链按轮号匹配退出） */
  roundNo: string
  dropPct: number
  end: string | null
}

export interface InstanceStats {
  firstEquity: number
  lastEquity: number
  equityDelta: number
  realizedProfit: number
  completedCount: number
  newCount: number
  resetCount: number
  resetKilledCount: number
  medianRoundHours: number | null
  crashRoundCount: number
  idleMedian: number | null
  idleCurrent: number | null
  avgProfitPerRound: number | null
  resetsInsideRounds: number
}

export interface InstanceData {
  instance: string
  datasetEnd: string
  /** 数据末尾当天分片还不是 final（当天数据会修订，展示侧标「暂定」） */
  datasetEndProvisional: boolean
  range: { from: string | null; to: string | null }
  equity: EquityPoint[]
  daily: DailyStat[]
  /** 按币种的日维度（net 是账户级口径拆不到币，单币种条目一律无 net） */
  dailyByCoin: Record<string, DailyStat[]>
  completedRounds: CompletedRound[]
  stuck: StuckRound[]
  crashes: CrashEvent[]
  deposits: { t: string; amount: number }[]
  stats: InstanceStats
}

export interface Summary {
  generatedAt: string
  timezone: string
  instances: Record<string, InstanceData>
}
