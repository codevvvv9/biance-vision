import './env.js' // 入口首位：env 校验先于一切模块顶层写盘（C3 断言依赖）
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifyWs from '@fastify/websocket'
import fs from 'node:fs'
import { STATUS_CODES } from 'node:http'
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
import { endSessionAudit, initAudit, recordAudit, recordFailedLogin, startSessionAudit } from './audit.js'
import { isDbAvailable } from './db.js'
import {
  aiModelName,
  aiProfileByName,
  buildSystemPrompt,
  checkAiQuota,
  clearAiConfig,
  clearAiProfile,
  getAiProfilesMasked,
  getAiNews,
  isAiConfigured,
  listAiModels,
  recordAiUsage,
  resolveAiProfile,
  resolveApiKey,
  saveAiProfiles,
  testAiConnection,
} from './ai.js'
import {
  appendConversationMessages,
  chatHistoryOf,
  clearMemories,
  createConversation,
  deleteConversation,
  deleteMemory,
  getConversation,
  initAiMemory,
  listConversations,
  listMemories,
  maybeExtractMemories,
  memoriesPromptBlock,
  updateMemory,
} from './aiMemory.js'
import { assertChatAllowed, initChatUsage, recordChatMessage } from './chatPolicy.js'
import { runSlashCommand, runToolLoop } from './aiTools.js'
import type { AlertEntry, ClientMessage, RawKlineRow, RuleInput, ServerMessage } from './types.js'
import { findSession, initSessions, initUsers, readSessionToken } from './users.js'
import type { SessionRecord } from './users.js'
import { log, kv, fmtMs, briefUa } from './logger.js'
import { geoBlockStatus, initGeoBlock, isRegionBlocked, registerGeoBlock } from './geoblock.js'
import { startQueue } from './queue.js'
import { clientIpOf, registerAuthRoutes, unauthorized } from './authRoutes.js'

const clientIp = clientIpOf
import { registerAiAccessGuard } from './aiAccess.js'
import { registerMarketRoutes } from './market/routes.js'
import { currentBlobStoreKind } from './knowledge/blobstore.js'
import { registerProductRoutes } from './research/productRoutes.js'
import { registerResearchRunRoutes } from './research/runs/routes.js'
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
await initSessions()
await initAudit()
await initAiMemory()
await initChatUsage() // W3 后修订：当日用量收编进 PG（一次性迁移旧 JSON）
// 地域封锁（默认屏蔽中国大陆来源 IP；名单缺失时 fail-open 并告警，详见 geoblock.ts）
initGeoBlock()

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
  connectedAt: number
  user: string
  ip: string
  ua: string
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
  log.ok('alert', entry.message, kv({
    触发价: entry.price,
    '24h涨跌': `${entry.changePct >= 0 ? '+' : ''}${entry.changePct.toFixed(2)}%`,
    规则: entry.ruleId,
  }))
}

// 首次行情就绪的里程碑日志（只在缓存从空到有变化时打一次）
let marketReady = false

