/**
 * Yahoo Finance 证券 provider（特斯拉/三星/SK 海力士/DXYZ 等，标的清单见 shared instruments 注册表）。
 * 使用 Yahoo 非官方 chart 接口（免费无 Key）；限流/改版风险由 provider 内部消化：
 * 多主机回退 + 429 退避 + 同序列短 TTL 缓存，失败抛错交由既有 ingest 重试/缺口登记兜底。
 * Yahoo 原生无 10m/4h：10m 经共享 intervalAgg 由 5m 聚合；4h 等不支持周期直接抛错。
 */
import { STOCK_SYMBOLS } from 'biance-vision-brooks'
import { INTERVAL_MS } from 'biance-vision-brooks'
import type { CandleRow, Interval, PriceType } from 'biance-vision-brooks'
import { kv, log } from '../../logger.js'
import { aggregateCandleRows, requestIntervalFor } from './intervalAgg.js'
import type { FetchKlinesParams, MarketDataProvider } from './types.js'

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']
const TIMEOUT_MS = 8000
/** 429/999（Yahoo 限流码）退避重试 */
const RATE_LIMIT_CODES = new Set([429, 999])
const RETRY_DELAY_MS = 1500
/** 同序列结果缓存 TTL（直通端点高频轮询 + 每 5 分钟 sweep 去重） */
const CACHE_TTL_MS = 30_000

/** Yahoo 原生支持的 interval（10m 经 intervalAgg 换 5m 聚合） */
const NATIVE_INTERVALS = new Set(['1m', '5m', '15m', '30m', '1h', '1d'])
/** Yahoo interval ↔ 可回溯区间上限（毫秒）——超出部分 Yahoo 静默截断，按缺口登记兜底 */
const RANGE_LIMIT_MS: Record<string, number> = {
  '1m': 7 * 24 * 3_600_000,
  '5m': 60 * 24 * 3_600_000,
  '15m': 730 * 24 * 3_600_000,
  '30m': 730 * 24 * 3_600_000,
  '1h': 730 * 24 * 3_600_000,
  '1d': 10 * 365 * 24 * 3_600_000,
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number; regularMarketTime?: number }
      timestamp?: number[]
      indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> }
    }>
    error?: { code?: string; description?: string } | null
  }
}

/** 同序列（symbol+interval+窗口签名）结果缓存 */
const cache = new Map<string, { at: number; rows: CandleRow[] }>()

async function yahooGet<T>(pathname: string): Promise<T> {
  let lastErr: unknown
  for (const host of HOSTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(host + pathname, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; biance-vision/1.0)' },
        })
        if (RATE_LIMIT_CODES.has(res.status) && attempt === 0) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
          continue
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as T
      } catch (err) {
        lastErr = err
        break // 该主机失败即换下一主机（退避只在限流时做）
      }
    }
  }
  throw lastErr ?? new Error('yahoo hosts unreachable')
}

/** Yahoo 响应 → CandleRow（interval 为实际请求的 Yahoo 原生周期） */
function parseNativeRows(
  raw: YahooChartResponse,
  intervalMs: number,
  now: number,
  meta: { symbol: string; interval: Interval },
): CandleRow[] {
  const result = raw.chart?.result?.[0]
  const quote = result?.indicators?.quote?.[0]
  const stamps = result?.timestamp
  if (!result || !quote || !stamps) return []
  const rows: CandleRow[] = []
  for (let i = 0; i < stamps.length; i++) {
    const o = quote.open?.[i]
    const h = quote.high?.[i]
    const l = quote.low?.[i]
    const c = quote.close?.[i]
    if (o == null || h == null || l == null || c == null) continue // 停牌/缺失 bar
    const v = quote.volume?.[i] ?? null
    rows.push({
      venue: 'yahoo',
      marketType: 'stock',
      priceType: 'trade',
      symbol: meta.symbol,
      interval: meta.interval,
      openTime: stamps[i] * 1000,
      closeTime: stamps[i] * 1000 + intervalMs - 1,
      open: String(o),
      high: String(h),
      low: String(l),
      close: String(c),
      volume: v === null ? null : String(v),
      quoteVolume: null,
      trades: null,
      isClosed: stamps[i] * 1000 + intervalMs - 1 <= now,
      eventTime: null,
      receivedAt: now,
      source: 'rest',
      revision: 0,
    })
  }
  return rows
}

