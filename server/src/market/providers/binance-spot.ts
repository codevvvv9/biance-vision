/**
 * Binance 现货 provider：包装现有 binance.ts 的 restGet（多主机轮换 + 8s 超时）。
 * 现货只支持 priceType=trade。
 */
import { isWatchableUsdt, restGet, tickerCache } from '../../binance.js'
import { kv, log } from '../../logger.js'
import { parseKlineRows } from './parse.js'
import type { FetchKlinesParams, MarketDataProvider } from './types.js'
import type { CandleRow } from 'biance-vision-brooks'

/** 交易对代码形态（大写字母/数字，与 shared SYMBOL_RE 对齐；剔除中文名代币等特殊符号） */
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/
const isListable = (s: string): boolean => isWatchableUsdt(s) && SYMBOL_RE.test(s)

/** 交易对列表进程内缓存（10 分钟），避免每个 symbols 请求都打一次交易所 */
let symbolsCache: { at: number; symbols: string[] } | null = null
const SYMBOLS_TTL_MS = 10 * 60_000

export class BinanceSpotProvider implements MarketDataProvider {
  readonly marketType = 'spot' as const

  async fetchKlines(params: FetchKlinesParams): Promise<CandleRow[]> {
    if (params.priceType !== 'trade') {
      throw new Error(`现货不支持价格类型 ${params.priceType}（仅 trade）`)
    }
    const qs = new URLSearchParams({ symbol: params.symbol, interval: params.interval })
    if (params.startTime !== undefined) qs.set('startTime', String(params.startTime))
    if (params.endTime !== undefined) qs.set('endTime', String(params.endTime))
    qs.set('limit', String(params.limit ?? 500))
    const raw = await restGet<unknown[]>(`/api/v3/klines?${qs.toString()}`)
    return parseKlineRows(raw, {
      venue: 'binance',
      marketType: this.marketType,
      priceType: 'trade',
      symbol: params.symbol,
      interval: params.interval,
      receivedAt: Date.now(),
      source: 'rest',
    }, Date.now())
  }

  async listSymbols(): Promise<string[]> {
    // 优先用已在内存的全市场 ticker（app 进程的行情流缓存），其次 REST 24hr ticker；
    // 不用 /api/v3/exchangeInfo（~17MB，弱网下不可用）
    if (symbolsCache && Date.now() - symbolsCache.at < SYMBOLS_TTL_MS) return symbolsCache.symbols
    if (tickerCache.size > 0) {
      const symbols = [...tickerCache.keys()].filter(isListable).sort()
      symbolsCache = { at: Date.now(), symbols }
      return symbols
    }
    const raw = await restGet<{ symbol: string }[]>('/api/v3/ticker/24hr')
    const symbols = raw.map((t) => t.symbol).filter(isListable).sort()
    symbolsCache = { at: Date.now(), symbols }
    log.info('market', '现货交易对列表已刷新', kv({ 数量: symbols.length }))
    return symbols
  }

  /** 实时价（快照 priceAsOf 用）：优先 tickerCache，未就绪回退 REST ticker/price */
  async fetchPrice(symbol: string): Promise<{ price: string; time: number } | null> {
    const cached = tickerCache.get(symbol)
    if (cached) return { price: cached.c, time: Date.now() }
    try {
      const t = await restGet<{ symbol: string; price: string }>(
        `/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
      )
      return { price: t.price, time: Date.now() }
    } catch (err) {
      log.warn('market', '现货实时价获取失败', kv({ 交易对: symbol, 错误: (err as Error).message }))
      return null
    }
  }
}