stream.on((msg) => {
  if (msg.type === 'tickers') {
    lastTickerAt = Date.now()
    for (const t of msg.data) {
      const open = parseFloat(t.o)
      const close = parseFloat(t.c)
      t.P = open > 0 ? (((close - open) / open) * 100).toFixed(4) : '0'
      tickerCache.set(t.s, t)
    }
    if (!marketReady && tickerCache.size > 0) {
      marketReady = true
      const top = [...tickerCache.values()].sort((a, b) => parseFloat(b.q) - parseFloat(a.q))[0]
      const btc = tickerCache.get('BTCUSDT')
      log.ok('binance', '行情数据就绪', kv({
        交易对: tickerCache.size,
        成交额榜首: top ? `${top.s}（${(parseFloat(top.q) / 1e8).toFixed(1)}亿）` : undefined,
        BTC: btc ? `${btc.c}（${btc.P}%）` : undefined,
      }))
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

// 定期行情概览：低频（10 分钟）打一条市场全景，日志面板可直接看盘
setInterval(() => {
  if (tickerCache.size === 0) return
  const stats = marketStats()
  const byChange = [...topUsdtTickers(MARKET_LIMIT)].sort((a, b) => parseFloat(b.P) - parseFloat(a.P))
  const gainer = byChange[0]
  const loser = byChange[byChange.length - 1]
  const btc = tickerCache.get('BTCUSDT')
  const s = stream.stats()
  log.info('market', '行情概览', kv({
    交易对: stats.up + stats.down,
    上涨: stats.up,
    下跌: stats.down,
    '24h成交额': `${(stats.totalQuoteVolume / 1e8).toFixed(1)}亿USDT`,
    BTC: btc ? `${btc.c}（${btc.P}%）` : undefined,
    涨幅榜首: gainer ? `${gainer.s} +${gainer.P}%` : undefined,
    跌幅榜首: loser ? `${loser.s} ${loser.P}%` : undefined,
    行情延迟: lastTickerAt ? fmtMs(Date.now() - lastTickerAt) : '无数据',
    在线客户端: clients.size,
    行情流: `${s.connected ? '已连接' : '断开'}（${s.streams} 个订阅 / 累计 ${s.messages} 条消息）`,
  }))
}, 10 * 60 * 1000)

// ---------------------------------------------------------------------------
// Fastify
// ---------------------------------------------------------------------------
const app = Fastify({ logger: false, trustProxy: true })

// 统一错误映射：路由内 throw Object.assign(new Error(msg), { statusCode, code? })
// 转为 { statusCode, error, message, code? }——message 面向最终用户（前端原样展示）；
// code 为机器可读业务码（如 chat_disabled / chat_limit_exceeded），仅 4xx 透传——
// 5xx 不回显内部 message 也不透 code（防泄露 PG SQLSTATE / 系统错误码等内部细节），
// 与 fastify 默认错误响应语义一致。
app.setErrorHandler((err, req, reply) => {
  const e = err as { statusCode?: number; code?: string; message?: string }
  const statusCode = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500
  if (statusCode >= 500) log.error('http', '未处理异常', err)
  const body: Record<string, unknown> = {
    statusCode,
    error: STATUS_CODES[statusCode] ?? 'Error',
    message: statusCode >= 500 ? 'Internal Server Error' : String(e.message ?? ''),
  }
  if (statusCode < 500 && typeof e.code === 'string') body.code = e.code
  void reply.code(statusCode).send(body)
})

await app.register(cors, { origin: true })
await app.register(fastifyWs)

// ---------------------------------------------------------------------------
// 生产模式：托管 web/dist（用户端）静态资源；未构建时跳过（Vite dev 提供）。
// SPA 回退：非 /api 的 GET 未命中文件时返回 index.html，支持 /login 等前端路由直开。
// W3-S3：管理端产物（dist-admin）与管理 API 改由 admin-api 进程（adminApi.ts，
// 端口 3201）承担——user-api 物理上没有管理前端与管理路由。/admin* 显式 404
// （绝不落到 SPA 回退把用户端壳发给爬虫），与 Caddy 主域名 404 屏蔽互为纵深。
// ---------------------------------------------------------------------------
const webDistExists = fs.existsSync(WEB_DIST)
if (webDistExists) {
  await app.register(fastifyStatic, { root: path.resolve(WEB_DIST, 'assets'), prefix: '/assets/' })
  log.info('server', `托管前端静态资源：${WEB_DIST}（user-api；管理端见 admin-api 进程）`)
}
// SPA 回退仅限显式终端页面；官网与未知页面由 Caddy/Next 处理。
// /admin* 与 dist 缺失（开发模式）一律 404——不回退 SPA、不留 /admin* 空门
app.setNotFoundHandler((req, reply) => {
  const p = req.url.split('?')[0]
  if (webDistExists && req.method === 'GET' && ['/dashboard', '/research', '/brooks', '/movers', '/alerts', '/login', '/register'].includes(p)) {
    return reply.sendFile('index.html', path.resolve(WEB_DIST))
  }
  reply.code(404).send({ message: 'Not Found' })
})
// /admin* 显式 404 路由（GET 命中即 404；其余方法走上方回退的 /admin 分支 404）
app.get('/admin*', async () => {
  throw Object.assign(new Error('Not Found'), { statusCode: 404 })
})


// ---------------------------------------------------------------------------
// 登录鉴权：Cookie 会话；除白名单外的 /api/* 与 /ws 均要求已登录
// ---------------------------------------------------------------------------

// 登录 / 会话查询走白名单，其余 /api/* 一律拦截
app.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0]
  if (!url.startsWith('/api/')) return
  // W3-S3：管理 API 在 user-api 物理不存在——登录与否一律 404（不进鉴权，不暴露存在性）
  if (url === '/api/admin' || url.startsWith('/api/admin/')) {
    reply.code(404).send({ message: 'Not Found' })
    return
  }
  if (url === '/api/health' || url.startsWith('/api/auth/')) return
  try {
    await auth.requireLiveSession(req)
  } catch (err) {
    const e = err as { statusCode?: number }
    reply.code(e.statusCode ?? 401).send({ message: (err as Error).message })
  }
})

// HTTP 访问日志：每个 /api/* 请求一条（health 为探针高频调用，排除）；
// 写请求附带提交的 body（敏感字段打码、长文本截断）
app.addHook('onResponse', (req, reply, done) => {
  const url = req.url.split('?')[0]
  if (url.startsWith('/api/') && url !== '/api/health') {
    const status = reply.statusCode
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
    const user = findSession(readSessionToken(req.headers.cookie))?.username
    log[level]('http', `${req.method} ${req.url} → ${status}`, kv({
      耗时: fmtMs(reply.elapsedTime ?? 0),
      用户: user,
      ip: clientIp(req),
      客户端: briefUa(String(req.headers['user-agent'] ?? '')),
      提交数据: req.body !== undefined && !/^\/api\/(ai|research|conversations|translate)(?:\/|$)/.test(url) ? bodyForLog(req.body) : undefined,
    }))
  }
  done()
})

/**
 * 客户端真实 IP：取 XFF「最后一段」——隧道代理（ngrok/cloudflared/otun）把真实
 * 客户端 IP 追加在末尾，首段可被客户端伪造；按首段计数会被随机伪造 XFF 绕过限速。
 * 其次 x-real-ip（nginx 惯例）；直连时就是连接地址。
 */

// 地域封锁钩子：onRequest 阶段执行，早于鉴权与所有路由（与限速/审计同用 clientIp 口径）。
// W3-S3：ADMIN_HOSTS 域名门禁退役——admin 域名流量由 Caddy 直接反代到 admin-api 进程
// （3201），user-api 只承接主域名，不再需要按 Host 豁免地域封锁或 404 管理路径
// （管理路由物理不存在 + /admin* 显式 404）。
registerGeoBlock(app, clientIp)


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

/** 敏感字段（键名匹配即整值打码；webhookUrl 保留主机名便于排查） */
const SENSITIVE_KEY_RE = /password|passphrase|apikey|api_key|secret|token|authorization/i

/**
 * 请求体 → 可进日志的紧凑 JSON：
 * - password / apiKey / secret / token 等键打码为 ***
 * - webhookUrl 只保留主机名（与审计日志同策略）
 * - 字符串超 160 字截断（标注原始长度），整体超 500 字截断
 */
function bodyForLog(body: unknown): string {
  const sanitize = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      return value.length > 160 ? `${value.slice(0, 160)}…(共${value.length}字)` : value
    }
    if (Array.isArray(value)) {
      return depth < 3 ? value.slice(0, 10).map((v) => sanitize(v, depth + 1)) : '[…]'
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (/^webhookurl$/i.test(k) && typeof v === 'string' && v) {
          out[k] = `${webhookHost(v)}/***`
        } else if (SENSITIVE_KEY_RE.test(k)) {
          out[k] = v === undefined || v === '' ? v : '***'
        } else {
          out[k] = sanitize(v, depth + 1)
        }
      }
      return out
    }
    return value
  }
  const text =
    typeof body === 'object' && body !== null ? JSON.stringify(sanitize(body, 0)) : String(body)
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

