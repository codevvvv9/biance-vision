import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyWs from '@fastify/websocket'
import type { SocketStream } from '@fastify/websocket'
import type WebSocket from 'ws'
import {
  BinanceStream,
  compactTicker,
  marketStats,
  restGet,
  tickerCache,
  tickerOf,
  topUsdtTickers,
} from './binance.js'
import {
  callWebhook,
  createRule,
  evaluateRules,
  getHistory,
  getRules,
  getSettings,
  initStorage,
  removeRule,
  storageMode,
  updateRule,
  updateSettings,
} from './alerts.js'
import type { AlertEntry, ClientMessage, RawKlineRow, ServerMessage } from './types.js'

const PORT = Number(process.env.PORT || 3200)
const MARKET_LIMIT = 150 // 推送给前端的交易对数量（按成交额）
const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']

// 存储初始化（PostgreSQL 优先，不可用降级 JSON），完成后再连行情流
await initStorage()

interface BadRequestError extends Error {
  statusCode: number
}
const badRequest = (msg: string): BadRequestError => Object.assign(new Error(msg), { statusCode: 400 })
const SYMBOL_RE = /^[A-Z0-9]{4,20}$/

// ---------------------------------------------------------------------------
// 币安行情流：全市场 24h miniTicker + 按需的 kline 订阅
// ---------------------------------------------------------------------------
const stream = new BinanceStream()
// !miniTicker@arr：全市场 24h 迷你行情，每秒推送一次（比 !ticker@arr 更轻量，
// 涨跌幅由 (close - open) / open 计算）
stream.subscribe('!miniTicker@arr')

/** 带 isAlive 心跳标记的前端连接 */
type AliveSocket = WebSocket & { isAlive?: boolean }

interface ClientState {
  market: boolean
  klines: Set<string>
}

const clients = new Map<AliveSocket, ClientState>()
const klineMeta = new Map<string, { symbol: string; interval: string }>()

function sendTo(ws: AliveSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerMessage, filter?: (s: ClientState) => boolean): void {
  for (const [ws, state] of clients) {
    if (!filter || filter(state)) sendTo(ws, msg)
  }
}

function onAlertFired(entry: AlertEntry): void {
  broadcast({ type: 'alert', alert: entry })
  callWebhook(entry)
  console.log(`[alert] ${entry.message}`)
}

stream.on((msg) => {
  if (msg.type === 'tickers') {
    for (const t of msg.data) {
      const open = parseFloat(t.o)
      const close = parseFloat(t.c)
      t.P = open > 0 ? (((close - open) / open) * 100).toFixed(4) : '0'
      tickerCache.set(t.s, t)
    }
    const fired = evaluateRules(tickerOf)
    for (const entry of fired) onAlertFired(entry)
  } else if (msg.type === 'kline') {
    const k = msg.data.k
    const streamName = `${msg.data.s.toLowerCase()}@kline_${k.i}`
    if (!klineMeta.has(streamName)) return
    broadcast(
      {
        type: 'kline',
        symbol: msg.data.s,
        interval: k.i,
        kline: {
          time: k.t,
          open: +k.o,
          high: +k.h,
          low: +k.l,
          close: +k.c,
          volume: +k.v,
          quoteVolume: +k.q,
          closed: k.x,
        },
      },
      (s) => s.klines.has(streamName),
    )
  }
})

// 每秒向前端推送行情快照（订阅了 market 频道的客户端）
setInterval(() => {
  if (clients.size === 0 || tickerCache.size === 0) return
  const ruleSymbols = getRules().filter((r) => r.enabled).map((r) => r.symbol)
  const tickers = topUsdtTickers(MARKET_LIMIT, ruleSymbols)
  broadcast(
    {
      type: 'market',
      ts: Date.now(),
      stats: marketStats(),
      tickers: tickers.map(compactTicker),
    },
    (s) => s.market,
  )
}, 1000)

// ---------------------------------------------------------------------------
// Fastify
// ---------------------------------------------------------------------------
const app = Fastify({ logger: false })
await app.register(cors, { origin: true })
await app.register(fastifyWs)

app.get('/api/health', async () => ({
  ok: true,
  binanceStream: stream.connected,
  symbols: tickerCache.size,
  clients: clients.size,
  storage: storageMode(),
}))

app.get('/api/tickers', async (req) => {
  const q = req.query as { limit?: string }
  const limit = Math.min(Math.max(parseInt(q.limit ?? '', 10) || 100, 1), 300)
  return { tickers: topUsdtTickers(limit).map(compactTicker) }
})

