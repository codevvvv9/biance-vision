/**
 * Binance USDⓈ-M 永续 provider（fapi）。
 * 端点契约见 docs/references/binance-products-and-apis.md §2：
 * - trade=/fapi/v1/klines、mark=/fapi/v1/markPriceKlines、index=/fapi/v1/indexPriceKlines
 * - funding=/fapi/v1/fundingRate、OI=/futures/data/openInterestHist
 * 指数/标记 K 线的占位成交量在 parse 层归一化为 null。
 */
import { FundingRateSchema, OpenInterestSchema } from 'biance-vision-brooks'
import type { FundingRate, OpenInterest, PriceType } from 'biance-vision-brooks'
import { kv, log } from '../../logger.js'
import { parseKlineRows } from './parse.js'
import type { FetchFundingParams, FetchKlinesParams, FetchOpenInterestParams, MarketDataProvider } from './types.js'

const FAPI_HOSTS = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
]

const KLINE_PATHS: Record<PriceType, string> = {
  trade: '/fapi/v1/klines',
  mark: '/fapi/v1/markPriceKlines',
  index: '/fapi/v1/indexPriceKlines',
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** fapi GET：多主机回退；429/418 限流按 Retry-After 退避后重试一次；大响应端点可放宽 timeout */
async function fapiGet<T>(pathname: string, timeoutMs = 8000): Promise<T> {
  let lastErr: unknown
  for (const host of FAPI_HOSTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(host + pathname, { signal: AbortSignal.timeout(timeoutMs) })
        if (res.status === 429 || res.status === 418) {
          if (attempt === 0) {
            const retryAfter = Number(res.headers.get('retry-after') ?? '1')
            const waitMs = Math.min(Math.max(retryAfter, 1), 5) * 1000
            log.warn('market', 'fapi 限流，退避后重试', kv({ 主机: host, 路径: pathname, 状态: res.status, 等待: `${waitMs}ms` }))
            await sleep(waitMs)
            continue
          }
          throw new Error(`HTTP ${res.status}（限流重试后仍失败）`)
        }
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 200)
          throw new Error(`HTTP ${res.status} ${body}`)
        }
        const text = await res.text()
        if (!text) throw new Error('HTTP 200 空响应体')
        return JSON.parse(text) as T
      } catch (err) {
        lastErr = err
        if (attempt === 0 && (err as Error).message.startsWith('HTTP ')) break // 非限流 HTTP 错直接换主机
        if (attempt === 1 || !(err as Error).message.startsWith('HTTP ')) {
          log.warn('market', 'fapi 请求失败，切换备用主机', kv({
            主机: host.replace(/^https?:\/\//, ''),
            路径: pathname,
            错误: (err as Error).message,
          }))
        }
      }
    }
  }
  log.error('market', 'fapi 请求失败（所有主机均不可用）', kv({
    路径: pathname,
    最后错误: (lastErr as Error)?.message ?? '',
  }))
  throw lastErr ?? new Error('all fapi hosts unreachable')
}

/** 交易对代码形态（大写字母/数字，与 shared 的 SYMBOL_RE 对齐） */
const SYMBOL_RE = /^[A-Z0-9]{2,30}$/

let symbolsCache: { at: number; symbols: string[] } | null = null
const SYMBOLS_TTL_MS = 10 * 60_000

export class BinanceUsdmProvider implements MarketDataProvider {
  readonly marketType = 'usdm_perp' as const

  async fetchKlines(params: FetchKlinesParams) {
    // indexPriceKlines 用 pair 参数（指数对），klines/markPriceKlines 用 symbol
    const symbolParam = params.priceType === 'index' ? 'pair' : 'symbol'
    const qs = new URLSearchParams({ [symbolParam]: params.symbol, interval: params.interval })
    if (params.startTime !== undefined) qs.set('startTime', String(params.startTime))
    if (params.endTime !== undefined) qs.set('endTime', String(params.endTime))
    qs.set('limit', String(params.limit ?? 500))
    const raw = await fapiGet<unknown[]>(`${KLINE_PATHS[params.priceType]}?${qs.toString()}`)
    return parseKlineRows(raw, {
      venue: 'binance',
      marketType: this.marketType,
      priceType: params.priceType,
      symbol: params.symbol,
      interval: params.interval,
      receivedAt: Date.now(),
      source: 'rest',
    }, Date.now())
  }

  async fetchFundingRates(params: FetchFundingParams): Promise<FundingRate[]> {
    const qs = new URLSearchParams({ symbol: params.symbol })
    if (params.startTime !== undefined) qs.set('startTime', String(params.startTime))
    qs.set('limit', String(params.limit ?? 1000))
    const raw = await fapiGet<unknown[]>(`/fapi/v1/fundingRate?${qs.toString()}`)
    return FundingRateSchema.array().parse(raw)
  }

  async fetchOpenInterest(params: FetchOpenInterestParams): Promise<OpenInterest[]> {
    const qs = new URLSearchParams({
      symbol: params.symbol,
      period: params.interval,
      limit: String(params.limit ?? 500),
    })
    const raw = await fapiGet<{ symbol: string; sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]>(
      `/futures/data/openInterestHist?${qs.toString()}`,
    )
    const rows = raw.map((r): OpenInterest => ({
      symbol: r.symbol,
      openInterest: String(r.sumOpenInterest),
      openInterestValue: r.sumOpenInterestValue == null ? null : String(r.sumOpenInterestValue),
      time: Number(r.timestamp),
    }))
    return OpenInterestSchema.array().parse(rows)
  }

  async listSymbols(): Promise<string[]> {
    // 用 /fapi/v1/ticker/24hr（~300KB）而非 exchangeInfo（>1MB，弱网下不可用）；
    // SYMBOL_RE 归一化：剔除交割合约（BTCUSDT_251226 等含下划线形式）与杠杆代币
    if (symbolsCache && Date.now() - symbolsCache.at < SYMBOLS_TTL_MS) return symbolsCache.symbols
    const raw = await fapiGet<{ symbol: string }[]>('/fapi/v1/ticker/24hr', 20000)
    const symbols = raw
      .map((t) => t.symbol)
      .filter((s) => s.endsWith('USDT') && SYMBOL_RE.test(s) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(s))
      .sort()
    symbolsCache = { at: Date.now(), symbols }
    log.info('market', '永续交易对列表已刷新', kv({ 数量: symbols.length }))
    return symbols
  }

  /** 实时价（快照 priceAsOf 用）：REST ticker/price，失败返回 null */
  async fetchPrice(symbol: string): Promise<{ price: string; time: number } | null> {
    try {
      const t = await fapiGet<{ symbol: string; price: string }>(
        `/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`,
      )
      return { price: t.price, time: Date.now() }
    } catch (err) {
      log.warn('market', '永续实时价获取失败', kv({ 交易对: symbol, 错误: (err as Error).message }))
      return null
    }
  }
}
