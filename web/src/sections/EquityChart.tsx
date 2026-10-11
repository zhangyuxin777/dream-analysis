import { useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { InstanceData } from '@/types/summary'
import { fmtDateTime, fmtMoney, fmtPct, coinOf } from '@/lib/format'

const tooltipStyle = {
  backgroundColor: 'hsl(240 10% 8%)',
  border: '1px solid hsl(240 4% 16%)',
  borderRadius: 8,
  fontSize: 12,
} as const

const toMs = (iso: string) => new Date(iso).getTime()

// 深跌防守时段按币种配色：红 = ETH，紫 = BTC，其余币种循环取色，相邻时段一眼可辨
const CRASH_COLORS: Record<string, { fill: string; text: string }> = {
  ETH: { fill: 'hsl(0 72% 55%)', text: 'hsl(0 78% 68%)' },
  BTC: { fill: 'hsl(275 72% 60%)', text: 'hsl(275 80% 74%)' },
}
const CRASH_FALLBACK = [
  { fill: 'hsl(25 90% 55%)', text: 'hsl(30 95% 66%)' },
  { fill: 'hsl(190 80% 45%)', text: 'hsl(190 85% 60%)' },
]
function crashColor(symbol: string, index: number) {
  const base = coinOf(symbol)
  return CRASH_COLORS[base] ?? CRASH_FALLBACK[index % CRASH_FALLBACK.length]
}

export function EquityChart({ inst }: { inst: InstanceData }) {
  const data = useMemo(
    () => inst.equity.map((p) => ({ ...p, x: toMs(p.t) })),
    [inst],
  )

  const crashBands = useMemo(() => {
    if (!data.length) return []
    const first = data[0].x
    const last = data[data.length - 1].x
    return inst.crashes
      .map((c) => ({ ...c, x1: toMs(c.start), x2: c.end ? toMs(c.end) : last }))
      .filter((c) => c.x2 >= first && c.x1 <= last)
  }, [inst, data])

  if (!data.length) return null

  return (
    <Card className="bg-card/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">资金曲线</CardTitle>
        <CardDescription>
          绿面 = 账户总权益，左轴美元；黄虚线 = 可用资金占比，右轴百分比（越低说明越多钱被持仓/挂单占用）。
          彩色竖带 = 深跌防守时段（红 = ETH，紫 = BTC，颜色区分币种）；黄点 = 入金
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 16%)" vertical={false} />
              <XAxis
                dataKey="x"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                tickFormatter={(v: number) => fmtDateTime(new Date(v).toISOString())}
                tick={{ fontSize: 11, fill: 'hsl(240 5% 65%)' }}
                minTickGap={48}
              />
              <YAxis
                yAxisId="usd"
                domain={['auto', 'auto']}
                tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
                tick={{ fontSize: 11, fill: 'hsl(240 5% 65%)' }}
                width={44}
              />
              <YAxis
                yAxisId="pct"
                orientation="right"
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 11, fill: 'hsl(240 5% 65%)' }}
                width={40}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: 'hsl(0 0% 80%)' }}
                formatter={(value: number, name: string) =>
                  name === '总权益' ? fmtMoney(value) : name === '可用资金占比' ? fmtPct(value) : value
                }
                labelFormatter={(v: number) => fmtDateTime(new Date(v).toISOString())}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {crashBands.map((c, i) => {
                const color = crashColor(c.symbol, i)
                return (
                  <ReferenceArea
                    key={i}
                    yAxisId="usd"
                    x1={c.x1}
                    x2={c.x2}
                    fill={color.fill}
                    fillOpacity={0.12}
                    stroke={color.fill}
                    strokeDasharray="4 3"
                    strokeOpacity={0.55}
                    label={{
                      value: `${coinOf(c.symbol)} 深跌${c.end ? '' : '·防守中'}`,
                      position: 'insideTop',
                      fontSize: 10,
                      fill: color.text,
                      // 多币种深跌带相邻时标签纵向错开，避免叠字
                      dy: 12 + i * 14,
                    }}
                  />
                )
              })}
              <Area
                yAxisId="usd"
                type="monotone"
                dataKey="total"
                name="总权益"
                stroke="#34d399"
                fill="#34d399"
                fillOpacity={0.12}
                strokeWidth={1.8}
                dot={false}
              />
              <Line
                yAxisId="pct"
                type="monotone"
                dataKey="idlePct"
                name="可用资金占比"
                stroke="#fbbf24"
                strokeWidth={1.4}
                dot={false}
                strokeDasharray="5 3"
              />
              {inst.deposits.map((d, i) => (
                <ReferenceDot
                  key={i}
                  yAxisId="usd"
                  x={toMs(d.t)}
                  y={data.find((p) => p.t === d.t)?.total}
                  r={5}
                  fill="#fbbf24"
                  stroke="none"
                  label={{ value: `入金 +$${Math.round(d.amount / 1000)}k`, position: 'top', fontSize: 10, fill: '#fbbf24' }}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