// 登录/登出/会话查询（W3-S3 提取至共享模块 authRoutes.ts；user-api 恒用户入口：
// superadmin 在本进程登录被拒——管理认证只在 admin-api 进程，入口=进程）
const auth = registerAuthRoutes(app, { entryKind: 'user', clientIp })
const requireSession = auth.requireSession
// Global metering runs before model handlers, after live session validation.
registerAiAccessGuard(app, { requireSession })

app.get('/api/health', async () => ({
  ok: true,
  binanceStream: stream.connected,
  symbols: tickerCache.size,
  clients: clients.size,
  storage: storageMode(),
  blobStore: currentBlobStoreKind(),
  geoBlock: geoBlockStatus(),
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

// ---- AI 助手（OpenAI 兼容接口代理；API Key 只存服务端） ----
app.get('/api/ai/status', async () => ({ configured: isAiConfigured(), model: aiModelName() }))


// W3-S3：/api/admin/ai/* 六端点已物理迁入 admin-api（adminApi.ts）——user-api 不注册。

app.get('/api/ai/news', async () => ({ news: await getAiNews() }))


app.post('/api/ai/chat', async (req, reply) => {
  const session = requireSession(req) // 所有登录用户可用，配置仅超管
  // 用户级管控先行：被管理端禁用/超限的用户恒定收到 403 chat_disabled / 429 chat_limit_exceeded，
  // 不被「AI 未配置」或档案级配额错误掩盖（其余四个挂载点同为策略先行）
  await assertChatAllowed(session.username)
  const profile = resolveAiProfile(session.username)
  if (!profile) throw badRequest('AI 未配置，或当前用户没有可用的配置档案（请联系超级管理员）')
  // checkAiQuota 为档案级限额（每用户每日 LLM 对话数）；两者独立判定、任一超限即拒（取严）
  checkAiQuota(session.username, profile)
  const body = (req.body ?? {}) as { conversationId?: unknown; content?: unknown }
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) throw badRequest('消息内容不能为空')
  // 会话归属校验：带 id 必须存在且属于当前用户；不带则新建（首条消息时）
  const wanted = typeof body.conversationId === 'string' ? body.conversationId : ''
  const existing = wanted ? await getConversation(session.username, wanted) : null
  if (wanted && !existing) throw badRequest('会话不存在')
  const conv = existing ?? await createConversation(session.username)
  await appendConversationMessages(conv, [{ role: 'user', content }])
  const history = chatHistoryOf(conv)
  const memories = await memoriesPromptBlock(session.username)

  // 首个 delta 到达后再接管原生响应（hijack）：出错早于流启动时仍能返回标准 JSON 错误；
  // 新建的会话 id 通过响应头回传（前端据此续接会话）
  let started = false
  try {
    recordAiUsage(session.username)
    const full = await runToolLoop(profile, history, (delta) => {
      if (!started) {
        started = true
        reply.hijack()
        reply.raw.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache',
          'x-conversation-id': conv.id,
        })
      }
      reply.raw.write(delta)
    }, session.username, memories)
    // 用户级交互计数：成功完成才计（失败不计，与 recordAiUsage 含失败尝试的防刷口径不同）
    await recordChatMessage(session.username)
    if (started) {
      reply.raw.end()
      await appendConversationMessages(conv, [{ role: 'assistant', content: full }])
      // 记忆提取为后台任务：不阻塞响应、不占用户配额
      maybeExtractMemories(profile, session.username, conv)
      return
    }
    return { text: full }
  } catch (err) {
    const msg = (err as Error).message || 'AI 对话失败'
    if (started) reply.raw.end(`\n⚠ ${msg}`)
    else throw err
  }
})

