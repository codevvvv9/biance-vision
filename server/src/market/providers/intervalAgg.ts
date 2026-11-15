/**
 * 周期聚合语义单点：数据源原生不支持的周期（如 10m——币安与 Yahoo 的原生粒度
 * 都从 5m 直接跳 15m）由原生周期在 provider 层聚合，调用方（watchlist/ingest/
 * 直通端点）无感知。
 * 新增聚合周期 = 在 AGGREGATED_INTERVALS 注册一行；CandleRow 字符串字段全部
 * 取自参与 bar 的原值（零精度损失），仅 volume 求和后经 toDecimalString 规整。
 */
import { INTERVAL_MS } from 'biance-vision-brooks'
import type { CandleRow, Interval } from 'biance-vision-brooks'

/** 聚合周期 → 原生周期与倍数（单一数据源） */
export const AGGREGATED_INTERVALS: Readonly<Record<string, { native: Interval; ratio: number }>> = {
  '10m': { native: '5m', ratio: 2 },
}

/** 该周期是否需要聚合（provider 请求层据此换原生周期并放大拉取量） */
export function aggregationFor(interval: string): { native: Interval; ratio: number } | null {
  return AGGREGATED_INTERVALS[interval] ?? null
}

/** 数值转契约十进制字符串（规避 JS 极端量级下的科学计数法——DECIMAL_RE 不接受 e 记法） */
export function toDecimalString(n: number): string {
  const s = String(n)
  if (!s.includes('e') && !s.includes('E')) return s
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 将原生周期 CandleRow 聚合为目标周期：按目标周期边界对齐分组、组内合并
 * （open=首根、close=末根、high/low 取极值根原字符串、volume 求和，null 传染）；
 * 边界残组（不足倍数根，如停牌/进行中尾段）整组丢弃，不产出半根。
 * 可选 limit：聚合完成后截取最靠近最新的 limit 根（原生请求放大量会超出调用方期望）。
 */
export function aggregateCandleRows(
  rows: CandleRow[],
  native: Interval,
  target: Interval,
  limit?: number,
): CandleRow[] {
  const aggregated = aggregateImpl(rows, native, target)
  return limit !== undefined && aggregated.length > limit ? aggregated.slice(aggregated.length - limit) : aggregated
}

function aggregateImpl(rows: CandleRow[], native: Interval, target: Interval): CandleRow[] {
  const nativeMs = INTERVAL_MS[native]
  const targetMs = INTERVAL_MS[target]
  const ratio = targetMs / nativeMs
  if (!Number.isInteger(ratio) || ratio < 2) return rows

  const out: CandleRow[] = []
  let group: CandleRow[] = []
  let groupStart = -1
  const flush = (): void => {
    if (group.length === ratio && groupStart >= 0) {
      let high = group[0]
      let low = group[0]
      for (const r of group) {
        if (Number(r.high) > Number(high.high)) high = r
        if (Number(r.low) < Number(low.low)) low = r
      }
      const volumeSum = group.every((r) => r.volume !== null)
        ? toDecimalString(group.reduce((acc, r) => acc + Number(r.volume), 0))
        : null
      const quoteSum = group.every((r) => r.quoteVolume !== null)
        ? toDecimalString(group.reduce((acc, r) => acc + Number(r.quoteVolume ?? 0), 0))
        : null
      out.push({
        ...group[group.length - 1],
        interval: target,
        openTime: groupStart,
        closeTime: groupStart + targetMs - 1,
        open: group[0].open,
        close: group[group.length - 1].close,
        high: high.high,
        low: low.low,
        volume: volumeSum,
        quoteVolume: quoteSum,
        trades: group.every((r) => r.trades !== null)
          ? group.reduce((acc, r) => acc + (r.trades ?? 0), 0)
          : null,
        // 已收盘 = 组内末根已收盘
        isClosed: group[group.length - 1].isClosed,
      })
    }
    group = []
    groupStart = -1
  }
  for (const r of rows) {
    const bucket = Math.floor(r.openTime / targetMs) * targetMs
    if (bucket !== groupStart) {
      flush()
      groupStart = bucket
    }
    group.push(r)
  }
  flush()
  return out
}

/**
 * provider 请求参数换算（fetchKlines 入口统一调用）：
 * 返回实际请求周期与放大后的 limit；聚合标志供响应侧调用 aggregateCandleRows。
 */
export function requestIntervalFor(
  interval: string,
  limit: number | undefined,
): { requestInterval: Interval; requestLimit: number; aggregateTo: Interval | null } {
  const agg = aggregationFor(interval)
  if (agg === null) {
    return { requestInterval: interval as Interval, requestLimit: limit ?? 500, aggregateTo: null }
  }
  // 放大请求量：目标根数 × 倍数 + 边界缓冲（跨边界的残根会在聚合时丢弃）
  return {
    requestInterval: agg.native,
    requestLimit: Math.min((limit ?? 500) * agg.ratio + agg.ratio * 2, 1500),
    aggregateTo: interval as Interval,
  }
}
