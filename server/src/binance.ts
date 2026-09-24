import WebSocket from 'ws'
import { fmtMs, kv, log } from './logger.js'
import type {
  CompactTicker,
  MarketStats,
  RawKlineRow,
  RawTicker,
  StreamEvent,
  TickerSnapshot,
} from './types.js'

// 公开行情专用域名优先，失败时回退到主站 API
const REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com']
const WS_HOSTS = [
  'wss://data-stream.binance.vision/ws',
  'wss://stream.binance.com:9443/ws',
  'wss://stream.binance.com:443/ws',
]

export async function restGet<T>(pathname: string): Promise<T> {
  let lastErr: unknown
  for (const host of REST_HOSTS) {
    try {
      const res = await fetch(host + pathname, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (err) {
      lastErr = err
      log.warn('binance', 'REST 请求失败，切换备用主机', kv({
        主机: host.replace(/^https?:\/\//, ''),
        路径: pathname,
        错误: (err as Error).message,
      }))
    }
  }
  log.error('binance', 'REST 请求失败（所有主机均不可用）', kv({
    路径: pathname,
    最后错误: (lastErr as Error)?.message ?? '',
  }))
  throw lastErr ?? new Error('all binance hosts unreachable')
}

/**
 * 币安行情流管理：单条 WebSocket 连接，通过 SUBSCRIBE/UNSUBSCRIBE
 * 动态增删 stream（带引用计数），断线自动轮换主机并指数退避重连。
 */
export class BinanceStream {
  private ws: WebSocket | null = null
  private hostIdx = 0
  private backoff = 1000
  private streams = new Map<string, number>() // streamName -> refcount
  private listeners = new Set<(msg: StreamEvent) => void>()
  private reqId = 1
  private closed = false
  /** 当前连接的统计：建立时间与收到的消息数（重连时清零） */
  private openedAt = 0
  private msgCount = 0

  connected = false

  constructor() {
    this.connect()
  }

  /** 供运行状态日志 / health 输出 */
  stats(): { connected: boolean; uptimeMs: number; messages: number; streams: number } {
    return {
      connected: this.connected,
      uptimeMs: this.connected ? Date.now() - this.openedAt : 0,
      messages: this.msgCount,
      streams: this.streams.size,
    }
  }

  on(fn: (msg: StreamEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(msg: StreamEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(msg)
      } catch (err) {
        log.error('binance', 'listener error:', err)
      }
    }
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  subscribe(name: string): void {
    const n = (this.streams.get(name) ?? 0) + 1
    this.streams.set(name, n)
    if (n === 1 && this.connected) {
      this.send({ method: 'SUBSCRIBE', params: [name], id: this.reqId++ })
    }
  }

  unsubscribe(name: string): void {
    const n = (this.streams.get(name) ?? 0) - 1
    if (n <= 0) {
      this.streams.delete(name)
      if (this.connected) {
        this.send({ method: 'UNSUBSCRIBE', params: [name], id: this.reqId++ })
      }
    } else {
      this.streams.set(name, n)
    }
  }

  private connect(): void {
    if (this.closed) return
    const url = WS_HOSTS[this.hostIdx % WS_HOSTS.length]
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => {
      this.connected = true
      this.backoff = 1000
      this.openedAt = Date.now()
      this.msgCount = 0
      const names = [...this.streams.keys()]
      log.ok('binance', `stream connected: ${url}`, kv({ 订阅流: names.length }))
      if (names.length) {
        this.send({ method: 'SUBSCRIBE', params: names, id: this.reqId++ })
      }
      this.emit({ type: 'status', connected: true })
    })

    ws.on('message', (raw: WebSocket.RawData) => {
      this.msgCount++
      let msg: unknown
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      // !miniTicker@arr 的推送是裸数组；kline 是带 e 字段的对象；订阅回执带 id 无 e
      if (Array.isArray(msg)) {
        this.emit({ type: 'tickers', data: msg as RawTicker[] })
      } else if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { e?: string }).e === 'kline'
      ) {
        this.emit({ type: 'kline', data: msg as import('./types.js').RawKlineEvent })
      }
    })

    const drop = (reason: string): void => {
      if (this.closed || this.ws !== ws) return
      this.connected = false
      this.ws = null
      this.emit({ type: 'status', connected: false })
      const wait = this.backoff
      log.warn('binance', '行情流断开，准备重连', kv({
        原因: reason,
        在线时长: this.openedAt ? fmtMs(Date.now() - this.openedAt) : '?',
        收到消息: this.msgCount,
        重连等待: fmtMs(wait),
      }))
      setTimeout(() => this.connect(), wait)
      this.backoff = Math.min(this.backoff * 2, 15000)
      this.hostIdx++
    }
    ws.on('close', () => drop('closed'))
    ws.on('error', (err: Error) => {
      if (this.ws === ws) log.warn('binance', 'stream error:', err.message)
    })
  }

  destroy(): void {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}

/** 全市场 24h ticker 缓存：symbol -> 原始 ticker 对象（币安短字段，值均为字符串） */
export const tickerCache = new Map<string, RawTicker>()

const EXCLUDE_RE = /(UP|DOWN|BULL|BEAR)USDT$/

export function isWatchableUsdt(sym: string): boolean {
  return sym.endsWith('USDT') && !EXCLUDE_RE.test(sym)
}

export function topUsdtTickers(limit = 100, extraSymbols: string[] = []): RawTicker[] {
  const list: RawTicker[] = []
  for (const t of tickerCache.values()) {
    if (isWatchableUsdt(t.s)) list.push(t)
  }
  list.sort((a, b) => parseFloat(b.q) - parseFloat(a.q))
  const merged = list.slice(0, limit)
  const have = new Set(merged.map((t) => t.s))
  for (const s of extraSymbols) {
    const t = tickerCache.get(s)
    if (t && !have.has(s)) {
      merged.push(t)
      have.add(s)
    }
  }
  return merged
}

export function marketStats(): MarketStats {
  let up = 0
  let down = 0
  let total = 0
  for (const t of tickerCache.values()) {
    if (!isWatchableUsdt(t.s)) continue
    const p = parseFloat(t.P)
    if (p > 0) up++
    else if (p < 0) down++
    total += parseFloat(t.q) || 0
  }
  return { up, down, totalQuoteVolume: total }
}

export function tickerOf(symbol: string): TickerSnapshot | null {
  const t = tickerCache.get(symbol)
  if (!t) return null
  return {
    last: parseFloat(t.c),
    changePct: parseFloat(t.P),
    high: parseFloat(t.h),
    low: parseFloat(t.l),
    quoteVolume: parseFloat(t.q),
  }
}

export const compactTicker = (t: RawTicker): CompactTicker => ({
  s: t.s,
  c: t.c,
  P: t.P,
  h: t.h,
  l: t.l,
  q: t.q,
})

export type { RawKlineRow }
