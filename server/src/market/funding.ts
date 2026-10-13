/**
 * 资金费率（仅 usdm_perp）：独立数据，不得从 OHLC 推断。
 * 游标直接取库内 max(funding_time)，增量拉取幂等 upsert。
 */
import type { FundingRate } from 'biance-vision-brooks'
import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { kv, log } from '../logger.js'
import { marketFundingRates } from '../models.js'
import { requireDb } from './common.js'
import { getProvider } from './providers/registry.js'

const VENUE = 'binance'
const MARKET_TYPE = 'usdm_perp'

export async function ingestFunding(symbol: string): Promise<number> {
  const db = requireDb()
  const provider = getProvider('usdm_perp')
  if (!provider.fetchFundingRates) throw new Error('永续 provider 未实现资金费率')
  const cursorRows = await db
    .select({ maxTime: sql<number | null>`max(${marketFundingRates.fundingTime})` })
    .from(marketFundingRates)
    .where(
      and(
        eq(marketFundingRates.venue, VENUE),
        eq(marketFundingRates.marketType, MARKET_TYPE),
        eq(marketFundingRates.symbol, symbol),
      ),
    )
  const cursor = cursorRows[0]?.maxTime ?? null
  const rows = await provider.fetchFundingRates({
    symbol,
    startTime: cursor !== null ? cursor + 1 : undefined,
    limit: 1000,
  })
  if (rows.length > 0) {
    await db
      .insert(marketFundingRates)
      .values(
        rows.map((r) => ({
          venue: VENUE,
          marketType: MARKET_TYPE,
          symbol: r.symbol,
          fundingTime: r.fundingTime,
          fundingRate: r.fundingRate,
          markPrice: r.markPrice,
        })),
      )
      .onConflictDoUpdate({
        target: [marketFundingRates.venue, marketFundingRates.marketType, marketFundingRates.symbol, marketFundingRates.fundingTime],
        set: { fundingRate: sql`excluded.funding_rate`, markPrice: sql`excluded.mark_price` },
      })
  }
  log.info('market', '资金费率采集完成', kv({ 交易对: symbol, 新增: rows.length }))
  return rows.length
}

/** 最近 limit 条资金费率（按时间升序返回）；传 asOf 时只取 fundingTime <= asOf（历史复盘不泄漏未来费率） */
export async function listFunding(symbol: string, limit: number, asOf?: number): Promise<FundingRate[]> {
  const db = requireDb()
  const rows = await db
    .select()
    .from(marketFundingRates)
    .where(
      and(
        eq(marketFundingRates.venue, VENUE),
        eq(marketFundingRates.marketType, MARKET_TYPE),
        eq(marketFundingRates.symbol, symbol),
        // funding_time 是 bigint(epoch ms)：必须传数字，传 Date 会被序列化成
        // "Tue Oct 13 2026 ..." 之类字符串导致 PG 解析失败（快照步骤整体失败）
        ...(asOf !== undefined ? [lte(marketFundingRates.fundingTime, asOf)] : []),
      ),
    )
    .orderBy(desc(marketFundingRates.fundingTime))
    .limit(limit)
  return rows
    .map((r): FundingRate => ({
      symbol: r.symbol,
      fundingRate: r.fundingRate,
      fundingTime: r.fundingTime,
      markPrice: r.markPrice,
    }))
    .reverse()
}
