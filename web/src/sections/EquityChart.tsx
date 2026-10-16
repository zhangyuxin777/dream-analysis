import { useMemo, useState, type ReactElement } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { InstanceData } from '@/types/summary'
import { fmtDateTime, fmtMoney, fmtNum, fmtPct, coinOf } from '@/lib/format'
import { cn } from '@/lib/utils'

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

// 单币种视图的价格线颜色：不区分币种，统一淡紫（与 ETH 深跌带同色系，LP 指定 2026-10-14）
const COIN_PRICE_COLOR = '#a78bfa'

/** 图例点击隐藏/展示：recharts 原生 Legend 没有内置开关，自己用 state 钉 */
function useLegendToggle() {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const toggle = (dataKey: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(dataKey)) next.delete(dataKey)
      else next.add(dataKey)
      return next
    })
  }
  return { hidden, toggle }
}

export function EquityChart({ inst, coin }: { inst: InstanceData; coin?: string }) {
  const { hidden, toggle } = useLegendToggle()

  const data = useMemo(
    () =>
      inst.equity.map((p) => ({
        ...p,
        x: toMs(p.t),
        coinPrice: coin ? (p.coins?.[coin]?.price ?? null) : null,
      })),
    [inst, coin],
  )

  const crashBands = useMemo(() => {
    if (!data.length) return []
    const first = data[0].x
    const last = data[data.length - 1].x
    return inst.crashes
      .filter((c) => !coin || coinOf(c.symbol) === coin)
      .map((c) => ({ ...c, x1: toMs(c.start), x2: c.end ? toMs(c.end) : last }))
      .filter((c) => c.x2 >= first && c.x1 <= last)
  }, [inst, data, coin])

  // 深跌后解套：防守轮完成卖出的时点（isCrash 完成轮 = 深跌防守的事实结束），标在总权益线上
  const unstuckDots = useMemo(() => {
    if (!coin || !data.length) return []
    return inst.completedRounds
      .filter((r) => coinOf(r.symbol) === coin && r.isCrash)
      .map((r) => {
        const x = toMs(r.t)
        // 权益快照约一小时一点：取该时刻（或之前最近）的快照对标
        let y: number | undefined
        for (const p of data) {
          if (p.x <= x) y = p.total
          else break
        }
        return { x, y, profit: r.profit }
      })
      .filter((d) => d.y != null)
  }, [inst, coin, data])

  if (!data.length) return null

  const color = coin ? COIN_PRICE_COLOR : ''
  const isHidden = (key: string) => hidden.has(key)

  // recharts 解析 ComposedChart 直接子元素时认不出 Fragment（里面的曲线会被整个丢掉），
  // 所以序列一律拼成扁平数组再作为 children
  const series: ReactElement[] = []
  if (coin) {
    if (!isHidden('total')) {
      series.push(
        <Line key="total" yAxisId="usd" type="monotone" dataKey="total" name="总权益" stroke="#34d399" strokeWidth={1.6} dot={false} />,
      )
    }
    if (!isHidden('coinPrice')) {
      series.push(
        <Line key="coinPrice" yAxisId="price" type="monotone" dataKey="coinPrice" name={`${coin}价格`} stroke={color} strokeWidth={1.6} strokeDasharray="6 3" dot={false} connectNulls />,
      )
    }
  } else {
    if (!isHidden('total')) {
      series.push(
        <Area key="total" yAxisId="usd" type="monotone" dataKey="total" name="总权益" stroke="#34d399" fill="#34d399" fillOpacity={0.12} strokeWidth={1.8} dot={false} />,
      )
    }
    if (!isHidden('idlePct')) {
      series.push(
        <Line key="idlePct" yAxisId="pct" type="monotone" dataKey="idlePct" name="可用资金占比" stroke="#fbbf24" strokeWidth={1.4} dot={false} strokeDasharray="5 3" />,
      )
    }
  }

  const legendItems: Array<{ key: string; label: string; color: string; dash?: boolean }> = coin
    ? [
        { key: 'total', label: '总权益', color: '#34d399' },
        { key: 'coinPrice', label: `${coin}价格`, color, dash: true },
      ]
    : [
        { key: 'total', label: '总权益', color: '#34d399' },
        { key: 'idlePct', label: '可用资金占比', color: '#fbbf24', dash: true },
      ]

  return (
    <Card className="bg-card/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{coin ? `${coin} · 资金曲线` : '资金曲线'}</CardTitle>
        <CardDescription>
          {coin
            ? `绿线 = 账户总权益（左轴美元）；虚线 = ${coin} 价格（右轴，快照时点上由市值÷持仓反推，约每小时一点）。彩色竖带 = ${coin} 深跌防守时段；紫点 = 深跌后解套（防守轮完成卖出）；黄点 = 入金。点击图例可隐藏/展示对应曲线`
            : '绿面 = 账户总权益，左轴美元；黄虚线 = 可用资金占比，右轴百分比（越低说明越多钱被持仓/挂单占用）。彩色竖带 = 深跌防守时段（红 = ETH，紫 = BTC，颜色区分币种）；黄点 = 入金。点击图例可隐藏/展示对应曲线'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-56 md:h-72">
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
              {coin ? (
                <YAxis
                  yAxisId="price"
                  orientation="right"
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))}
                  tick={{ fontSize: 11, fill: 'hsl(240 5% 65%)' }}
                  width={52}
                />
              ) : (
                <YAxis
                  yAxisId="pct"
                  orientation="right"
                  domain={[0, 100]}
                  tickFormatter={(v: number) => `${v}%`}
                  tick={{ fontSize: 11, fill: 'hsl(240 5% 65%)' }}
                  width={40}
                />
              )}
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: 'hsl(0 0% 80%)' }}
                formatter={(value: number, name: string) =>
                  name === '总权益'
                    ? fmtMoney(value)
                    : name === '可用资金占比'
                      ? fmtPct(value)
                      : name.endsWith('价格')
                        ? `$${fmtNum(value)}`
                        : value
                }
                labelFormatter={(v: number) => fmtDateTime(new Date(v).toISOString())}
              />
              {crashBands.map((c, i) => {
                const cc = crashColor(c.symbol, i)
                return (
                  <ReferenceArea
                    key={i}
                    yAxisId="usd"
                    x1={c.x1}
                    x2={c.x2}
                    fill={cc.fill}
                    fillOpacity={0.12}
                    stroke={cc.fill}
                    strokeDasharray="4 3"
                    strokeOpacity={0.55}
                    label={{
                      value: `${coin ? '' : coinOf(c.symbol) + ' '}深跌${c.end ? '' : '·防守中'}`,
                      position: 'insideTop',
                      fontSize: 10,
                      fill: cc.text,
                      // 多币种深跌带相邻时标签纵向错开，避免叠字
                      dy: 12 + i * 14,
                    }}
                  />
                )
              })}
              {series}
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
              {unstuckDots.map((d, i) => (
                <ReferenceDot
                  key={`unstuck-${i}`}
                  yAxisId="usd"
                  x={d.x}
                  y={d.y}
                  r={5}
                  fill={COIN_PRICE_COLOR}
                  stroke="none"
                  label={{
                    value: `解套 ${fmtMoney(d.profit, true)}`,
                    position: 'top',
                    fontSize: 10,
                    fill: COIN_PRICE_COLOR,
                    dy: -6,
                  }}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* 自渲染图例（不依赖 recharts 的 legend payload）：被隐藏的项也保留在图例里，点击可恢复 */}
        <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs pt-1">
          {legendItems.map((item) => (
            <li
              key={item.key}
              onClick={() => toggle(item.key)}
              className={cn(
                'inline-flex items-center gap-1.5 cursor-pointer select-none transition-opacity',
                isHidden(item.key) && 'opacity-35 line-through',
              )}
            >
              {item.dash ? (
                <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: item.color }} />
              ) : (
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: item.color }} />
              )}
              {item.label}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