/**
 * 斜杠命令：显式触发的本地能力（/chart /analyze /calc /remember 等），
 * 直接执行不调用大模型、不占档案级每日对话配额（recordAiUsage），
 * 但计入用户级每日交互上限（chatPolicy）；结果与图表同样落入会话历史。
 */
app.post('/api/ai/command', async (req) => {
  const session = requireSession(req)
  // 斜杠命令不调用大模型，但纳入用户级统一管控口径（防绕过禁用/上限）
  await assertChatAllowed(session.username)
  const body = (req.body ?? {}) as { conversationId?: unknown; text?: unknown }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text.startsWith('/')) throw badRequest('命令需以 / 开头')
  const wanted = typeof body.conversationId === 'string' ? body.conversationId : ''
  const existing = wanted ? await getConversation(session.username, wanted) : null
  if (wanted && !existing) throw badRequest('会话不存在')

  // 先执行命令再建/写会话：执行失败（参数错等）不留空会话
  const r = await runSlashCommand(session.username, text)
  const conv = existing ?? await createConversation(session.username)
  const replyWithChart = r.chart
    ? `\`\`\`chart\n${JSON.stringify(r.chart)}\n\`\`\`\n\n${r.reply}`
    : r.reply
  await appendConversationMessages(conv, [
    { role: 'user', content: text },
    { role: 'assistant', content: replyWithChart },
  ])
  recordChatMessage(session.username)
  log.info('ai', '斜杠命令', kv({ 用户: session.username, 命令: text.slice(0, 60) }))
  return { conversationId: conv.id, reply: r.reply, chart: r.chart ?? null }
})

