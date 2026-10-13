/**
 * 用户侧研究产品路由：
 * - /api/portfolio：手动持仓 CRUD（写操作即一次用户确认；isStale 服务端派生）
 * - /api/event-quotes：手动报价 CRUD（asOf 冻结）+ GET 列表附带代码计算的 EV 评估
 * - /api/predictions：预测创建（模型注册表门控 → research-py 推理）、列表、到期用户确认、模型注册表
 * 对应 docs/specs/perpetual.md、event-contracts.md、prediction.md：
 * 数值全部来自代码计算；概率唯一来自统计模块，未就绪/期限不匹配/数据过期 → unavailable + 原因。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  EventQuoteInputSchema,
  EventQuoteSchema,
  PredictionCreateSchema,
  PredictionModelInfoSchema,
  PredictionSchema,
  PositionInputSchema,
  PositionSchema,
} from 'biance-vision-brooks'
import type { EventQuote, Position, Prediction, PredictionModelInfo } from 'biance-vision-brooks'
import { recordAudit } from '../audit.js'
import type { SessionRecord } from '../users.js'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'
import { eventQuotes, portfolioPositions, predictionModels, predictions } from '../models.js'
import type { EventQuoteRow, PortfolioPositionRow, PredictionRow, PredictionModelRow } from '../models.js'
import { evaluateEvent, matchHorizon, EVENT_HORIZON_BUCKETS } from './event/calc.js'
import { readCandles } from '../market/read.js'
import { createSnapshot } from '../market/snapshot.js'
import { predict, ResearchPyError } from '../researchpy.js'
import { predictForTarget, summarizePredictionStats } from '../services/prediction.js'
import { featureVersionFor, baseIntervalFor } from './features.js'

interface ProductRouteDeps {
  requireSession: (req: FastifyRequest) => SessionRecord
}

function ensureStorage(reply: FastifyReply): boolean {
  if (!getDb()) {
    reply.code(503).send({ code: 'storage_unavailable', message: 'PostgreSQL 不可用' })
    return false
  }
  return true
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: 'bad_request', message })
}

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): z.infer<S> | null {
  const r = schema.safeParse(body)
  if (!r.success) {
    badRequest(reply, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('；'))
    return null
  }
  return r.data as z.infer<S>
}

// ---- 行 → 契约对象 ----

export function toPositionDto(row: PortfolioPositionRow): Position {
  return PositionSchema.parse({
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    qty: row.qty,
    entryPrice: row.entryPrice,
    leverage: row.leverage,
    marginMode: row.marginMode,
    riskBudget: row.riskBudget,
    stopPrice: row.stopPrice ?? undefined,
    liquidationPrice: row.liquidationPrice === null ? null : row.liquidationPrice,
    confirmedAt: row.confirmedAt,
    staleAfterHours: row.staleAfterHours,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    isStale: Date.now() - row.confirmedAt > row.staleAfterHours * 3600_000,
  })
}

function toQuoteDto(row: EventQuoteRow): EventQuote {
  return EventQuoteSchema.parse({
    id: row.id,
    symbol: row.symbol,
    strikePrice: row.strikePrice,
    expiryAt: row.expiryAt,
    asOf: row.asOf,
    stake: row.stake,
    totalPayout: row.totalPayout,
    direction: row.direction,
    refPrice: row.refPrice === null ? null : row.refPrice,
    note: row.note ?? undefined,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    remainingMs: Math.max(0, row.expiryAt - Date.now()),
    estimatedOutcome: (row.estimatedOutcome as EventQuote['estimatedOutcome']) ?? null,
    userConfirmedOutcome: (row.userConfirmedOutcome as EventQuote['userConfirmedOutcome']) ?? null,
  })
}

function toPredictionDto(row: PredictionRow): Prediction {
  return PredictionSchema.parse({
    id: row.id,
    quoteId: row.quoteId,
    symbol: row.symbol,
    marketType: row.marketType,
    horizon: row.horizon as Prediction["horizon"],
    modelVersion: row.modelVersion,
    featureVersion: row.featureVersion,
    probabilityUp: row.probabilityUp,
    quantiles: row.quantiles,
    snapshotId: row.snapshotId,
    status: row.status as Prediction['status'],
    estimatedOutcome: (row.estimatedOutcome as Prediction['estimatedOutcome']) ?? undefined,
    userConfirmedOutcome: (row.userConfirmedOutcome as Prediction['userConfirmedOutcome']) ?? undefined,
    outcomeSource: (row.outcomeSource as Prediction['outcomeSource']) ?? null,
    unavailableReason: row.unavailableReason,
    createdAt: row.createdAt.getTime(),
    resolvedAt: row.resolvedAt ?? undefined,
  })
}

export function toModelInfo(row: PredictionModelRow): PredictionModelInfo {
  // 契约对齐（P1 修复）：status 枚举由 PredictionModelInfoSchema 运行时校验，
  // 不再用 as 强转掩盖模型注册表与契约的状态机漂移
  return PredictionModelInfoSchema.parse({
    modelVersion: row.modelVersion,
    horizon: row.horizon,
    trainedUntil: row.trainedUntil,
    featureVersion: row.featureVersion,
    status: row.status,
    metrics: row.metrics ?? null,
  })
}

// ---- 特征构建：共享模块（基础周期随期限伸缩；见 research/features.ts） ----

// ---- /api/portfolio ----

function registerPortfolioRoutes(app: FastifyInstance, deps: ProductRouteDeps): void {
  app.get('/api/portfolio', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const rows = await getDb()!
      .select()
      .from(portfolioPositions)
      .where(eq(portfolioPositions.userId, session.username))
      .orderBy(desc(portfolioPositions.createdAt))
    return { positions: rows.map(toPositionDto) }
  })

  app.post('/api/portfolio', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const body = parseBody(PositionInputSchema, req.body, reply)
    if (!body) return reply
    const rows = await getDb()!
      .insert(portfolioPositions)
      .values({
        userId: session.username,
        symbol: body.symbol,
        side: body.side,
        qty: body.qty,
        entryPrice: body.entryPrice,
        leverage: body.leverage,
        marginMode: body.marginMode,
        riskBudget: body.riskBudget,
        stopPrice: body.stopPrice ?? null,
        liquidationPrice: body.liquidationPrice ?? null,
        confirmedAt: body.confirmedAt,
        staleAfterHours: body.staleAfterHours,
      })
      .returning()
    return reply.code(201).send({ position: toPositionDto(rows[0]) })
  })

  app.put('/api/portfolio/:id', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const body = parseBody(PositionInputSchema, req.body, reply)
    if (!body) return reply
    const rows = await getDb()!
      .update(portfolioPositions)
      .set({
        symbol: body.symbol,
        side: body.side,
        qty: body.qty,
        entryPrice: body.entryPrice,
        leverage: body.leverage,
        marginMode: body.marginMode,
        riskBudget: body.riskBudget,
        stopPrice: body.stopPrice ?? null,
        liquidationPrice: body.liquidationPrice ?? null,
        confirmedAt: body.confirmedAt,
        staleAfterHours: body.staleAfterHours,
        updatedAt: new Date(),
      })
      .where(and(eq(portfolioPositions.id, id), eq(portfolioPositions.userId, session.username)))
      .returning()
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '持仓不存在' })
    return { position: toPositionDto(rows[0]) }
  })

  app.delete('/api/portfolio/:id', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const rows = await getDb()!
      .delete(portfolioPositions)
      .where(and(eq(portfolioPositions.id, id), eq(portfolioPositions.userId, session.username)))
      .returning()
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '持仓不存在' })
    return { ok: true }
  })
}

// ---- /api/event-quotes ----

function registerEventQuoteRoutes(app: FastifyInstance, deps: ProductRouteDeps): void {
  app.get('/api/event-quotes', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const rows = await getDb()!
      .select()
      .from(eventQuotes)
      .where(eq(eventQuotes.userId, session.username))
      .orderBy(desc(eventQuotes.createdAt))
    // EV 评估：概率未接入前 pWin=null，可算字段照常返回（breakeven/win/lose）
    const quotes = rows.map(toQuoteDto)
    const evaluations = quotes.map((q) => {
      const evalNums = evaluateEvent(
        {
          stake: Number(q.stake),
          totalPayout: Number(q.totalPayout),
          direction: q.direction,
          tieRefund: false,
        },
        null,
      )
      const hm = matchHorizon(q.remainingMs, EVENT_HORIZON_BUCKETS)
      return {
        quoteId: q.id,
        breakevenWinRate: evalNums.breakevenWinRate,
        expectedNet: evalNums.expectedNet === null ? null : String(evalNums.expectedNet),
        winAmount: String(evalNums.winAmount),
        loseAmount: String(evalNums.loseAmount),
        hasTieRefund: evalNums.hasTieRefund,
        countdownMs: q.remainingMs,
        horizonMatched: hm.matched,
        unavailableReason: hm.matched ? evalNums.unavailableReason : hm.reason,
      }
    })
    return { quotes, evaluations }
  })

  app.post('/api/event-quotes', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const body = parseBody(EventQuoteInputSchema, req.body, reply)
    if (!body) return reply
    if (body.expiryAt <= body.asOf) return badRequest(reply, 'expiryAt 必须晚于 asOf')
    // 期限语义校验（P1 修复）：submitted 订单到期时刻已锁定，必须使用 exact 且仍未到期；
    // duration 模式必须落入已验证期限桶（容差内），horizon 提供时必须与匹配桶一致
    if (body.orderState === 'submitted') {
      if (body.expiryKind !== 'exact') {
        return badRequest(reply, '已提交订单必须使用精确到期时刻（expiryKind=exact），不接受时长估算')
      }
      if (body.expiryAt <= Date.now()) {
        return badRequest(reply, '已提交订单的到期时刻必须晚于当前时间（请核对 App 展示的到期时间）')
      }
    }
    if (body.expiryKind === 'duration') {
      const hm = matchHorizon(body.expiryAt - body.asOf, EVENT_HORIZON_BUCKETS)
      if (!hm.matched) {
        return badRequest(reply, `录入时长未落入已验证期限桶：${hm.reason}（请核对 App 期限或使用 expiryKind=exact）`)
      }
      if (body.horizon !== undefined && hm.horizon !== body.horizon) {
        return badRequest(reply, `录入时长匹配 ${hm.horizon} 桶，与声明期限 ${body.horizon} 不一致（请核对 App 期限）`)
      }
    }
    const now2 = Date.now()
    const rows = await getDb()!
      .insert(eventQuotes)
      .values({
        userId: session.username,
        symbol: body.symbol,
        strikePrice: body.strikePrice,
        expiryAt: body.expiryAt,
        asOf: body.asOf,
        stake: body.stake,
        totalPayout: body.totalPayout,
        direction: body.direction,
        refPrice: body.refPrice === null ? null : body.refPrice,
        note: body.note ?? null,
        orderState: body.orderState,
        strikeStatus: body.strikeStatus,
        previewAsOf: body.orderState === 'preview' ? now2 : null,
        eventRiskBudget: body.eventRiskBudget ?? null,
      })
      .returning()
    return reply.code(201).send({ quote: toQuoteDto(rows[0]) })
  })

  app.put('/api/event-quotes/:id', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const body = parseBody(EventQuoteInputSchema, req.body, reply)
    if (!body) return reply
    if (body.expiryAt <= body.asOf) return badRequest(reply, 'expiryAt 必须晚于 asOf')
    const now2 = Date.now()
    // 关键字段（strike/stake/payout/expiry）不允许静默修改：更正 = 作废重建
    const rows = await getDb()!
      .update(eventQuotes)
      .set({ note: body.note ?? null, updatedAt: new Date() })
      .where(and(eq(eventQuotes.id, id), eq(eventQuotes.userId, session.username)))
      .returning()
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '报价不存在' })
    if (
      rows[0].strikePrice !== body.strikePrice ||
      rows[0].stake !== body.stake ||
      rows[0].totalPayout !== body.totalPayout ||
      rows[0].expiryAt !== body.expiryAt
    ) {
      return badRequest(reply, '执行价/投入/总返还/到期时间不可修改（报价 asOf 冻结）；如需更正请删除后重新录入')
    }
    return { quote: toQuoteDto(rows[0]) }
  })

  app.delete('/api/event-quotes/:id', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const rows = await getDb()!
      .delete(eventQuotes)
      .where(and(eq(eventQuotes.id, id), eq(eventQuotes.userId, session.username)))
      .returning()
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '报价不存在' })
    return { ok: true }
  })

  /**
   * 报价级用户确认（P1 修复）：语义与预测级 /api/predictions/:id/confirm 一致，
   * 写 quote.userConfirmedOutcome；同时把该报价下尚未确认过的预测一并标记为 user_confirmed
   * （已有用户确认的预测不覆盖）。estimated 轨道不受影响，两轨互不覆盖。
   */
  app.post('/api/event-quotes/:id/confirm', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const body = parseBody(z.object({ outcome: z.enum(['above', 'below', 'tie']) }), req.body, reply)
    if (!body) return reply
    const rows = await getDb()!
      .update(eventQuotes)
      .set({ userConfirmedOutcome: body.outcome, updatedAt: new Date() })
      .where(and(eq(eventQuotes.id, id), eq(eventQuotes.userId, session.username)))
      .returning()
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '报价不存在' })
    const synced = await getDb()!
      .update(predictions)
      .set({ userConfirmedOutcome: body.outcome, outcomeSource: 'user_confirmed', status: 'user_confirmed', resolvedAt: Date.now() })
      .where(and(eq(predictions.quoteId, id), eq(predictions.userId, session.username), isNull(predictions.userConfirmedOutcome)))
      .returning({ id: predictions.id })
    recordAudit(session, {
      action: 'prediction_confirm',
      target: id,
      detail: `报价级结果确认：${body.outcome}（user_confirmed；同步未确认预测 ${synced.length} 条）`,
    })
    return { quote: toQuoteDto(rows[0]), syncedPredictions: synced.length }
  })
}

