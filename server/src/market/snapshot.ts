/**
 * 研究冻结快照：对每个已采集周期查 closeTime <= asOf 的最后已收盘 openTime，
 * 落 market_snapshots 并返回共享 SnapshotRef；实时价单独携带 priceAsOf，不混入闭合 K 线。
 * 快照基于 trade 价格类型（结构分析的主序列）；mark/index 由调用方按需查询。
 */
import { randomUUID } from 'node:crypto'
import { SnapshotRefSchema } from 'biance-vision-brooks'
import type { Interval, MarketType, SnapshotRef } from 'biance-vision-brooks'
import { and, eq, lte, sql } from 'drizzle-orm'
import { kv, log } from '../logger.js'
import { marketCandles, marketSnapshots } from '../models.js'
import { requireDb } from './common.js'
import { getProvider } from './providers/registry.js'

const VENUE = 'binance'

export async function createSnapshot(opts: {
  symbol: string
  marketType: MarketType
  asOf: number
}): Promise<SnapshotRef> {
  const db = requireDb()
  const { symbol, marketType, asOf } = opts
  const rows = await db
    .select({
      interval: marketCandles.interval,
      lastClosedOpenTime: sql<number>`max(${marketCandles.openTime})`,
    })
    .from(marketCandles)
    .where(
      and(
        eq(marketCandles.venue, VENUE),
        eq(marketCandles.marketType, marketType),
        eq(marketCandles.priceType, 'trade'),
        eq(marketCandles.symbol, symbol),
        lte(marketCandles.closeTime, asOf),
      ),
    )
    .groupBy(marketCandles.interval)

  const perInterval: Partial<Record<Interval, { lastClosedOpenTime: number }>> = {}
  for (const r of rows) {
    perInterval[r.interval as Interval] = { lastClosedOpenTime: Number(r.lastClosedOpenTime) }
  }

  // 实时价独立于闭合 K 线：取价失败仅 priceAsOf 为 null，不阻断快照
  const provider = getProvider(marketType)
  const price = provider.fetchPrice ? await provider.fetchPrice(symbol) : null

  const id = randomUUID()
  await db.insert(marketSnapshots).values({
    id,
    symbol,
    marketType,
    asOf: new Date(asOf),
    perInterval,
    priceAsOf: price ? new Date(price.time) : null,
  })
  const snapshot: SnapshotRef = SnapshotRefSchema.parse({
    snapshotId: id,
    symbol,
    marketType,
    asOf,
    perInterval,
    priceAsOf: price?.time ?? null,
    createdAt: Date.now(),
  })
  log.ok('market', '快照已创建', kv({
    快照: id.slice(0, 8),
    交易对: symbol,
    市场: marketType,
    周期数: rows.length,
    实时价: price ? price.price : '不可用',
  }))
  return snapshot
}