// ---- AI 会话历史与长期记忆（用户级持久化，关闭页面/重启后仍在） ----

app.get('/api/ai/conversations', async (req) => {
  const session = requireSession(req)
  // listConversations 是 async（内部 ensureFresh）——漏 await 会把 Promise 序列化成 {}
  return { conversations: await listConversations(session.username) }
})

app.get('/api/ai/conversations/:id', async (req) => {
  const session = requireSession(req)
  const { id } = req.params as { id: string }
  const conv = await getConversation(session.username, id)
  if (!conv) throw badRequest('会话不存在')
  return {
    conversation: {
      id: conv.id,
      title: conv.title || '新对话',
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messages: conv.messages.map((m) => ({ role: m.role, content: m.content, at: m.at })),
    },
  }
})

app.delete('/api/ai/conversations/:id', async (req) => {
  const session = requireSession(req)
  const { id } = req.params as { id: string }
  if (!await deleteConversation(session.username, id)) throw badRequest('会话不存在')
  log.info('ai', '会话已删除', kv({ 用户: session.username, 会话: id }))
  return { ok: true }
})

app.get('/api/ai/memories', async (req) => {
  const session = requireSession(req)
  return { memories: listMemories(session.username) }
})

app.put('/api/ai/memories/:id', async (req) => {
  const session = requireSession(req)
  const { id } = req.params as { id: string }
  const content = String(((req.body ?? {}) as { content?: unknown }).content ?? '')
  return { memory: await updateMemory(session.username, id, content) }
})

app.delete('/api/ai/memories/:id', async (req) => {
  const session = requireSession(req)
  const { id } = req.params as { id: string }
  if (!await deleteMemory(session.username, id)) throw badRequest('记忆不存在')
  return { ok: true }
})

// 不带 id = 清空当前用户全部记忆
app.delete('/api/ai/memories', async (req) => {
  const session = requireSession(req)
  const n = await clearMemories(session.username)
  log.info('ai', '长期记忆已清空', kv({ 用户: session.username, 条数: n }))
  return { ok: true }
})

