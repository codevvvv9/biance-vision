import raw from '../content/manifest.json' with { type: 'json' }
import type { Locale } from './site'

export type SourceId = keyof typeof sources
export const sources = {
  brooks: { title: 'Brooks Trading Course · Price Action Trading Terms', url: 'https://www.brookstradingcourse.com/price-action-trading-terms-glossary/', scope: ['Public terminology; not a trading-performance claim.', '公开术语定义，不代表交易业绩证明。'] },
  'binance-candles': { title: 'Binance · Kline / Candlestick Streams', url: 'https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams', scope: ['Stream fields and candle closure; not endorsement of this product.', '行情字段与收盘标志，不代表对本产品背书。'] },
  'binance-funding': { title: 'Binance USDⓈ-M Futures · Market Data / Funding', url: 'https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data', scope: ['Mark-price and funding data definitions; not a future-cost guarantee.', '标记价格与资金费率定义，不保证未来成本。'] },
  'product-method': { title: 'Biance Vision · Research methodology / 研究方法', url: '/methodology', scope: ['Our product explanation, not an independent validation.', '本项目的产品说明，不是独立验证。'] },
  'product-access': { title: 'Biance Vision · Access conditions / 开通说明', url: '/contact', scope: ['Current manual access and supported-use boundaries.', '当前人工开通与使用边界。'] },
} as const

export type Translation = {
  locale: Locale; title: string; summary: string; body: string; url: string; translation: string
  author: 'project-maintainers'; reviewedAt: string; modifiedAt: string
  reviewScope: 'source-and-implementation-check'; sources: SourceId[]; toc: { id: string; title: string }[]
}
export type Publication = {
  id: string; path: string; kind: 'guide' | 'demo' | 'page'; topic: Record<Locale, string>
  status: 'published' | 'draft'; relatedDemo: string; translations: Record<Locale, Translation>
}
// The build validator checks the external JSON before it becomes a deployable artifact.
export const publications = raw as Publication[]
export function publishedContent(items: Publication[] = publications) { return items.filter(p => p.status === 'published') }
export function publicPaths(items: Publication[] = publications) { return ['', 'demo', 'guides', 'contact', ...publishedContent(items).map(p => p.path)] }
export const published = publishedContent()
export const pagePaths = publicPaths()
export function publication(path: string) { return published.find(p => p.path === path) }
export function sourceUrl(id: SourceId, locale: Locale) {
  const url = sources[id].url
  return url.startsWith('/') ? `/${locale}${url}` : url
}
