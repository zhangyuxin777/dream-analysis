import { Card, CardContent } from '@/components/ui/card'
import { CheckCircle2, PartyPopper, ShieldAlert } from 'lucide-react'
import type { InstanceData } from '@/types/summary'
import { coinOf, fmtHours, fmtMoney } from '@/lib/format'

/**
 * 今日状态：一句话告诉 LP 今天发生了什么。
 * 只读 summary.json 已有字段（不碰聚合器）：日维度 crashIn/crashOut、完成轮时长、每日利润。
 * 优先级：急跌 > 防守中 > 解套 > 卡单 > 大赚 > 正常；数据日 = 数据末尾那天（数据滞后约 1 小时，不拿真实时钟对）。
 */
export function TodayStatus({ inst, coin }: { inst: InstanceData; coin?: string }) {
  const dayStr = inst.datasetEnd.slice(0, 10)
  const daily = coin ? (inst.dailyByCoin?.[coin] ?? []) : inst.daily
  const today = daily.find((d) => d.date === dayStr)

  const parts: Array<{ text: string; tone: 'good' | 'warn' }> = []

  // 急跌：今天进入防守的币种（按事件时间，不看完成事件的 flag；单币种视图只看该币）
  const crashToday = inst.crashes.filter(
    (c) => c.start.slice(0, 10) === dayStr && (!coin || coinOf(c.symbol) === coin),
  )
  if (crashToday.length > 0) {
    const syms = [...new Set(crashToday.map((c) => coinOf(c.symbol)))].join('、')
    const allExited = crashToday.every((c) => c.end !== null)
    parts.push(
      allExited
        ? { text: `${syms} 今天急跌后已解除防守，程序恢复正常`, tone: 'good' }
        : { text: `${syms} 今天出现急跌，程序已自动防守：不接飞刀，等市场回来`, tone: 'warn' },
    )
  }

  // 防守中：今天之前进入、到数据末尾仍未退出的深跌（今天进入的已在上面报过，不重复）
  const defending = inst.crashes.filter(
    (c) => c.end === null && c.start.slice(0, 10) !== dayStr && (!coin || coinOf(c.symbol) === coin),
  )
  const endMs = new Date(inst.datasetEnd).getTime()
  for (const c of defending.slice(0, 2)) {
    const hours = (endMs - new Date(c.start).getTime()) / 3600000
    parts.push({
      text: `${coin ? '' : coinOf(c.symbol)} 仍处于深跌防守中（已 ${fmtHours(hours)}），不接飞刀，等市场回来`,
      tone: 'warn',
    })
  }

  // 解套：今天完成、但持仓超过一天的轮（昨天以前被套的）
  const unstuck = inst.completedRounds.filter(
    (r) => r.t.slice(0, 10) === dayStr && r.hours >= 24 && (!coin || coinOf(r.symbol) === coin),
  )
  for (const r of unstuck.slice(0, 2)) {
    parts.push({
      text: `被套 ${fmtHours(r.hours)} 的 ${coinOf(r.symbol)} 今天解套，落袋 ${fmtMoney(r.profit, true)}`,
      tone: 'good',
    })
  }

  // 卡单：当前持仓等止盈的已等待时长（LP 点名要盯的口径）
  const stuckNow = inst.stuck.filter((s) => !coin || coinOf(s.symbol) === coin)
  for (const s of stuckNow.slice(0, 2)) {
    parts.push({
      text: `${coin ? '' : coinOf(s.symbol)} 有一笔持仓在等止盈，已卡单 ${fmtHours(s.hours)}（挂卖 $${s.sellPrice?.toFixed(2) ?? '—'}）`,
      tone: 'good',
    })
  }

  // 大赚：今天已实现利润 ≥ 3×平日中位 且绝对额 ≥ $50（防运行初期中位≈0 的误报）
  if (today && today.profit > 0) {
    const others = daily.filter((d) => d.date !== dayStr).map((d) => d.profit).sort((a, b) => a - b)
    const median = others.length > 0 ? others[Math.floor(others.length / 2)] : 0
    if (today.profit >= Math.max(3 * median, 50)) {
      parts.push({ text: `今天大赚了 ${fmtMoney(today.profit, true)}，远超平常水平`, tone: 'good' })
    }
  }

  // 兜底：正常运作口径
  if (parts.length === 0) {
    if (today && today.rounds > 0) {
      parts.push({ text: `今天正常运作：完成 ${today.rounds} 轮，已实现 ${fmtMoney(today.profit, true)}`, tone: 'good' })
    } else {
      parts.push({ text: '今天还没有卖出成交，持仓等待中，属正常节奏', tone: 'good' })
    }
  }

  const hasWarn = parts.some((p) => p.tone === 'warn')

  return (
    <Card className={hasWarn ? 'bg-amber-500/5 border-amber-500/30' : 'bg-emerald-500/5 border-emerald-500/20'}>
      <CardContent className="pt-3 pb-3 px-4 flex items-start gap-2.5">
        {hasWarn ? (
          <ShieldAlert className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
        ) : parts.some((p) => p.text.includes('大赚') || p.text.includes('解套')) ? (
          <PartyPopper className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
        ) : (
          <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
        )}
        <div className="text-sm leading-6">
          <span className="text-muted-foreground mr-2">
            {dayStr} 今日状态{coin ? `（${coin}）` : ''}
          </span>
          {parts.map((p, i) => (
            <span key={i} className={p.tone === 'warn' ? 'text-amber-400 font-medium' : 'text-foreground'}>
              {p.text}
              {i < parts.length - 1 && <span className="text-muted-foreground mx-1.5">|</span>}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
