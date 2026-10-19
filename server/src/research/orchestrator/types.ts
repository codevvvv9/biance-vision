/**
 * 研究运行编排的类型定义。
 * 对应 docs/specs/agent-orchestration.md：固定流水线、每步持久化、取消与恢复、
 * 同一运行共享 snapshotId/knowledgeVersion/configVersion。
 *
 * OCP：持久化（RunStore）、LLM（LlmClient）、进度推送（EventBus）、
 * 各阶段实现（Stage）全部走接口注入；新增阶段 = 注册新 Stage，不改状态机。
 */

import type {
  ResearchDecision,
  ResearchHorizon,
  ResearchResult,
  RunProgressEvent,
  MarketType,
} from 'biance-vision-brooks'

export const STAGE_NAMES = [
  'plan',
  'snapshot',
  'structures',
  'retrieve',
  'product_analysis',
  'countercase',
  // P1-2 受约束综合解释（countercase 之后、validate 之前：产出进修复环，
  // validate 对其执行引用/支持/数字校验；publish 装配进结果）
  'synthesis',
  'validate',
  'publish',
] as const
export type StageName = (typeof STAGE_NAMES)[number]

export type RunStatus = 'queued' | 'running' | 'validating' | 'published' | 'failed' | 'cancelled'

/** 研究运行的可变上下文（跨阶段传递；每阶段读写自己的部分） */
export interface RunContext {
  runId: string
  userId: string
  product: 'perp' | 'event' | 'teaching'
  symbol: string
  marketType: MarketType
  horizon: ResearchHorizon
  question: string | null
  /** P1-1 任务场景（创建时由 resolveScene 推导或显式传入） */
  sceneCode: string | null
  /** 持仓/报价引用（product=perp/event 时） */
  positionId: string | null
  quoteId: string | null
  asOf: number
  /** 共享版本钉住 */
  snapshotId: string | null
  configVersion: string | null
  knowledgeVersion: string | null
  ruleVersion: string | null
  modelVersion: string | null
  /** P2：创建时冻结的完整运行配置（能力/预算/检索参数/知识版本/策略/哈希） */
  frozenConfig: {
    label: string
    budgets: { maxLlmCalls: number; maxToolCalls: number; maxSearchCalls: number; maxRuntimeMs: number; maxCostUsd?: number }
    knowledgeVersionId: string | null
    configHash: string
    raw: Record<string, unknown>
    /** 永续费率两档 + 滑点（八轮起随 run 冻结；旧 run 缺省时由调用方回退工程默认） */
    fees?: { takerRate: number; makerRate: number; slippageRate: number }
    /** 数量步进（仓位上限/减仓取整） */
    stepSize?: number
    /** 最小名义金额约束（仓位上限 bindingConstraint=min_notional） */
    minNotional?: number
    /** 资金费率时效窗口：最新一条距 asOf 超过 intervalMs+graceMs → funding_stale */
    fundingWindow?: { intervalMs: number; graceMs: number }
  } | null
  /** P1：快照质量问题（阻止动作与概率输出） */
  qualityIssues: { code: string; detail: string }[]
  /** P1：冻结快照输入包（结构/图表/预测都从快照读取） */
  snapshotPack: { candles: { interval: string; priceType: string; rows: { t: number; o: string; h: string; l: string; c: string; v: string | null }[] }[]; funding: { t: number; rate: string }[]; indexRef: { price: string; at: number } | null } | null
  /** 规划阶段产出 */
  plan: {
    intent: string
    timeframes: string[]
    requiredTools: string[]
    retrievalQueries: string[]
    searchNeeded: boolean
    missingFields: string[]
  } | null
  /** 结构阶段产出（引擎事件与摘要的序列化形态） */
  structures: {
    perTimeframe: Record<string, { regime: string; alwaysIn: string; signalCount: number; topSignals: string[] }>
    eventIds: string[]
  } | null
  /** 检索阶段产出（webEvidenceIds/webSearch 为 web 搜索证据通道：独立于支持/反证计数，
   *  不进入证据充分性判定；webSearch 记录搜索不可用/预算耗尽等显式跳过原因） */
  retrieval: {
    supportEvidenceIds: string[]
    counterEvidenceIds: string[]
    citations: unknown[]
    webEvidenceIds?: string[]
    webSearch?: { status: 'ok' | 'unavailable' | 'skipped' | 'empty'; note: string }
  } | null
  /** 产品分析阶段产出（perp/event 各自的代码计算结果） */
  productPayload: Record<string, unknown> | null
  /** 分析者/反证的声明 */
  claims: { text: string; kind: 'fact' | 'interpretation'; evidenceIds: string[] }[]
  /** origin（P0-5）：'llm'=LLM 反证归纳产出（降级发布时剔除）；'template'=代码/规则拼装（保留） */
  counterClaims: { text: string; evidenceIds: string[]; origin?: 'template' | 'llm' }[]
  /** P1-2 受约束综合解释（synthesis 阶段产出；publish 装配进 result.synthesis） */
  synthesis: { text: string; source: 'llm' | 'template'; degraded?: boolean } | null
  /** 校验与发布 */
  decision: ResearchDecision | null
  result: ResearchResult | null
  /** 校验失败进入修复轮时，由流水线注入的问题清单（product_analysis 修复轮消费） */
  validationFeedback: string[] | null
  /** P0-5 受控降级：修复预算耗尽后置位——publish 只保留代码计算内容并标注 degraded；
   *  终态为 published(degraded) 而非 failed */
  degradedPublish: { reasons: string[] } | undefined
  /** 用量计数（预算护栏；运行时预算在 pipeline 步骤边界强制；costUsd 需单价配置才累计） */
  usage: { llmCalls: number; tokens: number; searchCalls: number; toolCalls: number; costUsd: number }
  /** 运行开始时刻（运行时预算强制用） */
  runStartedAt: number
}

