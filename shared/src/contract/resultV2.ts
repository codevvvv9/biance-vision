/**
 * 研究结果契约 v2（P2，improvement-plan §4.2）：
 * schemaVersion=2，产品负载为严格判别联合（替代任意 record）；
 * 不可用原因使用稳定代码；概率附带模型溯源；LLM 只产结构与解释，不新增数值。
 */

import { z } from 'zod'
import { MarketTypeSchema, ResearchHorizonSchema, SymbolSchema } from '../market.js'
import { IdSchema } from './common.js'
import { ResearchClaimSchema, ResearchScenarioSchema } from './research.js'

/** 稳定不可用代码（前端/报告按码呈现，不解析自然语言） */
export const UnavailableCodeSchema = z.enum([
  'stale_market',
  'stale_reference_price',
  'window_gap',
  'insufficient_history',
  'missing_quote',
  'preview_expired',
  'tie_precision_unknown',
  'ev_not_positive',
  'stake_over_budget',
  'model_not_published',
  'horizon_unvalidated',
  'remaining_out_of_range',
  'target_mismatch',
  'tail_unvalidated',
  'feature_missing',
  'inference_failed',
  'unvalidated_horizon',
  'search_unconfigured',
])
export type UnavailableCode = z.infer<typeof UnavailableCodeSchema>

/** 概率块 v2：完整溯源（唯一来自统计模块） */
export const ProbabilityBlockV2Schema = z.object({
  predictionId: IdSchema.nullable(),
  modelVersion: z.string(),
  targetType: z.enum(['strike_relative', 'return_positive']),
  /** 概率的参考价类型（index=事件结算参考 / trade=方向研究） */
  referenceType: z.enum(['index', 'trade']),
  probabilityUp: z.number().min(0).max(1),
  probabilityTie: z.number().min(0).max(1).nullable(),
  calibrationId: z.string(),
})
export type ProbabilityBlockV2 = z.infer<typeof ProbabilityBlockV2Schema>

/** 永续负载 v2 */
export const PerpPayloadV2Schema = z.object({
  kind: z.literal('perp'),
  position: z
    .object({
      side: z.enum(['long', 'short']),
      qty: z.string(),
      entryPrice: z.string(),
      leverage: z.number().int(),
      marginMode: z.enum(['cross', 'isolated']),
      stopPrice: z.string().nullable(),
      liquidationPrice: z.string().nullable(),
      isStale: z.boolean(),
    })
    .nullable(),
  marginUsed: z.number().nullable(),
  pnlPoints: z.array(z.object({ price: z.number(), tradeNetPnl: z.number(), incrementalPnl: z.number(), roe: z.number() })),
  fundingScenarios: z.array(z.object({ label: z.string(), ratePer8h: z.number(), cost24h: z.number(), source: z.string() })),
  fundingNote: z.string(),
  /** 资金费率数据过期（funding_stale）：情景为空且 fundingNote 注明原因 */
  fundingStale: z.boolean().optional(),
  riskCap: z.object({
    ok: z.boolean(),
    maxQty: z.number().nullable(),
    reason: z.string().nullable(),
    /** 实际触发的仓位上限约束（risk_budget/portfolio_exposure/step_rounding/min_notional） */
    bindingConstraint: z.string().nullable().optional(),
  }),
  reducePlan: z.object({ needed: z.boolean(), keepQty: z.number().nullable(), reduceQty: z.number().nullable(), reason: z.string() }),
  liquidation: z.object({ price: z.number().nullable(), note: z.string() }),
  /** 各腿费率档说明（入场/平仓各自 maker/taker 与滑点；随配置版本冻结） */
  feeLegs: z
    .object({ entryStyle: z.enum(['market', 'limit']), exitStyle: z.enum(['market', 'limit']), entryRate: z.number(), exitRate: z.number(), note: z.string() })
    .nullable()
    .optional(),
  incremental: z.object({ toStopPnl: z.number(), toStopPct: z.number() }).nullable(),
})
export type PerpPayloadV2 = z.infer<typeof PerpPayloadV2Schema>

