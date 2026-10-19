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

// ---- P1-1 场景注册表（vertical-agent-architecture.md §4.A）：三维度分离 ----
// Product（产品契约，数值计算/校验规则随产品走）与 UiMode（纯前端，不入研究语义）
// 已各自存在；TaskScene 是任务场景维度：决定提示词集作用域 / 追问动作集 / 结果卡模板。
// sceneCode 只统一任务场景配置，不得绕过产品级校验（perp run 仍须持仓归属校验）。

export const TASK_SCENES = [
  'hold-review',
  'structure-scan',
  'concept-teach',
  'quote-review',
  'replay-analysis',
  'news-attribution',
] as const
export type TaskScene = (typeof TASK_SCENES)[number]
export const TaskSceneSchema = z.enum(TASK_SCENES)

/** 场景定义（服务端注册表条目；products 声明该场景适用的产品） */
export const SceneDefSchema = z.object({
  code: TaskSceneSchema,
  label: z.string(),
  products: z.array(ResearchProductSchema),
  description: z.string(),
})
export type SceneDef = z.infer<typeof SceneDefSchema>

// ---- P1-3 结构化追问推荐（§4.F-1）：动作而非聊天文字 ----
// prerequisites 是服务端门控语义（工具/数据就绪才返回该动作），不下发到客户端；
// label 仅显示文案，不得包含结果之外的数字。

export const FollowUpActionSchema = z.object({
  action: z.enum(['open_evidence', 'rerun_with', 'switch_context', 'open_rule_card', 'counter_search']),
  label: z.string().min(1).max(60),
  /** 动作指向的源 run（「查看反证」=打开这个 run 的证据抽屉，不触发新研究） */
  sourceRunId: IdSchema.nullable().optional(),
  /** rerun_with / switch_context 的参数（interval/symbol/positionId/quoteId/stance） */
  parameters: z.record(z.string(), z.unknown()).optional(),
})
export type FollowUpAction = z.infer<typeof FollowUpActionSchema>

// ---- P1-4 用户画像（§4.D 第一层：长期研究偏好；独立 PG 表，PG 权威） ----
// leverageHabitMax 是描述性字段（「历史持仓最大杠杆」），不是授权上限。

export const TraderProfileSchema = z.object({
  riskProfile: z.enum(['conservative', 'balanced', 'aggressive']).nullable(),
  experienceLevel: z.enum(['novice', 'intermediate', 'pro']).nullable(),
  /** 历史持仓最大杠杆（描述性习惯，非授权上限） */
  leverageHabitMax: z.number().int().min(1).max(125).nullable(),
  disclaimerAck: z.boolean(),
  /** 用户最后确认时刻（画像变更须用户确认后生效） */
  confirmedAt: z.number().int().nullable(),
})
export type TraderProfile = z.infer<typeof TraderProfileSchema>
export const TraderProfilePatchSchema = TraderProfileSchema.partial()

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
  /** P1-1 任务场景（缺省由服务端按意图+产品推导；只统一任务配置，不绕过产品校验） */
  sceneCode: TaskSceneSchema.optional(),
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
  /** P1-1 任务场景（服务端 resolveScene 推导或显式传入） */
  sceneCode: TaskSceneSchema.optional(),
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

/** 流水线单步信息（plan→snapshot→structures→retrieve→product_analysis→countercase→synthesis→validate→publish） */
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
  // P0-5/P1-7（C 域）：过程事件与安全/降级事件二分。新增类型不改变既有五种事件的结构；
  // 旧客户端对未知类型安全忽略（useResearchRun 的 switch default）。
  'step_detail',
  'security_interrupt',
  'task_degraded',
] as const

/** step_detail：真实阶段/工具状态/计数播报（红线 #5：不携带提示词/证据/消息正文，不称思维链） */
export const StepDetailPayloadSchema = z.object({
  step: z.string(),
  kind: z.enum(['llm_call', 'retrieval_variant', 'repair_loop', 'evidence_frozen', 'structure_claim', 'synthesis']),
  label: z.string(),
  status: z.enum(['started', 'finished']),
  detail: z.object({ count: z.number().int().optional(), round: z.number().int().optional() }).optional(),
})
export type StepDetailPayload = z.infer<typeof StepDetailPayloadSchema>

/** security_interrupt：仅硬中断安全场景（version_mismatch）；与可用性降级（task_degraded）二分 */
export const SecurityInterruptPayloadSchema = z.object({
  code: z.literal('version_mismatch'),
  reason: z.string(),
  at: z.number().int(),
})
export type SecurityInterruptPayload = z.infer<typeof SecurityInterruptPayloadSchema>

/** task_degraded：任务级受控降级（补问/部分输出/降级发布），由任务语义决定 handling */
export const TaskDegradedPayloadSchema = z.object({
  code: z.enum(['data_stale', 'model_unpublished', 'quote_missing', 'repair_exhausted']),
  handling: z.enum(['ask_user', 'partial_output', 'degraded_publish']),
  reason: z.string(),
  at: z.number().int(),
})
export type TaskDegradedPayload = z.infer<typeof TaskDegradedPayloadSchema>

/** SSE 进度事件（/api/research/runs/:id/events）；run_published 的 payload 与 GET result 一致 */
export const RunProgressEventSchema = z.object({
  type: z.enum(RUN_PROGRESS_TYPES),
  runId: IdSchema,
  step: z.string().optional(),
  at: z.number().int(),
  payload: z.unknown().optional(),
})
export type RunProgressEvent = z.infer<typeof RunProgressEventSchema>
