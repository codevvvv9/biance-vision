export function fmtPrice(v: number | null | undefined): string {
  if (v == null || Number.isNaN(+v)) return '--'
  const n = +v
  const abs = Math.abs(n)
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 7
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(+v)) return '--'
  const n = +v
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

export function fmtVol(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(+v)) return '--'
  const n = +v
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return n.toFixed(0)
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function precisionFor(price: number): number {
  const abs = Math.abs(price || 0)
  return abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 7
}

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* noop */
  }
}