/** 事件负载 v2 */
export const EventPayloadV2Schema = z.object({
  kind: z.literal('event'),
  quote: z
    .object({
      orderState: z.enum(['preview', 'submitted']),
      strikeStatus: z.enum(['preview', 'locked']),
      strikePrice: z.string(),
      expiryAt: z.number().int(),
      stake: z.string(),
      totalPayout: z.string(),
      direction: z.enum(['above', 'below']),
      previewExpired: z.boolean(),
      remainingMs: z.number().int(),
    })
    .nullable(),
  pWin: z.number().nullable(),
  pTie: z.number().nullable(),
  expectedNet: z.number().nullable(),
  breakevenWinRate: z.number(),
  breakevenLabel: z.string(),
  winAmount: z.number(),
  loseAmount: z.number(),
  unavailableCode: UnavailableCodeSchema.nullable(),
  unavailableDetail: z.string().nullable(),
})
export type EventPayloadV2 = z.infer<typeof EventPayloadV2Schema>

/** 方向研究负载 v2（1w 等研究期限；分布与研究模式标识，不给参与动作） */
export const DirectionPayloadV2Schema = z.object({
  kind: z.literal('direction'),
  horizon: ResearchHorizonSchema,
  researchMode: z.literal(true),
  quantiles: z.record(z.string(), z.number()).nullable(),
  /** P(周对数收益>0)，唯一来自统计模块；不可用时为 null */
  probabilityUp: z.number().min(0).max(1).nullable().optional(),
  modelVersion: z.string().optional(),
  unavailableCode: UnavailableCodeSchema.nullable(),
  unavailableDetail: z.string().nullable().optional(),
})
export type DirectionPayloadV2 = z.infer<typeof DirectionPayloadV2Schema>

/** 教学负载 v2 */
export const TeachingPayloadV2Schema = z.object({
  kind: z.literal('teaching'),
  citations: z.array(z.object({ evidenceId: IdSchema, docTitle: z.string(), pageNo: z.number().int().nullable() })),
})
export type TeachingPayloadV2 = z.infer<typeof TeachingPayloadV2Schema>

/** v2 产品负载（判别联合） */
export type ProductPayloadV2 = z.infer<typeof ProductPayloadV2Schema>

export const ProductPayloadV2Schema = z.discriminatedUnion('kind', [
  PerpPayloadV2Schema,
  EventPayloadV2Schema,
  DirectionPayloadV2Schema,
  TeachingPayloadV2Schema,
])


export const ResearchResultV2Schema = z.object({
  schemaVersion: z.literal(2),
  decision: z.enum([
    'wait',
    'hold',
    'conditional_entry',
    'reduce',
    'exit',
    'request_reconfirm',
    'insufficient_evidence',
    'monitor',
    'await_settlement',
    'settled',
  ]),
  side: z.enum(['long', 'short']).nullable(),
  reasons: z.array(z.string()),
  conditions: z.array(z.string()),
  claims: z.array(ResearchClaimSchema),
  scenarios: z.array(ResearchScenarioSchema),
  evidenceQuality: z.enum(['complete', 'partial', 'stale']),
  probability: ProbabilityBlockV2Schema.nullable(),
  unavailableCode: UnavailableCodeSchema.nullable(),
  missingInputs: z.array(z.string()),
  payload: ProductPayloadV2Schema,
})
export type ResearchResultV2 = z.infer<typeof ResearchResultV2Schema>

/** 会话契约（P2 §4.1） */
export const ConversationContextSchema = z.object({
  product: z.enum(['perp', 'event', 'teaching', 'direction']).optional(),
  symbol: SymbolSchema.optional(),
  marketType: MarketTypeSchema.optional(),
  horizon: ResearchHorizonSchema.optional(),
  positionId: IdSchema.nullable().optional(),
  quoteId: IdSchema.nullable().optional(),
  source: z.string().optional(),
})
export type ConversationContext = z.infer<typeof ConversationContextSchema>

export const ConversationMessageSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  intent: z.enum(['concept', 'structure', 'perp', 'event', 'replay', 'news', 'system']).nullable(),
  runId: IdSchema.nullable(),
  card: z
    .object({
      kind: z.enum(['confirm_position', 'completion']),
      /** 待确认的持仓草稿（确认后 PATCH context → 落 portfolio） */
      draft: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable(),
  createdAt: z.number().int(),
})
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>
