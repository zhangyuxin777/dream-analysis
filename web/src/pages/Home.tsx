import { useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useSummary } from '@/hooks/useSummary'
import { KpiStrip } from '@/sections/KpiStrip'
import { EquityChart } from '@/sections/EquityChart'
import { ProfitCalendar } from '@/sections/ProfitCalendar'
import { DailyFlow } from '@/sections/DailyFlow'
import { StuckPanel } from '@/sections/StuckPanel'
import { CrashTimeline } from '@/sections/CrashTimeline'
import { fmtDateTime } from '@/lib/format'

export default function Home() {
  const { data, error } = useSummary()
  const names = data ? Object.keys(data.instances).sort() : []
  const [active, setActive] = useState<string>('')

  if (error) return <div className="p-10 text-rose-400">数据加载失败：{error}</div>
  if (!data) return <div className="p-10 text-muted-foreground">加载中…</div>

  const current = active && data.instances[active] ? active : names[0]
  const inst = data.instances[current]

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dream 网格策略 · 数据看板</h1>
            <p className="text-sm text-muted-foreground mt-1">
              数据窗口 {fmtDateTime(inst.range.from)} ~ {fmtDateTime(inst.datasetEnd)}（北京时间）· 策略快照整点产出，
              滞后约 1 小时
            </p>
          </div>
          <Select value={current} onValueChange={setActive}>
            <SelectTrigger className="w-44" aria-label="选择实例">
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
        </header>

        <KpiStrip inst={inst} />

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <div className="xl:col-span-3">
            <EquityChart inst={inst} />
          </div>
          <div className="xl:col-span-2">
            <ProfitCalendar inst={inst} />
          </div>
        </div>

        <DailyFlow inst={inst} />

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <div className="xl:col-span-3">
            <StuckPanel inst={inst} />
          </div>
          <div className="xl:col-span-2">
            <CrashTimeline inst={inst} />
          </div>
        </div>

        <footer className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border/60">
          <p>
            口径说明：轮次按「币种 + 轮号」切段统计（轮号会复用，遇 completed 开新段，-RCV 接管链并入同轮号）；
            「攀涨复位掐死」= 段内只有向上复位、没有任何买入成交的轮；卡单时长截至数据末尾。
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
