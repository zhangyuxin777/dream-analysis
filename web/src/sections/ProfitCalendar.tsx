import { useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import type { InstanceData } from '@/types/summary'
import { fmtDate, fmtMoney } from '@/lib/format'
import { cn } from '@/lib/utils'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

interface Cell {
  date: string
  day: number
  /** 展示值：net 优先（含浮盈浮亏），无权益快照时退回已实现 */
  value: number | null
  isNet: boolean
}

/** 背景色用 inline style（Tailwind class 无法表达动态 rgba），文字色用静态 class */
function cellAppearance(value: number | null, isNet: boolean, max: number): { bg?: string; cls: string } {
  if (value == null || !isNet) return { cls: 'bg-muted/30 text-muted-foreground' }
  if (value > 0) {
    const a = Math.min(value / max, 1)
    return { bg: `rgba(16,185,129,${0.3 + a * 0.6})`, cls: 'text-emerald-50' }
  }
  if (value < 0) {
    const a = Math.min(-value / max, 1)
    return { bg: `rgba(244,63,94,${0.3 + a * 0.6})`, cls: 'text-rose-50' }
  }
  return { cls: 'bg-muted/30 text-muted-foreground' }
}

export function ProfitCalendar({ inst }: { inst: InstanceData }) {
  const { weeks, maxAbs, extreme, byDate } = useMemo(() => {
    const map = new Map(inst.daily.map((d) => [d.date, d]))
    // 净盈亏（含浮盈浮亏）优先；灰色格（无权益快照）退回已实现利润
    const vals = inst.daily.map((d) => (d.net != null ? d.net : d.profit))
    const maxAbs = Math.max(1, ...vals.map((v) => Math.abs(v)))
    const dates = inst.daily.map((d) => d.date).sort()
    const first = dates[0] ?? '2026-10-01'
    const last = dates[dates.length - 1] ?? first
    const [fy, fm] = first.split('-').map(Number)
    const [ly, lm] = last.split('-').map(Number)
    const weeks: (Cell | null)[][] = []
    let cur: (Cell | null)[] = []
    const start = new Date(fy, fm - 1, 1)
    const shift = (start.getDay() + 6) % 7
    for (let i = 0; i < shift; i++) cur.push(null)
    const end = new Date(ly, lm, 0)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const stat = map.get(key)
      cur.push({
        date: key,
        day: d.getDate(),
        value: stat ? (stat.net != null ? stat.net : stat.profit) : null,
        isNet: stat?.net != null,
      })
      if (cur.length === 7) {
        weeks.push(cur)
        cur = []
      }
    }
    if (cur.length) {
      while (cur.length < 7) cur.push(null)
      weeks.push(cur)
    }
    // 极值日：按 |值| 找最大的一天，保留真实符号和日期
    let extreme: { value: number; date: string } | null = null
    for (const d of inst.daily) {
      const v = d.net != null ? d.net : d.profit
      if (extreme == null || Math.abs(v) > Math.abs(extreme.value)) {
        extreme = { value: v, date: d.date }
      }
    }
    return { weeks, maxAbs, extreme, byDate: map }
  }, [inst])

  return (
    <Card className="bg-card/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">资金日历</CardTitle>
        <CardDescription>
          每日净盈亏 = 当日账户权益变化（含持仓浮盈浮亏，与资金曲线同口径）；灰色格 = 当日无权益快照，退回显示套利收益
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground mb-1">
          {WEEKDAYS.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
        <div className="space-y-1">
          {weeks.map((week, i) => (
            <div key={i} className="grid grid-cols-7 gap-1">
              {week.map((cell, j) =>
                cell == null ? (
                  <div key={j} />
                ) : (
                  <div
                    key={j}
                    title={
                      cell.value != null
                        ? `${cell.date}：${cell.isNet ? '净盈亏（含浮盈浮亏）' : '套利收益（无权益快照）'} ${fmtMoney(cell.value, true)} · 完成 ${byDate.get(cell.date)?.rounds ?? 0} 轮 · 新开 ${byDate.get(cell.date)?.new ?? 0} · 复位 ${byDate.get(cell.date)?.resets ?? 0}`
                        : `${cell.date}：无数据`
                    }
                    style={(() => {
                      const a = cellAppearance(cell.value, cell.isNet, maxAbs)
                      return a.bg ? { background: a.bg } : undefined
                    })()}
                    className={cn(
                      'h-11 rounded-md flex flex-col items-center justify-center text-xs tabular-nums transition-transform hover:scale-105 cursor-default',
                      cellAppearance(cell.value, cell.isNet, maxAbs).cls,
                    )}
                  >
                    <span className="opacity-70 text-[10px]">{cell.day}</span>
                    <span className="font-medium">
                      {cell.value != null ? (cell.value >= 0 ? '+' : '') + cell.value.toFixed(1) : '·'}
                    </span>
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 mt-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: 'rgba(244,63,94,0.6)' }} /> 净亏损
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: 'rgba(16,185,129,0.6)' }} /> 净盈利（越深越多）
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-muted/40" /> 灰 = 无快照（仅套利收益）
          </span>
          <span className="ml-auto">
            单日极值{' '}
            {extreme ? (
              <span className={extreme.value >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {fmtMoney(extreme.value, true)}（{fmtDate(extreme.date)}）
              </span>
            ) : (
              '—'
            )}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
