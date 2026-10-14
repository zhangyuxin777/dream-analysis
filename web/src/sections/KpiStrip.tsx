import { Card, CardContent } from '@/components/ui/card'
import type { InstanceData } from '@/types/summary'
import { coinOf, fmtMoney, fmtNum, fmtPct } from '@/lib/format'
import { cn } from '@/lib/utils'

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' | 'warn' }) {
  return (
    <Card className="bg-card/60">
      <CardContent className="pt-4 pb-3 px-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={cn(
            'text-xl font-semibold tabular-nums mt-1',
            tone === 'up' && 'text-emerald-400',
            tone === 'down' && 'text-rose-400',
            tone === 'warn' && 'text-amber-400',
          )}
        >
          {value}
        </div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  )
}

export function KpiStrip({ inst, coin }: { inst: InstanceData; coin?: string }) {
  if (coin) return <CoinKpiStrip inst={inst} coin={coin} />
  const s = inst.stats
  const depositSum = inst.deposits.reduce((a, b) => a + b.amount, 0)
  const adjDelta = s.equityDelta != null ? s.equityDelta - depositSum : null

  // 年化收益率（APY）= 净盈亏（含浮盈浮亏，已剔除入金）÷ 净投入本金 ÷ 运行天数 × 365
  // 净投入本金 = 当前总权益 − 净盈亏（即刨掉账面盈亏后实际投入多少）
  const days =
    inst.range.from && inst.range.to
      ? Math.max((new Date(inst.range.to).getTime() - new Date(inst.range.from).getTime()) / 86400000, 0.01)
      : 0
  const totalPnl = adjDelta ?? 0
  const principal = s.lastEquity - totalPnl
  const apy = days > 0 && principal > 0 ? (totalPnl / principal / days) * 365 * 100 : null

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      <Kpi
        label="当前总权益"
        value={fmtMoney(s.lastEquity)}
        sub={
          depositSum > 0
            ? `较期初 ${fmtMoney(adjDelta, true)}（已剔除入金 ${fmtMoney(depositSum)}）`
            : `较期初 ${fmtMoney(s.equityDelta, true)}`
        }
        tone={(adjDelta ?? 0) >= 0 ? 'up' : 'down'}
      />
      <Kpi
        label="套利收益"
        value={fmtMoney(s.realizedProfit, true)}
        sub={`${s.completedCount} 轮 · 均 ${fmtMoney(s.avgProfitPerRound)}/轮`}
        tone="up"
      />
      <Kpi
        label="年化收益率（APY）"
        value={apy == null ? '—' : fmtPct(apy)}
        sub={`净盈亏(含浮盈浮亏) ÷ 净投入 ÷ 已运行 ${days.toFixed(1)} 天 × 365`}
        tone={apy == null ? undefined : apy >= 0 ? 'up' : 'down'}
      />
      <Kpi
        label="可用资金占比（当前）"
        value={fmtPct(s.idleCurrent)}
        sub={`窗口期中位 ${fmtPct(s.idleMedian)} · FDUSD 可用 / 总权益`}
      />
      <Kpi label="深跌模式完成轮" value={String(s.crashRoundCount)} sub={`复位后仍完成的轮内复位 ${s.resetsInsideRounds} 次`} />
    </div>
  )
}

/** 单币种口径：账户级指标（总权益/APY/资金占比）拆不到币，换成该币种的持仓与轮次指标 */
function CoinKpiStrip({ inst, coin }: { inst: InstanceData; coin: string }) {
  const holding = [...inst.equity].reverse().find((p) => p.coins?.[coin])
  const h = holding?.coins[coin]
  const rounds = inst.completedRounds.filter((r) => coinOf(r.symbol) === coin)
  const stuck = inst.stuck.filter((r) => coinOf(r.symbol) === coin)
  const profit = rounds.reduce((a, b) => a + b.profit, 0)
  const avg = rounds.length > 0 ? profit / rounds.length : null
  const crashRounds = rounds.filter((r) => r.isCrash).length
  const stuckCost = stuck.reduce((a, b) => a + b.accCost, 0)

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      <Kpi
        label={`${coin} 持仓市值`}
        value={h ? fmtMoney(h.value) : '—'}
        sub={h ? `${fmtNum(h.qty, 4)} ${coin} @ $${fmtNum(h.price)}` : '当前无持仓'}
        tone={h ? 'up' : undefined}
      />
      <Kpi label="套利收益" value={fmtMoney(profit, true)} sub={`${rounds.length} 轮 · 均 ${fmtMoney(avg)}/轮`} tone="up" />
      <Kpi
        label="卡单占用"
        value={stuck.length > 0 ? fmtMoney(stuckCost) : '—'}
        sub={stuck.length > 0 ? `${stuck.length} 笔等待止盈` : '当前无持仓'}
        tone={stuck.length > 0 ? 'warn' : undefined}
      />
      <Kpi label="深跌模式完成轮" value={String(crashRounds)} sub={`窗口内 ${coin} 完成轮 ${rounds.length} 次`} />
      <Kpi
        label="完成轮中位时长"
        value={avgHours(rounds) != null ? `${avgHours(rounds)!.toFixed(1)} 小时` : '—'}
        sub="从开仓到止盈卖出的中位耗时"
      />
    </div>
  )
}

function avgHours(rounds: Array<{ hours: number }>): number | null {
  if (rounds.length === 0) return null
  const sorted = rounds.map((r) => r.hours).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
