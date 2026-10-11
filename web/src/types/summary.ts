export interface EquityPoint {
  t: string
  total: number
  free: number
  locked: number
  idlePct: number
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
  resets: number
  reductions: number
  crash: boolean
  lastEvent: string
}

export interface CrashEvent {
  symbol: string
  start: string
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
  range: { from: string | null; to: string | null }
  equity: EquityPoint[]
  daily: DailyStat[]
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
