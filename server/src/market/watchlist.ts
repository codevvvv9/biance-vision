/**
 * 默认采集清单（watchlist）：worker 周期任务与首启动 backfill 据此展开。
 * 现货仅 trade；永续 trade/mark/index 三种价格类型分别成序列；
 * 资金费率与持仓量（OI 1h 粒度）仅永续。
 */
import type { Interval, MarketType, PriceType } from 'biance-vision-brooks'

export const WATCHLIST_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const

export const WATCHLIST_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const

/** 分钟级短周期（每分钟调度）与低频周期（每小时调度）分开键，避免互相阻塞 */
export const FAST_INTERVALS = ['1m', '5m', '15m', '1h'] as const
export const SLOW_INTERVALS = ['4h', '1d'] as const

export const OI_INTERVAL: Interval = '1h'

export interface SeriesKey {
  marketType: MarketType
  priceType: PriceType
  symbol: string
  interval: Interval
}

export function seriesKeyText(s: SeriesKey): string {
  return `${s.marketType}/${s.priceType}/${s.symbol}/${s.interval}`
}

/** 展开全部 K 线采集序列 */
export function watchlistSeries(): SeriesKey[] {
  const out: SeriesKey[] = []
  for (const symbol of WATCHLIST_SYMBOLS) {
    for (const interval of WATCHLIST_INTERVALS) {
      out.push({ marketType: 'spot', priceType: 'trade', symbol, interval })
      for (const priceType of ['trade', 'mark', 'index'] as const) {
        out.push({ marketType: 'usdm_perp', priceType, symbol, interval })
      }
    }
  }
  return out
}

export function watchlistSeriesBySpeed(speed: 'fast' | 'slow'): SeriesKey[] {
  const intervals: readonly string[] = speed === 'fast' ? FAST_INTERVALS : SLOW_INTERVALS
  return watchlistSeries().filter((s) => intervals.includes(s.interval))
}

/** 永续资金费率 / OI 序列 */
export function watchlistPerpSymbols(): string[] {
  return [...WATCHLIST_SYMBOLS]
}