// ---- 管理端路由（admin 核心域/agents/evals/models）已整体迁入 admin-api 进程 ----

// ---- 行情数据基础（/api/market/*，只读；采集在 worker 进程，本进程仅入队） ----
registerMarketRoutes(app, { requireSession })

// W3-S3：知识库路由与 multipart 上传已物理迁入 admin-api；
// user-api 不注册任何 /api/admin/*（含 /api/admin/ai/*）——路由物理不存在，非门禁拦截。

// ---- 研究流程（/api/research/runs + SSE、/api/portfolio、/api/event-quotes、/api/predictions） ----
registerResearchRunRoutes(app, { requireSession })
registerProductRoutes(app, { requireSession })


// pg-boss 队列：app 侧只入队不消费；DB 不可用/启动失败仅告警，不阻断 app 启动
await startQueue()

// ---- 前端 WebSocket（升级请求携带会话 Cookie，未登录直接关闭） ----
app.get('/ws', { websocket: true }, (connection: SocketStream, req: FastifyRequest) => {
  // 地域封锁兜底：WS 升级请求未必都经过全局 onRequest 钩子（依赖插件版本行为），此处显式再判一次
  if (isRegionBlocked(clientIp(req))) {
    connection.socket.close(4003, 'region_blocked')
    return
  }
  // user-api 恒用户入口：只认 purpose='user' 会话（admin 会话在 admin-api 进程）
  const session = findSession(readSessionToken(req.headers.cookie), 'user')
  if (!session) {
    log.warn('ws', '未登录连接被拒', kv({ ip: clientIp(req), 客户端: briefUa(String(req.headers['user-agent'] ?? '')) }))
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
  const state: ClientState = {
    market: false,
    klines: new Set(),
    connectedAt: Date.now(),
    user: session.username,
    ip: clientIp(req),
    ua: briefUa(String(req.headers['user-agent'] ?? '')),
  }
  clients.set(ws, state)
  log.info('ws', '客户端连接', kv({
    id: cid,
    用户: state.user,
    ip: state.ip,
    客户端: state.ua,
    当前在线: `${clients.size} 个`,
  }))

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
        log.info('ws', '订阅 K 线', kv({
          客户端: cid,
          用户: state.user,
          交易对: symbol,
          周期: interval,
          订阅流: `${klineMeta.size} 个`,
        }))
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
    log.info('ws', '客户端断开', kv({
      id: ws.cid ?? '?',
      用户: state.user,
      在线时长: fmtMs(Date.now() - state.connectedAt),
      订阅K线: `${state.klines.size} 个`,
      剩余在线: `${clients.size} 个`,
    }))
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
  const meta = klineMeta.get(name)
  stream.unsubscribe(name)
  klineMeta.delete(name)
  log.info('ws', '退订 K 线（最后一个观察者离开）', kv({
    交易对: meta?.symbol ?? name,
    周期: meta?.interval,
    剩余订阅流: `${klineMeta.size} 个`,
  }))
}

// 前端连接心跳：30s 一次 ping，无 pong 则断开
setInterval(() => {
  for (const [ws, state] of clients) {
    if (ws.isAlive === false) {
      log.warn('ws', '客户端心跳超时，已断开', kv({
        id: ws.cid ?? '?',
        用户: state.user,
        在线时长: fmtMs(Date.now() - state.connectedAt),
      }))
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
    log.ok('server', `biance-vision api listening on http://${HOST}:${PORT}`, kv({
      存储: storageMode(),
      对象存储: currentBlobStoreKind(),
      Node: process.version,
      pid: process.pid,
    }))
  })
  .catch((err: Error) => {
    log.error('server', 'listen failed:', err)
    process.exit(1)
  })

process.on('unhandledRejection', (err) => {
  log.error('server', 'unhandled rejection:', err)
})
