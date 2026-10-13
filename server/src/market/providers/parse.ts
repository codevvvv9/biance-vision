/**
 * Binance klines 原始数组行 → 共享 CandleRow 的归一化。
 * 数组下标契约见 docs/references/binance-products-and-apis.md §3：
 * 0=openTime 1=open 2=high 3=low 4=close 5=volume 6=closeTime
 * 7=quoteAssetVolume 8=trades 9/10=takerBuy 11=ignore
 * mark/index 价格类型的成交量字段是占位值，这里归一化为 null。
 */
import { CandleRowSchema } from 'biance-vision-brooks'
import type { CandleRow, Interval, MarketType, PriceType, Venue } from 'biance-vision-brooks'

export type RawKlineArray = [number, string, string, string, string, string, number, string, number, string, string, unknown]

export interface ParseContext {
  venue: Venue
  marketType: MarketType
  priceType: PriceType
  symbol: string
  interval: Interval
  receivedAt: number
  source: CandleRow['source']
}

export function parseKlineRows(raw: unknown[], ctx: ParseContext, now: number): CandleRow[] {
  const rows = (raw as RawKlineArray[]).map((k): CandleRow => {
    const isTrade = ctx.priceType === 'trade'
    return {
      venue: ctx.venue,
      marketType: ctx.marketType,
      priceType: ctx.priceType,
      symbol: ctx.symbol,
      interval: ctx.interval,
      openTime: Number(k[0]),
      closeTime: Number(k[6]),
      open: String(k[1]),
      high: String(k[2]),
      low: String(k[3]),
      close: String(k[4]),
      volume: isTrade ? String(k[5]) : null,
      quoteVolume: isTrade ? String(k[7]) : null,
      trades: isTrade ? Number(k[8]) : null,
      isClosed: Number(k[6]) <= now,
      eventTime: null, // REST 采集无事件时间
      receivedAt: ctx.receivedAt,
      source: ctx.source,
      revision: 0,
    }
  })
  // 边界处做一次 zod 校验，交易所字段形态漂移时在此暴露
  return CandleRowSchema.array().parse(rows)
}
