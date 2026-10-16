import { useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useSummary } from '@/hooks/useSummary'
import { TodayStatus } from '@/sections/TodayStatus'
import { KpiStrip } from '@/sections/KpiStrip'
import { EquityChart } from '@/sections/EquityChart'
import { ProfitCalendar } from '@/sections/ProfitCalendar'
import { DailyFlow } from '@/sections/DailyFlow'
import { StuckPanel } from '@/sections/StuckPanel'
import { CrashTimeline } from '@/sections/CrashTimeline'
import { fmtDateTime, coinOf } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { InstanceData } from '@/types/summary'

/** 实例里出现过的币种（BTC/ETH 排前面，其余按字母序） */
function coinsOf(inst: InstanceData): string[] {
  const set = new Set<string>()
  for (const r of inst.completedRounds) set.add(coinOf(r.symbol))
  for (const s of inst.stuck) set.add(coinOf(s.symbol))
  for (const c of inst.crashes) set.add(coinOf(c.symbol))
  for (const k of Object.keys(inst.dailyByCoin ?? {})) set.add(k)
  for (const p of inst.equity) for (const k of Object.keys(p.coins ?? {})) set.add(k)
  const all = [...set].sort()
  return [...all.filter((c) => c === 'BTC' || c === 'ETH'), ...all.filter((c) => c !== 'BTC' && c !== 'ETH')]
}

export default function Home() {
  const { data, error } = useSummary()
  const names = data ? Object.keys(data.instances).sort() : []
  const [active, setActive] = useState<string>('')
  const [coin, setCoin] = useState<string>('')

  if (error) return <div className="p-10 text-rose-400">数据加载失败：{error}</div>
  if (!data) return <div className="p-10 text-muted-foreground">加载中…</div>

  const current = active && data.instances[active] ? active : names[0]
  const inst = data.instances[current]
  const coins = coinsOf(inst)
  // 切实例后若该实例没有这个币种，回落到总览
  const curCoin = coin && coins.includes(coin) ? coin : ''

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-6xl mx-auto px-3 py-4 space-y-3 md:px-4 md:py-6 md:space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-2 md:gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">Dream 网格策略 · 数据看板</h1>
            <p className="text-xs md:text-sm text-muted-foreground mt-1">
              数据窗口 {fmtDateTime(inst.range.from)} ~ {fmtDateTime(inst.datasetEnd)}（北京时间）· 策略快照整点产出，
              滞后约 1 小时
              {inst.datasetEndProvisional && (
                <Badge variant="outline" className="ml-2 text-amber-400 border-amber-500/40">
                  当日数据暂定
                </Badge>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {coins.length > 0 && (
              <div className="flex rounded-lg border border-border/60 overflow-hidden" role="tablist" aria-label="币种视图">
                {['', ...coins].map((c) => (
                  <button
                    key={c || 'all'}
                    role="tab"
                    aria-selected={curCoin === c}
                    onClick={() => setCoin(c)}
                    className={cn(
                      'px-2.5 py-1 text-xs md:px-3 md:py-1.5 md:text-sm transition-colors',
                      curCoin === c
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                    )}
                  >
                    {c || '总览'}
                  </button>
                ))}
              </div>
            )}
            <Select value={current} onValueChange={setActive}>
              <SelectTrigger className="w-32 md:w-44" aria-label="选择实例">
                <SelectValue placeholder="选择实例" />
              </SelectTrigger>
              <SelectContent>
                {names.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </header>

        <TodayStatus inst={inst} coin={curCoin} />

        {/* 分币种视图：LP 先看的轮次事实（日历/吞吐）放最前，概览卡片殿后；总览视图保持卡片优先 */}
        {curCoin ? (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-5 gap-3 md:gap-4">
              <div className="xl:col-span-3">
                <ProfitCalendar inst={inst} coin={curCoin} />
              </div>
              <div className="xl:col-span-2">
                <EquityChart inst={inst} coin={curCoin} />
              </div>
            </div>

            <DailyFlow inst={inst} coin={curCoin} />

            <KpiStrip inst={inst} coin={curCoin} />
          </>
        ) : (
          <>
            <KpiStrip inst={inst} coin={curCoin} />

            <div className="grid grid-cols-1 xl:grid-cols-5 gap-3 md:gap-4">
              <div className="xl:col-span-3">
                <EquityChart inst={inst} coin={curCoin} />
              </div>
              <div className="xl:col-span-2">
                <ProfitCalendar inst={inst} coin={curCoin} />
              </div>
            </div>

            <DailyFlow inst={inst} coin={curCoin} />
          </>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-3 md:gap-4">
          <div className="xl:col-span-3">
            <StuckPanel inst={inst} coin={curCoin} />
          </div>
          <div className="xl:col-span-2">
            <CrashTimeline inst={inst} coin={curCoin} />
          </div>
        </div>

        <footer className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border/60">
          <p>
            口径说明：轮次按「币种 + 轮号」切段统计（轮号会复用，遇 completed 开新段，-RCV 接管链并入同轮号）；
            「攀涨复位掐死」= 段内只有向上复位、没有任何买入成交的轮；持仓时长截至数据末尾。
          </p>
          <p className="flex items-center gap-2">
            资金日历与资金曲线同为账户总权益口径（含浮盈浮亏，已剔除入金）；轮次图中的「累计套利」仅含 SELL 成交利润。
            <Badge variant="outline" className="text-muted-foreground">
              生成于 {fmtDateTime(data.generatedAt)}
            </Badge>
          </p>
        </footer>
      </div>
    </div>
  )
}