export interface Stage {
  name: StageName
  run(ctx: RunContext): Promise<void>
}

/** 运行持久化（PG 实现由 api-storage 层提供；评测/测试可用内存实现）。
 * 带 leaseOwner 的写入在租约丢失时抛 LeaseLostError——调用方必须停止一切后续写入。 */
export interface RunStore {
  /** owner 传入时仅租约持有者可转换（取消路径不传 = 无条件） */
  transition(runId: string, status: RunStatus, leaseOwner?: string): Promise<void>
  stepStarted(runId: string, step: StageName, at: number, leaseOwner?: string): Promise<void>
  stepCompleted(runId: string, step: StageName, at: number, summary?: string, costMs?: number): Promise<void>
  /**
   * 阶段完成与检查点原子提交：run_steps 置 completed 与 research_runs 写 ctxState/续租
   * 在同一事务内——两者之间崩溃不会出现「阶段 completed 但恢复时缺输出」。
   * 失败必须抛错（阶段不算完成，恢复时重跑）；丢租约（leaseOwner 不符）抛 LeaseLostError。
   */
  completeStage(
    runId: string,
    step: StageName,
    at: number,
    costMs: number,
    ctxState: Record<string, unknown> | null,
    leaseOwner: string,
  ): Promise<void>
  stepFailed(runId: string, step: StageName, at: number, error: string, leaseOwner?: string): Promise<void>
  publish(runId: string, result: ResearchResult, leaseOwner?: string): Promise<void>
  fail(runId: string, error: string, leaseOwner?: string): Promise<void>
  isCancelled(runId: string): Promise<boolean>
}

/** SSE 进度推送 */
export interface EventBus {
  emit(runId: string, event: RunProgressEvent): void
}

/** 角色执行器使用的 LLM 客户端（配置解析与凭证由 admin 层注入） */
export interface LlmClient {
  complete(input: {
    system: string
    user: string
    maxTokens?: number
    temperature?: number
    /** 本次调用允许的时长上限（ms）：由运行剩余预算传入，不超过内部 90s 硬顶 */
    timeoutMs?: number
  }): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } }>
}

export class RunCancelled extends Error {
  constructor() {
    super('run cancelled')
    this.name = 'RunCancelled'
  }
}

/** 运行租约已被其他 worker 接管：本 worker 必须立即停止对该 run 的一切写入
 * （包括 stepFailed/fail——它们会把接管者正在运行的 run 改成失败）。 */
export class LeaseLostError extends Error {
  constructor(runId: string, owner: string) {
    super(`lease_lost: ${runId} 的租约已不在 ${owner} 手中（可能已被其他 worker 接管），停止写入`)
    this.name = 'LeaseLostError'
  }
}