export class YahooStockProvider implements MarketDataProvider {
  readonly marketType = 'stock' as const

  async fetchKlines(params: FetchKlinesParams): Promise<CandleRow[]> {
    if (params.priceType !== 'trade') {
      throw new Error(`证券不支持价格类型 ${params.priceType}（仅 trade）`)
    }
    // 10m 等聚合周期换 Yahoo 原生周期请求，响应侧走共享聚合（intervalAgg 单点语义）
    const { requestInterval: fetchInterval, requestLimit, aggregateTo } = requestIntervalFor(params.interval, params.limit)
    if (!NATIVE_INTERVALS.has(fetchInterval)) {
      throw new Error(`Yahoo 不支持周期 ${params.interval}（证券可用：${[...NATIVE_INTERVALS].join('/')} 与 10m）`)
    }
    const fetchIntervalMs = INTERVAL_MS[fetchInterval]
    const intervalMs = INTERVAL_MS[params.interval as Interval]
    const now = Date.now()
    const period2 = Math.min(params.endTime ?? now, now)
    // 起点推算：覆盖请求窗口（startTime 起）或 requestLimit 根原生 bar + 边界缓冲
    const spanMs = Math.max(
      requestLimit * fetchIntervalMs + fetchIntervalMs,
      params.startTime !== undefined ? period2 - params.startTime + intervalMs : 0,
    )
    const rangeLimit = RANGE_LIMIT_MS[fetchInterval] ?? RANGE_LIMIT_MS['1d']
    const period1 = Math.max(period2 - Math.min(spanMs, rangeLimit), 0)

    const cacheKey = `${params.symbol}/${params.interval}/${period1}/${period2}/${requestLimit}`
    const hit = cache.get(cacheKey)
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.rows

    const pathname =
      `/v8/finance/chart/${encodeURIComponent(params.symbol)}` +
      `?interval=${fetchInterval}&period1=${Math.floor(period1 / 1000)}&period2=${Math.ceil(period2 / 1000)}` +
      `&includePrePost=false&events=div%2Csplits`
    const raw = await yahooGet<YahooChartResponse>(pathname)
    const err = raw.chart?.error
    if (err) throw new Error(`Yahoo chart 错误：${err.code ?? ''} ${err.description ?? ''}`)
    let rows = parseNativeRows(raw, fetchIntervalMs, now, { symbol: params.symbol, interval: fetchInterval })
    if (aggregateTo !== null) rows = aggregateCandleRows(rows, fetchInterval, aggregateTo)
    if (params.startTime !== undefined) rows = rows.filter((r) => r.openTime >= params.startTime!)
    if (params.endTime !== undefined) rows = rows.filter((r) => r.openTime <= params.endTime!)
    // Yahoo 按 period 区间返回，不受根数控制：统一截取最靠近最新的 limit 根
    const limit = params.limit ?? 500
    if (rows.length > limit) rows = rows.slice(rows.length - limit)
    if (cache.size > 200) cache.clear() // 简单防膨胀（序列数有限，正常不触顶）
    cache.set(cacheKey, { at: now, rows })
    return rows
  }

  async fetchPrice(symbol: string): Promise<{ price: string; time: number } | null> {
    try {
      const raw = await yahooGet<YahooChartResponse>(
        `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      )
      const meta = raw.chart?.result?.[0]?.meta
      if (meta?.regularMarketPrice == null) return null
      return { price: String(meta.regularMarketPrice), time: (meta.regularMarketTime ?? 0) * 1000 || Date.now() }
    } catch (err) {
      log.warn('market', '证券实时价获取失败', kv({ 标的: symbol, 错误: (err as Error).message }))
      return null
    }
  }

  async listSymbols(): Promise<string[]> {
    return [...STOCK_SYMBOLS]
  }
}
