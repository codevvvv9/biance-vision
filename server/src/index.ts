import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifyWs from '@fastify/websocket'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  conditionText,
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
import { endSessionAudit, initAudit, queryAudit, recordAudit, recordFailedLogin, startSessionAudit } from './audit.js'
import type { AlertEntry, ClientMessage, RawKlineRow, RuleInput, ServerMessage } from './types.js'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  findSession,
  initUsers,
  readSessionToken,
  sessionCookie,
  toPublic,
  verifyLogin,
} from './users.js'
import type { SessionRecord } from './users.js'
import { log } from './logger.js'
import type { FastifyReply, FastifyRequest } from 'fastify'

const PORT = Number(process.env.PORT || 3200)
// 监听地址：默认只绑本机；Docker / 容器部署时用 HOST=0.0.0.0 覆盖
const HOST = process.env.HOST || '127.0.0.1'
// 前端构建产物目录：生产模式下由本服务直接托管（前后端同源）
const WEB_DIST = process.env.BV_WEB_DIST || fileURLToPath(new URL('../../web/dist', import.meta.url))
const MARKET_LIMIT = 150 // 推送给前端的交易对数量（按成交额）
const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']

// 存储初始化（PostgreSQL 优先，不可用降级 JSON），完成后再连行情流
await initStorage()
await initUsers()
await initAudit()

interface BadRequestError extends Error {
  statusCode: number
}
const badRequest = (msg: string): BadRequestError => Object.assign(new Error(msg), { statusCode: 400 })
const SYMBOL_RE = /^[A-Z0-9]{4,20}$/

// ---------------------------------------------------------------------------
// 币安行情流：全市场 24h miniTicker + 按需的 kline 订阅
// ---------------------------------------------------------------------------
const stream = new BinanceStream()
// 最近一次收到行情推送的时间（health 暴露，用于判断行情链路是否活着）
let lastTickerAt = 0
// !miniTicker@arr：全市场 24h 迷你行情，每秒推送一次（比 !ticker@arr 更轻量，
// 涨跌幅由 (close - open) / open 计算）
stream.subscribe('!miniTicker@arr')

/** 带 isAlive 心跳标记与短 id 的前端连接 */
type AliveSocket = WebSocket & { isAlive?: boolean; cid?: string }

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
  log.ok('alert', entry.message)
}

stream.on((msg) => {
  if (msg.type === 'tickers') {
    lastTickerAt = Date.now()
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
const app = Fastify({ logger: false, trustProxy: true })
await app.register(cors, { origin: true })
await app.register(fastifyWs)

// ---------------------------------------------------------------------------
// 生产模式：托管 web/dist 静态资源，一个端口同时服务页面 / API / WebSocket；
// 未构建（开发模式目录不存在）时跳过，前端仍由 Vite dev server 提供。
// SPA 回退：非 /api 的 GET 未命中文件时返回 index.html，支持 /login 等前端路由直开
// ---------------------------------------------------------------------------
if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: path.resolve(WEB_DIST) })
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.split('?')[0].startsWith('/api/')) {
      return reply.sendFile('index.html')
    }
    reply.code(404).send({ message: 'Not Found' })
  })
  log.info('server', `托管前端静态资源：${WEB_DIST}`)
}

// ---------------------------------------------------------------------------
// 登录鉴权：Cookie 会话；除白名单外的 /api/* 与 /ws 均要求已登录
// ---------------------------------------------------------------------------
const unauthorized = (): Error => Object.assign(new Error('未登录或会话已过期'), { statusCode: 401 })

function requireSession(req: FastifyRequest): SessionRecord {
  const session = findSession(readSessionToken(req.headers.cookie))
  if (!session) throw unauthorized()
  return session
}

// 登录 / 会话查询走白名单，其余 /api/* 一律拦截
app.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0]
  if (!url.startsWith('/api/')) return
  if (url === '/api/health' || url.startsWith('/api/auth/')) return
  try {
    requireSession(req)
  } catch (err) {
    const e = err as { statusCode?: number }
    reply.code(e.statusCode ?? 401).send({ message: (err as Error).message })
  }
})

/**
 * 客户端真实 IP：反向代理 / 隧道场景取 x-forwarded-for 最原始一跳，
 * 其次 x-real-ip（nginx 惯例）；直连时就是连接地址。trustProxy 已开启，
 * req.ip 本身也会按 XFF 解析，这里显式分级兜底。
 */
function clientIp(req: FastifyRequest): string {
  const pick = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() ?? ''
  const xf = pick(req.headers['x-forwarded-for'])
  if (xf) return xf.slice(0, 64)
  const real = pick(req.headers['x-real-ip'])
  if (real) return real.slice(0, 64)
  return String(req.ip ?? '')
}

/** 浏览器 / 客户端标识（截断，用于会话审计） */
function userAgent(req: FastifyRequest): string {
  return String(req.headers['user-agent'] ?? '').slice(0, 160)
}

/** 只记录 Webhook 的主机名，避免完整地址（含密钥）进审计日志 */
function webhookHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '无效地址'
  }
}

app.post('/api/auth/login', async (req, reply) => {
  const body = (req.body ?? {}) as { username?: unknown; password?: unknown }
  const name = String(body.username ?? '').trim()
  const user = verifyLogin(name, String(body.password ?? ''))
  if (!user) {
    recordFailedLogin({ username: name.slice(0, 64), ip: clientIp(req), userAgent: userAgent(req) })
    throw Object.assign(new Error('用户名或密码错误'), { statusCode: 401 })
  }
  const session = createSession(user)
  startSessionAudit(session, { ip: clientIp(req), userAgent: userAgent(req) })
  reply.header('set-cookie', sessionCookie(session.token))
  return { user: toPublic(user) }
})