app.get('/api/klines', async (req) => {
  const q = req.query as { symbol?: string; interval?: string; limit?: string }
  const symbol = String(q.symbol ?? '').toUpperCase()
  if (!SYMBOL_RE.test(symbol)) throw badRequest('invalid symbol')
  if (!q.interval || !INTERVALS.includes(q.interval)) throw badRequest('invalid interval')
  const n = Math.min(Math.max(parseInt(q.limit ?? '', 10) || 300, 10), 1000)
  const raw = await restGet<RawKlineRow[]>(`/api/v3/klines?symbol=${symbol}&interval=${q.interval}&limit=${n}`)
  return {
    symbol,
    interval: q.interval,
    klines: raw.map((k) => ({
      time: k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
      quoteVolume: +k[7],
      closed: true,
    })),
  }
})

// ---- 预警规则 CRUD ----
app.get('/api/alerts', async () => ({ rules: getRules() }))

app.post('/api/alerts', async (req) => {
  const rule = createRule(req.body ?? {}, tickerOf)
  return { rule }
})

app.put('/api/alerts/:id', async (req) => {
  const { id } = req.params as { id: string }
  const rule = updateRule(id, req.body ?? {}, tickerOf)
  if (!rule) throw badRequest('rule not found')
  return { rule }
})

app.delete('/api/alerts/:id', async (req) => {
  const { id } = req.params as { id: string }
  if (!removeRule(id)) throw badRequest('rule not found')
  return { ok: true }
})

app.get('/api/alerts/history', async (req) => {
  const q = req.query as { limit?: string }
  return { history: getHistory(parseInt(q.limit ?? '', 10) || 50) }
})

// ---- 推送设置 ----
app.get('/api/settings', async () => ({ settings: getSettings() }))

app.put('/api/settings', async (req) => ({ settings: updateSettings(req.body ?? {}) }))

app.post('/api/settings/test', async () => {
  const entry: AlertEntry = {
    id: 'test-' + Date.now(),
    test: true,
    symbol: 'TEST',
    message: '推送链路测试成功：弹窗 / 系统通知 / Webhook 均已触发',
    price: 0,
    changePct: 0,
    triggeredAt: Date.now(),
  }
  broadcast({ type: 'alert', alert: entry })
  callWebhook(entry)
  return { ok: true }
})

// ---- 前端 WebSocket ----
app.get('/ws', { websocket: true }, (connection: SocketStream) => {
  const ws = connection.socket as AliveSocket
  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })
  const state: ClientState = { market: false, klines: new Set() }
  clients.set(ws, state)

  ws.on('message', (raw: WebSocket.RawData) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage
    } catch {
      return
    }
    if (msg.type === 'subscribe' && msg.channel === 'market') {
      state.market = true
      return
    }
    if (msg.type === 'subscribe' && msg.channel === 'kline') {
      const symbol = String(msg.symbol ?? '').toUpperCase()
      const interval = String(msg.interval ?? '')
      if (!SYMBOL_RE.test(symbol) || !INTERVALS.includes(interval)) return
      const name = `${symbol.toLowerCase()}@kline_${interval}`
      klineMeta.set(name, { symbol, interval })
      if (!state.klines.has(name)) {
        state.klines.add(name)
        stream.subscribe(name)
      }
      return
    }
    if (msg.type === 'unsubscribe' && msg.channel === 'kline') {
      const symbol = String(msg.symbol ?? '').toUpperCase()
      const name = `${symbol.toLowerCase()}@kline_${String(msg.interval ?? '')}`
      state.klines.delete(name)
      releaseKline(name)
    }
  })

  const bye = (): void => {
    clients.delete(ws)
    for (const name of state.klines) releaseKline(name)
    state.klines.clear()
  }
  ws.on('close', bye)
  ws.on('error', bye)
})

function releaseKline(name: string): void {
  for (const s of clients.values()) {
    if (s.klines.has(name)) return // 还有别的客户端在看
  }
  stream.unsubscribe(name)
  klineMeta.delete(name)
}

// 前端连接心跳：30s 一次 ping，无 pong 则断开
setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    try {
      ws.ping()
    } catch {
      /* noop */
    }
  }
}, 30000)

app
  .listen({ port: PORT, host: '127.0.0.1' })
  .then(() => {
    console.log(`[server] biance-vision api listening on http://127.0.0.1:${PORT}`)
  })
  .catch((err: Error) => {
    console.error('[server] listen failed:', err)
    process.exit(1)
  })

process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err)
})
