/** 行情 provider 注册表：按 marketType 取实现；新增市场 = 注册一行 */
import type { MarketType } from 'biance-vision-brooks'
import { BinanceSpotProvider } from './binance-spot.js'
import { BinanceUsdmProvider } from './binance-usdm.js'
import type { MarketDataProvider } from './types.js'

const providers: Record<MarketType, MarketDataProvider> = {
  spot: new BinanceSpotProvider(),
  usdm_perp: new BinanceUsdmProvider(),
}

export function getProvider(marketType: MarketType): MarketDataProvider {
  return providers[marketType]
}

export function allProviders(): MarketDataProvider[] {
  return Object.values(providers)
}