app.post('/api/auth/logout', async (req, reply) => {
  const token = readSessionToken(req.headers.cookie)
  const session = findSession(token)
  if (session) endSessionAudit(session)
  destroySession(token)
  reply.header('set-cookie', clearSessionCookie())
  return { ok: true }
})

app.get('/api/auth/me', async (req) => {
  const session = findSession(readSessionToken(req.headers.cookie))
  if (!session) throw unauthorized()
  const user = { username: session.username, role: session.role }
  return { user }
})

app.get('/api/health', async () => ({
  ok: true,
  binanceStream: stream.connected,
  symbols: tickerCache.size,
  clients: clients.size,
  storage: storageMode(),
  uptime: Math.floor(process.uptime()),
  lastTickerAt,
  tickerAgeMs: lastTickerAt === 0 ? null : Date.now() - lastTickerAt,
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
  const session = requireSession(req)
  const rule = createRule(req.body ?? {}, tickerOf)
  recordAudit(session, {
    action: 'rule_create',
    target: rule.symbol,
    detail: `新增规则：${conditionText(rule)}${rule.note ? `（${rule.note}）` : ''}`,
  })
  return { rule }
})

app.put('/api/alerts/:id', async (req) => {
  const session = requireSession(req)
  const { id } = req.params as { id: string }
  const patch = (req.body ?? {}) as RuleInput
  const rule = updateRule(id, patch, tickerOf)
  if (!rule) throw badRequest('rule not found')
  const toggleOnly =
    patch.enabled !== undefined &&
    patch.symbol === undefined &&
    patch.type === undefined &&
    patch.value === undefined &&
    patch.note === undefined
  recordAudit(session, {
    action: 'rule_update',
    target: rule.symbol,
    detail: toggleOnly
      ? rule.enabled
        ? '启用规则'
        : '停用规则'
      : `修改规则：${conditionText(rule)}${rule.note ? `（${rule.note}）` : ''}`,
  })
  return { rule }
})

app.delete('/api/alerts/:id', async (req) => {
  const session = requireSession(req)
  const { id } = req.params as { id: string }
  const rule = getRules().find((r) => r.id === id)
  if (!removeRule(id)) throw badRequest('rule not found')
  recordAudit(session, {
    action: 'rule_delete',
    target: rule?.symbol ?? id,
    detail: rule ? `删除规则：${conditionText(rule)}${rule.note ? `（${rule.note}）` : ''}` : `删除规则：${id}`,
  })
  return { ok: true }
})

app.get('/api/alerts/history', async (req) => {
  const q = req.query as { limit?: string }
  return { history: getHistory(parseInt(q.limit ?? '', 10) || 50) }
})

// ---- 推送设置 ----
app.get('/api/settings', async () => ({ settings: getSettings() }))

app.put('/api/settings', async (req) => {
  const session = requireSession(req)
  const settings = updateSettings(req.body ?? {})
  recordAudit(session, {
    action: 'settings_update',
    target: 'webhook',
    detail: settings.webhookUrl
      ? `更新推送地址（${webhookHost(settings.webhookUrl)}）`
      : '清空推送地址',
  })
  return { settings }
})

app.post('/api/settings/test', async (req) => {
  const session = requireSession(req)
  recordAudit(session, { action: 'settings_test', target: 'webhook', detail: '发送测试推送' })
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

// ---- 管理端：操作审计日志（仅超级管理员） ----
app.get('/api/admin/audit-logs', async (req) => {
  const session = requireSession(req)
  if (session.role !== 'superadmin') {
    throw Object.assign(new Error('仅超级管理员可查看操作日志'), { statusCode: 403 })
  }
  const q = req.query as { username?: string; limit?: string }
  return queryAudit({ username: q.username, limit: parseInt(q.limit ?? '', 10) || 200 })
})

// ---- 前端 WebSocket（升级请求携带会话 Cookie，未登录直接关闭） ----
app.get('/ws', { websocket: true }, (connection: SocketStream, req: FastifyRequest) => {
  if (!findSession(readSessionToken(req.headers.cookie))) {
    log.warn('ws', `未登录连接被拒 ip=${clientIp(req)}`)
    connection.socket.close(4001, 'unauthorized')
    return
  }
  const ws = connection.socket as AliveSocket
  ws.isAlive = true
  const cid = Math.random().toString(36).slice(2, 8)
  ws.cid = cid
  ws.on('pong', () => {
    ws.isAlive = true
  })
  const state: ClientState = { market: false, klines: new Set() }
  clients.set(ws, state)
  log.info('ws', `客户端 ${cid} 连接（当前 ${clients.size} 个）`)

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
    log.info('ws', `客户端 ${ws.cid ?? '?'} 断开（剩余 ${clients.size} 个）`)
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
      log.warn('ws', `客户端 ${ws.cid ?? '?'} 心跳超时，已断开`)
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
  .listen({ port: PORT, host: HOST })
  .then(() => {
    log.ok('server', `biance-vision api listening on http://${HOST}:${PORT}`)
  })
  .catch((err: Error) => {
    log.error('server', 'listen failed:', err)
    process.exit(1)
  })

process.on('unhandledRejection', (err) => {
  log.error('server', 'unhandled rejection:', err)
})
