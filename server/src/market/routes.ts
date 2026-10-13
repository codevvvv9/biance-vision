/**
 * /api/market/* 只读路由（docs/specs/market-data.md、api-storage.md）。
 * - 全部 requireSession；DB 不可用一律 503 { code: 'storage_unavailable' }（PG 唯一权威，无 JSON 镜像）
 * - 请求/响应用 shared（biance-vision-brooks）的 zod schema 校验，不穿透到交易所 REST
 * - K 线只从 market_candles 读；asOf 提供时只返回当时已收盘数据
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  GetCandlesQuerySchema,
  GetCandlesResponseSchema,
  GetFundingQuerySchema,
  GetFundingResponseSchema,
  GetOpenInterestQuerySchema,
  GetOpenInterestResponseSchema,
  GetQualityResponseSchema,
  GetSnapshotQuerySchema,
  GetSnapshotResponseSchema,
  IntervalSchema,
  MarketSymbolsQuerySchema,
  MarketSymbolsResponseSchema,
  MarketTypeSchema,
  SymbolSchema,
} from 'biance-vision-brooks'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'
import { listFunding } from './funding.js'
import { listOpenInterest } from './oi.js'
import { getProvider } from './providers/registry.js'
import { getQuality } from './quality.js'
import { listCollectedSymbols, readCandles } from './read.js'
import { createSnapshot } from './snapshot.js'

interface MarketRouteDeps {
  requireSession: (req: FastifyRequest) => unknown
}

/** shared 暂无 quality 查询 schema，用共享零件本地拼装（interval 可省略 = 全部采集周期） */
const GetQualityQuerySchema = z.object({
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  interval: IntervalSchema.optional(),
})

function ensureStorage(reply: FastifyReply): boolean {
  if (!getDb()) {
    reply.code(503).send({ code: 'storage_unavailable', message: 'PostgreSQL 不可用，行情数据暂不可读' })
    return false
  }
  return true
}

function parseQuery<S extends z.ZodTypeAny>(schema: S, query: unknown, reply: FastifyReply): z.infer<S> | null {
  const r = schema.safeParse(query)
  if (!r.success) {
    reply.code(400).send({
      code: 'bad_request',
      message: r.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('；'),
    })
    return null
  }
  return r.data as z.infer<S>
}

export function registerMarketRoutes(app: FastifyInstance, deps: MarketRouteDeps): void {
  app.get('/api/market/symbols', async (req, reply) => {
    deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const q = parseQuery(MarketSymbolsQuerySchema, req.query, reply)
    if (!q) return reply
    // 已采集（库内）∪ provider 可交易列表
    const [collected, available] = await Promise.all([
      listCollectedSymbols(q.marketType),
      getProvider(q.marketType)
        .listSymbols()
        .catch((err) => {
          log.warn('market', 'provider 交易对列表获取失败，仅返回已采集', kv({ 市场: q.marketType, 错误: (err as Error).message }))
          return [] as string[]
        }),
    ])
    return MarketSymbolsResponseSchema.parse({ symbols: [...new Set([...collected, ...available])].sort() })
  })

  app.get('/api/market/candles', async (req, reply) => {
    deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const q = parseQuery(GetCandlesQuerySchema, req.query, reply)
    if (!q) return reply
    const candles = await readCandles(q)
    return GetCandlesResponseSchema.parse({ candles })
  })

  app.get('/api/market/snapshot', async (req, reply) => {
    deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    // asOf 缺省 = now（shared schema 必填，此处预填后走同一校验）
    const raw = { ...(req.query as Record<string, unknown>) }
    if (raw.asOf === undefined || raw.asOf === '') raw.asOf = Date.now()
    const q = parseQuery(GetSnapshotQuerySchema, raw, reply)
    if (!q) return reply
    const snapshot = await createSnapshot({ symbol: q.symbol, marketType: q.marketType, asOf: q.asOf })
    return GetSnapshotResponseSchema.parse({ snapshot })
  })

  app.get('/api/market/funding', async (req, reply) => {
    deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const q = parseQuery(GetFundingQuerySchema, req.query, reply)
    if (!q) return reply
    const funding = await listFunding(q.symbol, q.limit)
    return GetFundingResponseSchema.parse({ funding })
  })

  app.get('/api/market/open-interest', async (req, reply) => {
    deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const q = parseQuery(GetOpenInterestQuerySchema, req.query, reply)
    if (!q) return reply
    const openInterest = await listOpenInterest(q.symbol, q.interval, q.limit)
    return GetOpenInterestResponseSchema.parse({ openInterest })
  })

  app.get('/api/market/quality', async (req, reply) => {
    deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const q = parseQuery(GetQualityQuerySchema, req.query, reply)
    if (!q) return reply
    const items = await getQuality({ symbol: q.symbol, marketType: q.marketType, interval: q.interval })
    return GetQualityResponseSchema.parse({ items })
  })
}
