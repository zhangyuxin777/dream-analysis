import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import type { InstanceData } from '@/types/summary'
import { coinOf, fmtDateTime, fmtHours } from '@/lib/format'

export function CrashTimeline({ inst }: { inst: InstanceData }) {
  return (
    <Card className="bg-card/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">深跌事件</CardTitle>
        <CardDescription>
          价格自轮内高点回落超阈值（4%）时策略进入防守：暂停接货、拉宽网格间距 —— 不接飞刀，等市场自己回来
        </CardDescription>
      </CardHeader>
      <CardContent>
        {inst.crashes.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">窗口期内没有触发深跌。</div>
        ) : (
          <div className="space-y-3">
            {inst.crashes.map((c, i) => {
              const start = new Date(c.start)
              const end = c.end ? new Date(c.end) : null
              const hours = end ? (end.getTime() - start.getTime()) / 3600000 : null
              return (
                <div key={i} className="flex items-center gap-3 rounded-lg border border-border/60 px-4 py-3">
                  {end ? (
                    <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                  ) : (
                    <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {coinOf(c.symbol)} · 自高点回落 {c.dropPct.toFixed(2)}%
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {fmtDateTime(c.start)} 进入
                      {end ? ` → ${fmtDateTime(c.end)} 退出（${fmtHours(hours)}）` : ' → 仍在防守中（截至数据末尾）'}
                    </div>
                  </div>
                  <Badge variant={end ? 'outline' : 'destructive'} className={end ? 'text-emerald-400 border-emerald-500/40' : ''}>
                    {end ? '已退出' : '防守中'}
                  </Badge>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
