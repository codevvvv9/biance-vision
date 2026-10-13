/**
 * 行情只读查询：/api/market/* 的数据来源。
 * K 线只从 market_candles 读，不穿透到交易所 REST；
 * 带 asOf 时只返回当时已收盘（closeTime <= asOf）的数据。
 *
 * 窗口语义：limit 截取的是 [from, to] 范围内**最靠近 to/最新**的 N 根（升序返回）——
 * 库内数据超过窗口后，分析/预测必须取「最新窗口」而不是最早一批。
 */
import type { CandleRow, GetCandlesQuery, MarketType } from 'biance-vision-brooks'
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { marketCandles } from '../models.js'
import { requireDb, rowToCandle } from './common.js'

const VENUE = 'binance'

export async function readCandles(q: GetCandlesQuery): Promise<CandleRow[]> {
  const db = requireDb()
  const rows = await db
    .select()
    .from(marketCandles)
    .where(
      and(
        eq(marketCandles.venue, VENUE),
        eq(marketCandles.marketType, q.marketType),
        eq(marketCandles.priceType, q.priceType),
        eq(marketCandles.symbol, q.symbol),
        eq(marketCandles.interval, q.interval),
        q.from !== undefined ? gte(marketCandles.openTime, q.from) : undefined,
        q.to !== undefined ? lte(marketCandles.openTime, q.to) : undefined,
        q.asOf !== undefined ? lte(marketCandles.closeTime, q.asOf) : undefined,
      ),
    )
    .orderBy(desc(marketCandles.openTime))
    .limit(q.limit)
  return rows.reverse().map(rowToCandle)
}

/**
 * 分页向更早翻取，凑满 want 根（单次受契约 limit≤1500 限制）：
 * 返回升序、时间上**最靠近 to/asOf 的 min(want, 库内可用)** 根。
 */
export async function readCandlesPaged(q: GetCandlesQuery & { want: number }): Promise<CandleRow[]> {
  const pageSize = Math.min(1500, q.want)
  let collected: CandleRow[] = []
  let to = q.to
  for (let page = 0; page < 10 && collected.length < q.want; page++) {
    const part = await readCandles({ ...q, to, limit: pageSize })
    if (part.length === 0) break
    collected = [...part, ...collected]
    to = part[0].openTime - 1
    if (part.length < pageSize) break
  }
  return collected.slice(-q.want)
}

/** 该市场已采集（库内有数据）的交易对列表 */
export async function listCollectedSymbols(marketType: MarketType): Promise<string[]> {
  const db = requireDb()
  const rows = await db
    .selectDistinct({ symbol: marketCandles.symbol })
    .from(marketCandles)
    .where(and(eq(marketCandles.venue, VENUE), eq(marketCandles.marketType, marketType)))
  return rows.map((r) => r.symbol).sort()
}
