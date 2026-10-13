/**
 * 持仓量 OI（仅 usdm_perp）：独立数据，不得从 OHLC 推断。
 * 游标取库内 max(timestamp)，增量拉取幂等 upsert；period 粒度作为数据维度入列。
 */
import type { Interval, OpenInterest } from 'biance-vision-brooks'
import { and, desc, eq, sql } from 'drizzle-orm'
import { kv, log } from '../logger.js'
import { marketOpenInterest } from '../models.js'
import { requireDb } from './common.js'
import { getProvider } from './providers/registry.js'

const VENUE = 'binance'
const MARKET_TYPE = 'usdm_perp'

export async function ingestOpenInterest(symbol: string, interval: Interval): Promise<number> {
  const db = requireDb()
  const provider = getProvider('usdm_perp')
  if (!provider.fetchOpenInterest) throw new Error('永续 provider 未实现持仓量')
  const cursorRows = await db
    .select({ maxTime: sql<number | null>`max(${marketOpenInterest.timestamp})` })
    .from(marketOpenInterest)
    .where(
      and(
        eq(marketOpenInterest.venue, VENUE),
        eq(marketOpenInterest.marketType, MARKET_TYPE),
        eq(marketOpenInterest.symbol, symbol),
        eq(marketOpenInterest.interval, interval),
      ),
    )
  const cursor = cursorRows[0]?.maxTime ?? null
  // openInterestHist 不支持 startTime，按 limit 拉最近一页，靠主键幂等去重
  const rows = await provider.fetchOpenInterest({ symbol, interval, limit: 500 })
  const fresh = cursor === null ? rows : rows.filter((r) => r.time > cursor)
  if (fresh.length > 0) {
    await db
      .insert(marketOpenInterest)
      .values(
        fresh.map((r) => ({
          venue: VENUE,
          marketType: MARKET_TYPE,
          symbol: r.symbol,
          interval,
          timestamp: r.time,
          sumOpenInterest: r.openInterest,
          sumOpenInterestValue: r.openInterestValue,
        })),
      )
      .onConflictDoUpdate({
        target: [
          marketOpenInterest.venue,
          marketOpenInterest.marketType,
          marketOpenInterest.symbol,
          marketOpenInterest.interval,
          marketOpenInterest.timestamp,
        ],
        set: {
          sumOpenInterest: sql`excluded.sum_open_interest`,
          sumOpenInterestValue: sql`excluded.sum_open_interest_value`,
        },
      })
  }
  log.info('market', '持仓量采集完成', kv({ 交易对: symbol, 周期: interval, 新增: fresh.length }))
  return fresh.length
}

/** 最近 limit 条 OI（按时间升序返回）；interval 缺省返回全部粒度 */
export async function listOpenInterest(symbol: string, interval: Interval | undefined, limit: number): Promise<OpenInterest[]> {
  const db = requireDb()
  const rows = await db
    .select()
    .from(marketOpenInterest)
    .where(
      and(
        eq(marketOpenInterest.venue, VENUE),
        eq(marketOpenInterest.marketType, MARKET_TYPE),
        eq(marketOpenInterest.symbol, symbol),
        interval !== undefined ? eq(marketOpenInterest.interval, interval) : undefined,
      ),
    )
    .orderBy(desc(marketOpenInterest.timestamp))
    .limit(limit)
  return rows
    .map((r): OpenInterest => ({
      symbol: r.symbol,
      openInterest: r.sumOpenInterest,
      openInterestValue: r.sumOpenInterestValue,
      time: r.timestamp,
    }))
    .reverse()
}
