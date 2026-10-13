/**
 * /api/research/* 研究运行契约与 SSE 进度事件。
 * 对应 docs/specs/agent-orchestration.md、perpetual.md、event-contracts.md：
 * 固定流水线状态机，最终结论经 validate 通过后才发布；数值可溯源。
 */

import { z } from 'zod'
import { MarketTypeSchema, ResearchHorizonSchema, SymbolSchema } from '../market.js'
import { IdSchema } from './common.js'

export const ResearchProductSchema = z.enum(['perp', 'event', 'teaching'])
export type ResearchProduct = z.infer<typeof ResearchProductSchema>

/** POST /api/research/runs 创建输入；asOf 缺省时由服务端取当前时间 */
export const ResearchRunCreateSchema = z.object({
  product: ResearchProductSchema,
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  horizon: ResearchHorizonSchema,
  question: z.string().max(2000).optional(),
  positionId: IdSchema.optional(),
  quoteId: IdSchema.optional(),
  /** 假设覆盖（「改成 20 倍」）：只影响本次研究，不写回已确认持仓 */
  positionOverride: z.object({ leverage: z.number().int().min(1).max(125) }).optional(),
  asOf: z.number().int().optional(),
})
export type ResearchRunCreate = z.infer<typeof ResearchRunCreateSchema>

export const ResearchRunStatusSchema = z.enum([
  'queued',
  'running',
  'validating',
  'published',
  'failed',
  'cancelled',
])
export type ResearchRunStatus = z.infer<typeof ResearchRunStatusSchema>

export const ResearchRunSchema = z.object({
  id: IdSchema,
  status: ResearchRunStatusSchema,
  product: ResearchProductSchema,
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  horizon: ResearchHorizonSchema,
  /** 运行决策时刻（图表按此冻结，历史复盘与结果同刻） */
  asOf: z.number().int(),
  snapshotId: z.string().optional(),
  configVersion: z.string().optional(),
  knowledgeVersion: z.string().optional(),
  ruleVersion: z.string().optional(),
  modelVersion: z.string().optional(),
  createdAt: z.number().int(),
  publishedAt: z.number().int().optional(),
  error: z.string().optional(),
})
export type ResearchRun = z.infer<typeof ResearchRunSchema>

/** 流水线单步信息（plan→snapshot→structures→retrieve→product_analysis→countercase→validate→publish） */
export const RunStepInfoSchema = z.object({
  step: z.string().min(1),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  startedAt: z.number().int().optional(),
  endedAt: z.number().int().optional(),
  summary: z.string().optional(),
})
export type RunStepInfo = z.infer<typeof RunStepInfoSchema>

/** 研究结论动作域 */
export const ResearchDecisionSchema = z.enum([
  'wait',
  'hold',
  'conditional_entry',
  'reduce',
  'exit',
  'long',
  'short',
  'insufficient_evidence',
])
export type ResearchDecision = z.infer<typeof ResearchDecisionSchema>

/** 论断：事实（可溯源）与解读分离，每条论断挂证据 ID */
export const ResearchClaimSchema = z.object({
  text: z.string(),
  kind: z.enum(['fact', 'interpretation']),
  evidenceIds: z.array(z.string()),
})
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>

/** 条件情景：触发条件 / 应对 / 失效条件 */
export const ResearchScenarioSchema = z.object({
  condition: z.string(),
  response: z.string(),
  invalidation: z.string(),
})
export type ResearchScenario = z.infer<typeof ResearchScenarioSchema>

/** 概率块：唯一来自统计模块；样本量与校准报告随附；不可用时整体为 null */
export const ResearchProbabilitySchema = z.object({
  event: z.string(),
  horizon: ResearchHorizonSchema,
  estimate: z.number().min(0).max(1),
  sampleSize: z.number().int().nonnegative(),
  calibrationId: z.string(),
})
export type ResearchProbability = z.infer<typeof ResearchProbabilitySchema>

export const ResearchResultSchema = z.object({
  decision: ResearchDecisionSchema,
  claims: z.array(ResearchClaimSchema),
  scenarios: z.array(ResearchScenarioSchema),
  evidenceQuality: z.enum(['complete', 'partial', 'stale']),
  probability: ResearchProbabilitySchema.nullable(),
  /** 缺失的必要输入（如未确认持仓），此时建议降级为一般研究 */
  missingInputs: z.array(z.string()),
  /** 产品负载：perp/event 各自形状（计划盈亏矩阵、费用情景 / EV、盈亏平衡等） */
  productPayload: z.record(z.string(), z.unknown()),
})
export type ResearchResult = z.infer<typeof ResearchResultSchema>

export const RUN_PROGRESS_TYPES = [
  'step_started',
  'step_completed',
  'run_published',
  'run_failed',
  'run_cancelled',
] as const

/** SSE 进度事件（/api/research/runs/:id/events）；run_published 的 payload 与 GET result 一致 */
export const RunProgressEventSchema = z.object({
  type: z.enum(RUN_PROGRESS_TYPES),
  runId: IdSchema,
  step: z.string().optional(),
  at: z.number().int(),
  payload: z.unknown().optional(),
})
export type RunProgressEvent = z.infer<typeof RunProgressEventSchema>
