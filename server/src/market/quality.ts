/**
 * 数据质量：每个采集序列的缺口登记、延迟（now - 最后收盘 closeTime）、最后收盘点。
 * 供 /api/market/quality 与监控；数据以 ingest_state 登记为准。
 */
import { INTERVAL_MS } from 'biance-vision-brooks'
import type { DataQuality, Interval, MarketType, PriceType } from 'biance-vision-brooks'
import { and, eq } from 'drizzle-orm'
import { ingestState } from '../models.js'
import { requireDb } from './common.js'

const VENUE = 'binance'

export async function getQuality(opts: {
  symbol: string
  marketType: MarketType
  interval?: Interval
}): Promise<DataQuality[]> {
  const db = requireDb()
  const rows = await db
    .select()
    .from(ingestState)
    .where(
      and(
        eq(ingestState.venue, VENUE),
        eq(ingestState.marketType, opts.marketType),
        eq(ingestState.symbol, opts.symbol),
        opts.interval !== undefined ? eq(ingestState.interval, opts.interval) : undefined,
      ),
    )
  const now = Date.now()
  const items: DataQuality[] = []
  for (const r of rows) {
    if (r.lastClosedOpenTime === null) continue // 从未成功采集的序列不报（无基线）
    const intervalMs = INTERVAL_MS[r.interval as Interval]
    const lastCloseTime = r.lastClosedOpenTime + intervalMs - 1
    items.push({
      symbol: r.symbol,
      marketType: r.marketType as MarketType,
      priceType: r.priceType as PriceType,
      interval: r.interval as Interval,
      gapCount: r.gapCount,
      lagMs: Math.max(0, now - lastCloseTime),
      lastClosedOpenTime: r.lastClosedOpenTime,
      checkedAt: now,
    })
  }
  return items.sort(
    (a, b) => a.priceType.localeCompare(b.priceType) || INTERVAL_MS[a.interval] - INTERVAL_MS[b.interval],
  )
}