// ---- /api/predictions ----

function registerPredictionRoutes(app: FastifyInstance, deps: ProductRouteDeps): void {
  app.get('/api/predictions/models', async (req, reply) => {
    deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const rows = await getDb()!.select().from(predictionModels).orderBy(desc(predictionModels.updatedAt))
    return { models: rows.map(toModelInfo) }
  })

  app.get('/api/predictions/stats', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const rows = await getDb()!
      .select({
        probabilityUp: predictions.probabilityUp,
        estimatedOutcome: predictions.estimatedOutcome,
        userConfirmedOutcome: predictions.userConfirmedOutcome,
      })
      .from(predictions)
      .where(eq(predictions.userId, session.username))
    // estimated（研究估算）与 user_confirmed（用户确认）两轨分列，互不合并
    const stats = summarizePredictionStats(
      rows.map((r) => ({
        probabilityUp: r.probabilityUp,
        estimatedOutcome: (r.estimatedOutcome as 'above' | 'below' | 'tie' | null) ?? null,
        userConfirmedOutcome: (r.userConfirmedOutcome as 'above' | 'below' | 'tie' | null) ?? null,
      })),
    )
    return { stats }
  })

  app.get('/api/predictions', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const quoteId = (req.query as { quoteId?: string }).quoteId
    const base = getDb()!.select().from(predictions)
    const rows = quoteId
      ? await base.where(and(eq(predictions.userId, session.username), eq(predictions.quoteId, quoteId))).orderBy(desc(predictions.createdAt))
      : await base.where(eq(predictions.userId, session.username)).orderBy(desc(predictions.createdAt))
    return { predictions: rows.map(toPredictionDto) }
  })

  app.post('/api/predictions', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const body = parseBody(PredictionCreateSchema, req.body, reply)
    if (!body) return reply

    // 报价冻结检查：quoteId 提供时必须存在且属于当前用户
    let quote: EventQuoteRow | null = null
    if (body.quoteId) {
      const rows = await getDb()!
        .select()
        .from(eventQuotes)
        .where(and(eq(eventQuotes.id, body.quoteId), eq(eventQuotes.userId, session.username)))
        .limit(1)
      if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '报价不存在' })
      quote = rows[0]
    }

    const save = async (patch: {
      probabilityUp: number | null
      quantiles: Record<string, string>
      modelVersion: string
      status: Prediction['status']
      unavailableReason: string | null
      features: Record<string, number>
      snapshotId: string
    }): Promise<Prediction> => {
      const rows = await getDb()!
        .insert(predictions)
        .values({
          userId: session.username,
          quoteId: quote?.id ?? null,
          symbol: body.symbol,
          marketType: body.marketType,
          horizon: body.horizon,
          modelVersion: patch.modelVersion,
          featureVersion: featureVersionFor(body.horizon, targetType),
          probabilityUp: patch.probabilityUp,
          quantiles: patch.quantiles,
          snapshotId: patch.snapshotId,
          status: patch.status,
          unavailableReason: patch.unavailableReason,
          features: patch.features,
        })
        .returning()
      return toPredictionDto(rows[0])
    }

    const snapshot = await createSnapshot({ symbol: body.symbol, marketType: body.marketType, asOf: body.asOf })

    // 期限门控：quoteId 提供时剩余期限必须落入容差内的桶；1w 桶为研究模式
    if (quote) {
      const remaining = quote.expiryAt - body.asOf
      const hm = matchHorizon(remaining, EVENT_HORIZON_BUCKETS)
      if (!hm.matched) {
        const p = await save({
          probabilityUp: null,
          quantiles: {},
          modelVersion: 'none',
          status: 'expired_unavailable',
          unavailableReason: hm.reason,
          features: {},
          snapshotId: snapshot.snapshotId,
        })
        return reply.code(200).send({ prediction: p, unavailableReason: hm.reason })
      }
      if (hm.horizon !== body.horizon) {
        const reason = `报价剩余期限匹配 ${hm.horizon} 桶，与请求期限 ${body.horizon} 不一致（不得跨期限复用预测）`
        const p = await save({
          probabilityUp: null,
          quantiles: {},
          modelVersion: 'none',
          status: 'expired_unavailable',
          unavailableReason: reason,
          features: {},
          snapshotId: snapshot.snapshotId,
        })
        return reply.code(200).send({ prediction: p, unavailableReason: reason })
      }
    }

    // 特征构建（含数据充足性检查；基础周期随期限伸缩，与训练同源）
    // 统一预测链路（P1 修复）：与流水线共用 PredictionService——
    // published 状态 / symbol 门控 / 执行价对数阈值 / 尾部不截断 / 剩余期限验证范围 /
    // 基础周期（featureVersion 编码，1d/1w 在 1h 上取数，不是 1m）。
    const isEvent = quote !== null || body.strikePrice !== undefined
    const targetType = isEvent ? 'strike_relative' as const : 'return_positive' as const
    const priceType = targetType === 'strike_relative' ? 'index' : 'trade'
    const candles = await readCandles({
      marketType: body.marketType,
      priceType,
      symbol: body.symbol,
      interval: baseIntervalFor(body.horizon),
      to: body.asOf,
      asOf: body.asOf,
      limit: 300,
    })
    const closes = candles.map((c) => Number(c.close))
    const remainingSec = quote !== null ? Math.round(Math.max(0, quote.expiryAt - body.asOf) / 1000) : undefined
    const outcome = await predictForTarget({
      symbol: body.symbol,
      marketType: body.marketType,
      horizon: body.horizon,
      asOf: body.asOf,
      targetType,
      strikePrice: quote !== null ? Number(quote.strikePrice) : body.strikePrice !== undefined ? Number(body.strikePrice) : undefined,
      indexRefPrice: closes.length > 0 ? closes[closes.length - 1] : undefined,
      remainingSeconds: remainingSec,
      closes,
    })
    if (!outcome.available) {
      const p = await save({
        probabilityUp: null,
        quantiles: {},
        modelVersion: 'none',
        status: 'expired_unavailable',
        unavailableReason: `${outcome.code}: ${outcome.detail}`,
        features: {},
        snapshotId: snapshot.snapshotId,
      })
      return reply.code(200).send({ prediction: p, unavailableReason: `${outcome.code}: ${outcome.detail}` })
    }
    const p = await save({
      probabilityUp: outcome.probabilityUp,
      quantiles: Object.fromEntries(Object.entries(outcome.quantiles).map(([k, v]) => [k, String(v)])),
      modelVersion: outcome.modelVersion,
      status: 'active',
      unavailableReason: null,
      features: outcome.features,
      snapshotId: snapshot.snapshotId,
    })
    log.ok('research', '预测生成', kv({ 模型: outcome.modelVersion, 目标: targetType, pUp: outcome.probabilityUp.toFixed(4) }))
    return reply.code(201).send({ prediction: p })
  })

  /** 到期后用户确认真实订单结算（outcomeSource=user_confirmed，与研究估算互不覆盖） */
  app.post('/api/predictions/:id/confirm', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const body = parseBody(z.object({ outcome: z.enum(['above', 'below', 'tie']) }), req.body, reply)
    if (!body) return reply
    const rows = await getDb()!
      .update(predictions)
      .set({ userConfirmedOutcome: body.outcome, outcomeSource: 'user_confirmed', status: 'user_confirmed', resolvedAt: Date.now() })
      .where(and(eq(predictions.id, id), eq(predictions.userId, session.username)))
      .returning()
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '预测不存在' })
    recordAudit(session, {
      action: 'prediction_confirm',
      target: id,
      detail: `预测结果确认：${body.outcome}（user_confirmed）`,
    })
    return { prediction: toPredictionDto(rows[0]) }
  })
}

export function registerProductRoutes(app: FastifyInstance, deps: ProductRouteDeps): void {
  registerPortfolioRoutes(app, deps)
  registerEventQuoteRoutes(app, deps)
  registerPredictionRoutes(app, deps)
}
