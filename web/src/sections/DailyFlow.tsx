import { useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { InstanceData } from '@/types/summary'
import { fmtDate, fmtMoney } from '@/lib/format'

const tooltipStyle = {
  backgroundColor: 'hsl(240 10% 8%)',
  border: '1px solid hsl(240 4% 16%)',
  borderRadius: 8,
  fontSize: 12,
} as const

export function DailyFlow({ inst }: { inst: InstanceData }) {
  const data = useMemo(() => {
    let cum = 0
    return inst.daily.map((d) => {
      cum += d.profit
      return { ...d, cum: Math.round(cum * 100) / 100 }
    })
  }, [inst])

  return (
    <Card className="bg-card/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">轮次吞吐 与 累计套利收益</CardTitle>
        <CardDescription>
          柱子 = 每天新开（蓝）、完成（绿）、被攀涨掐死（红）的轮次；绿线 = 累计套利收益（右轴）。
          10/7 起柱子全消失 = 深跌防守：不开新轮、没有新收益，利润引擎停摆
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 16%)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(v: string) => fmtDate(v)} tick={{ fontSize: 11, fill: 'hsl(240 5% 65%)' }} />
              <YAxis yAxisId="n" tick={{ fontSize: 11, fill: 'hsl(240 5% 65%)' }} width={32} allowDecimals={false} />
              <YAxis
                yAxisId="cum"
                orientation="right"
                tick={{ fontSize: 11, fill: 'hsl(240 5% 65%)' }}
                width={48}
                tickFormatter={(v: number) => `$${v}`}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: 'hsl(0 0% 80%)' }}
                formatter={(value: number, name: string) =>
                  name === '累计套利' ? fmtMoney(value, true) : value
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="n" dataKey="new" name="新开轮" stackId="a" fill="#60a5fa" radius={[0, 0, 0, 0]} />
              <Bar yAxisId="n" dataKey="rounds" name="完成轮" stackId="a" fill="#34d399" />
              <Bar yAxisId="n" dataKey="resets" name="攀涨复位掐死" stackId="a" fill="#f43f5e" radius={[3, 3, 0, 0]} />
              <Line yAxisId="cum" type="monotone" dataKey="cum" name="累计套利" stroke="#a3e635" strokeWidth={2} dot={{ r: 2.5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
