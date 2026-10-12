// 展示用格式化工具（时区固定北京时间）
const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

export function fmtMoney(v: number | null | undefined, sign = false): string {
  if (v == null) return '—'
  const s = nf.format(Math.abs(v))
  const prefix = v < 0 ? '-$' : sign ? '+$' : '$'
  return prefix + s
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return v.toFixed(1) + '%'
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null) return '—'
  return v.toFixed(digits)
}

export function fmtHours(h: number | null | undefined): string {
  if (h == null) return '—'
  if (h < 1) return Math.round(h * 60) + ' 分钟'
  if (h < 24) return h.toFixed(1) + ' 小时'
  // ≥1 天统一「X 天 Y 小时」（2026-10-12 LP 反馈：5.2 天这种小数天数不直观）
  const d = Math.floor(h / 24)
  const hr = Math.round(h % 24)
  return hr > 0 ? `${d} 天 ${hr} 小时` : `${d} 天`
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function coinOf(symbol: string): string {
  return symbol.replace('FDUSD', '')
}
