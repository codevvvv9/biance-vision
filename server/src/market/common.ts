/**
 * market 模块公共件：DB 句柄获取与表行 → 共享契约的映射。
 * 行情数据 PG 唯一权威：DB 不可用时抛 StorageUnavailableError，
 * 路由层转成 503 { code: 'storage_unavailable' }，worker 侧不启动任务。
 */
import type { CandleRow, Interval, MarketType, PriceType, Venue } from 'biance-vision-brooks'
import { getDb } from '../db.js'
import type { MarketCandleRow } from '../models.js'

type Db = NonNullable<ReturnType<typeof getDb>>

export class StorageUnavailableError extends Error {
  readonly statusCode = 503
  readonly code = 'storage_unavailable'
  constructor() {
    super('PostgreSQL 不可用，行情存储无法访问')
  }
}

/** 取 drizzle 句柄；不可用抛 StorageUnavailableError（不写 JSON 镜像兜底） */
export function requireDb(): Db {
  const db = getDb()
  if (!db) throw new StorageUnavailableError()
  return db
}

/** market_candles 行 → 共享 CandleRow（numeric 读出即十进制字符串，时间列是 UTC 毫秒） */
export function rowToCandle(row: MarketCandleRow): CandleRow {
  return {
    venue: row.venue as Venue,
    marketType: row.marketType as MarketType,
    priceType: row.priceType as PriceType,
    symbol: row.symbol,
    interval: row.interval as Interval,
    openTime: row.openTime,
    closeTime: row.closeTime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    quoteVolume: row.quoteVolume,
    trades: row.trades,
    isClosed: row.isClosed,
    eventTime: row.eventTime,
    receivedAt: row.receivedAt.getTime(),
    source: row.source as CandleRow['source'],
    revision: row.revision,
  }
}
