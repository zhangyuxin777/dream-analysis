import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import type { InstanceData } from '@/types/summary'
import { coinOf, fmtDateTime, fmtHours, fmtMoney, fmtNum } from '@/lib/format'

export function StuckPanel({ inst }: { inst: InstanceData }) {
  return (
    <Card className="bg-card/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          卡单持仓
          {inst.stuck.length > 0 && (
            <Badge variant="outline" className="text-amber-400 border-amber-500/40">
              <AlertTriangle className="w-3 h-3 mr-1" />
              {inst.stuck.length} 笔未解套
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          已买入、还没等到止盈卖出的活轮（截至数据末尾）。等止盈是网格策略的正常状态；真正需要盯的是「挂单价离现价太远、
          不知道要等多久」的轮 —— 资金被锁死，网格转不起来
        </CardDescription>
      </CardHeader>
      <CardContent>
        {inst.stuck.length === 0 ? (
          <div className="text-sm text-emerald-400 py-6 text-center">当前没有持仓，全部资金都在网格里运转。</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>币种</TableHead>
                <TableHead className="text-right">加权均价</TableHead>
                <TableHead className="text-right">最新价</TableHead>
                <TableHead className="text-right">挂单卖价</TableHead>
                <TableHead className="text-right">已等待</TableHead>
                <TableHead className="text-center">状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inst.stuck.map((s) => (
                <TableRow key={s.roundNo + s.symbol}>
                  <TableCell className="font-medium">{coinOf(s.symbol)}</TableCell>
                  <TableCell className="text-right tabular-nums">${fmtNum(s.avgBuy)}</TableCell>
                  <TableCell className="text-right tabular-nums">${fmtNum(s.lastPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {s.sellPrice != null ? `$${fmtNum(s.sellPrice)}` : '调整中'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-amber-400" title={`轮次 ${s.roundNo} · 占用 ${fmtMoney(s.accCost)} · 买入时间 ${fmtDateTime(s.since)}${s.reductions > 0 ? ` · 已降档 ${s.reductions} 次` : ''} · 最后事件 ${s.lastEvent}`}>
                    {fmtHours(s.hours)}
                  </TableCell>
                  <TableCell className="text-center">
                    {s.crash ? (
                      <Badge className="bg-rose-500/15 text-rose-400 border border-rose-500/40">
                        <ShieldAlert className="w-3 h-3 mr-1" />
                        深跌防守
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-amber-400 border-amber-500/40">
                        等止盈
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {inst.stuck.length > 0 && (
          <p className="text-xs text-muted-foreground mt-3">
            合计占用 {fmtMoney(inst.stuck.reduce((a, b) => a + b.accCost, 0))}，占比约{' '}
            {inst.stats.lastEquity
              ? ((inst.stuck.reduce((a, b) => a + b.accCost, 0) / inst.stats.lastEquity) * 100).toFixed(0)
              : '—'}
            % 总权益。等止盈是网格策略的正常状态。
          </p>
        )}
      </CardContent>
    </Card>
  )
}
