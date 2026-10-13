/**
 * /api/predictions 预测记录与模型注册表契约。
 * 对应 docs/specs/prediction.md：概率唯一来自统计模块，模型未就绪/期限不匹配/
 * 数据过期时概率字段保持为空；特征向量、模型版本随记录冻结可复现。
 */

import { z } from 'zod'
import {
  DecimalStringSchema,
  MarketTypeSchema,
  ResearchHorizonSchema,
  SymbolSchema,
} from '../market.js'
import { IdSchema } from './common.js'

/** 创建预测：对冻结报价或指定期限桶发起；期限不匹配/模型未就绪返回 unavailable */
export const PredictionCreateSchema = z.object({
  quoteId: IdSchema.optional(),
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  horizon: ResearchHorizonSchema,
  strikePrice: DecimalStringSchema.optional(),
  expiryAt: z.number().int().optional(),
  asOf: z.number().int(),
})
export type PredictionCreate = z.infer<typeof PredictionCreateSchema>

/** 到期结果方向（tie 为平价退款分支） */
export const PredictionOutcomeSchema = z.enum(['above', 'below', 'tie'])
export type PredictionOutcome = z.infer<typeof PredictionOutcomeSchema>

export const PredictionSchema = z.object({
  id: IdSchema,
  quoteId: IdSchema.nullable(),
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  horizon: ResearchHorizonSchema,
  modelVersion: z.string().min(1),
  featureVersion: z.string().min(1),
  /** 上涨概率；唯一来自统计模块，不可用时为 null 而非编造 */
  probabilityUp: z.number().min(0).max(1).nullable(),
  /** 分位数输出：分位点（如 "0.1"）→ 预测值 */
  quantiles: z.record(z.string(), DecimalStringSchema),
  snapshotId: z.string().min(1),
  status: z.enum(['active', 'estimated', 'user_confirmed', 'expired_unavailable']),
  estimatedOutcome: PredictionOutcomeSchema.optional(),
  userConfirmedOutcome: PredictionOutcomeSchema.optional(),
  /** 两类结果分别统计，互不覆盖 */
  outcomeSource: z.enum(['estimated', 'user_confirmed']).nullable(),
  /** 概率不可用原因（模型未就绪/期限不匹配/数据过期/推理服务不可达） */
  unavailableReason: z.string().nullable().optional(),
  createdAt: z.number().int(),
  resolvedAt: z.number().int().optional(),
})
export type Prediction = z.infer<typeof PredictionSchema>

/** 模型注册表条目（/api/predictions/models） */
export const PredictionModelInfoSchema = z.object({
  modelVersion: z.string().min(1),
  horizon: ResearchHorizonSchema,
  /** 训练样本时间上界 */
  trainedUntil: z.number().int(),
  featureVersion: z.string().min(1),
  status: z.enum(['training', 'candidate', 'published', 'retired']),
  /** 校准指标摘要（分位覆盖/Brier/样本量等），样本不足或未评估为 null */
  metrics: z.record(z.string(), z.number()).nullable(),
})
export type PredictionModelInfo = z.infer<typeof PredictionModelInfoSchema>

/**
 * 预测命中率统计（GET /api/predictions/stats）：
 * estimated（研究估算）与 user_confirmed（用户确认）两轨分列，互不合并；
 * count=0 时 hitRate 为 null 而非 0。
 */
export const PredictionStatsTrackSchema = z.object({
  count: z.number().int().min(0),
  hits: z.number().int().min(0),
  hitRate: z.number().min(0).max(1).nullable(),
})
export type PredictionStatsTrack = z.infer<typeof PredictionStatsTrackSchema>

export const PredictionStatsSchema = z.object({
  estimated: PredictionStatsTrackSchema,
  userConfirmed: PredictionStatsTrackSchema,
})
export type PredictionStats = z.infer<typeof PredictionStatsSchema>
