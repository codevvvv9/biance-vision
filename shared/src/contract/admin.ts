/**
 * /api/admin/agents/* 与 /api/admin/evaluations/* 契约。
 * 对应 docs/specs/admin-security.md：声明式 Agent 版本（草稿→发布不可变→回滚）、
 * 五类能力配置（密钥仅以引用名出现）、评测数据集与运行。
 */

import { z } from 'zod'
import { IdSchema } from './common.js'

/** 单能力配置；密钥存 server/data/secrets.json，此处只出现引用名 */
export const CapabilityConfigSchema = z.object({
  provider: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  secretRef: z.string().optional(),
  dailyLimit: z.number().int().positive().optional(),
  /** embedding 输出维度（需与 knowledge_chunks.embedding 列一致；缺省 1536） */
  dims: z.number().int().positive().optional(),
  enabled: z.boolean().default(false),
})
export type CapabilityConfig = z.infer<typeof CapabilityConfigSchema>

/** search 能力扩展（仅 search 使用；其他四类不受影响）：
 *  allowedDomains 抓取白名单（含子域名匹配；空数组=不允许任何抓取，缺省=不限制），
 *  timeoutMs 搜索/抓取超时（缺省 30000）、maxBytes 原页体积上限（缺省 1MB）、
 *  maxResults 单查询结果上限（缺省 5）。 */
export const SearchCapabilityConfigSchema = CapabilityConfigSchema.extend({
  allowedDomains: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
  maxResults: z.number().int().positive().optional(),
})
export type SearchCapabilityConfig = z.infer<typeof SearchCapabilityConfigSchema>

/** R3 索引增强配置（server/src/knowledge/enhance.ts；缺省关闭=零行为变化） */
export const KnowledgeEnhanceSchema = z.object({
  enabled: z.boolean().default(false),
  keywordsPerChunk: z.number().int().min(1).max(8).default(4),
  questionsPerChunk: z.number().int().min(1).max(4).default(2),
})
export type KnowledgeEnhance = z.infer<typeof KnowledgeEnhanceSchema>

export const KnowledgeCapabilitySchema = z.object({
  enhance: KnowledgeEnhanceSchema.default({ enabled: false, keywordsPerChunk: 4, questionsPerChunk: 2 }),
})

/** 五类能力；未配置（enabled=false）的能力在界面与运行中显示「待配置」；
 * knowledge 为 R3 索引增强节（可选，缺省=关闭） */
export const AgentCapabilitiesSchema = z.object({
  chat: CapabilityConfigSchema,
  embedding: CapabilityConfigSchema,
  rerank: CapabilityConfigSchema,
  vision: CapabilityConfigSchema,
  search: SearchCapabilityConfigSchema,
  knowledge: KnowledgeCapabilitySchema.optional(),
})
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>

/** 预算：运行中以服务端计数为准，模型输出与提示词不能提高上限 */
export const BudgetSchema = z.object({
  maxToolCalls: z.number().int().positive().optional(),
  maxRuntimeMs: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
})
export type Budget = z.infer<typeof BudgetSchema>

/** 角色定义：新增角色只改配置，不改状态机 */
export const AgentRoleSchema = z.object({
  name: z.string().min(1),
  promptRef: z.string().min(1),
  tools: z.array(z.string()),
  budget: BudgetSchema,
})
export type AgentRole = z.infer<typeof AgentRoleSchema>

/** 检索策略：起始值可被评测调整，随版本发布冻结 */
export const RetrievalStrategySchema = z.object({
  /** 改写变体数量上限（起始值 2） */
  variants: z.number().int().min(0).max(5).optional(),
  /** 召回候选数（起始值 30-50） */
  candidateLimit: z.number().int().positive().optional(),
  /** 精排后保留数（起始值 6-10）：支持证据检索数量，运行时从冻结配置读取 */
  finalLimit: z.number().int().positive().optional(),
  /** 反证检索数量（缺省取 finalLimit 的 2/3，至少 2）：运行时从冻结配置读取 */
  counterFinalLimit: z.number().int().positive().optional(),
  /** 未配置 rerank 能力时显式跳过并记录 */
  rerank: z.boolean().optional(),
  adjacency: z.boolean().optional(),
})
export type RetrievalStrategy = z.infer<typeof RetrievalStrategySchema>

/** Agent 版本配置全文（jsonb）；发布后不可变 */
export const AgentConfigSchema = z.object({
  capabilities: AgentCapabilitiesSchema,
  roles: z.array(AgentRoleSchema),
  retrieval: RetrievalStrategySchema,
  budgets: BudgetSchema,
  /** 规则参数：只能取已注册规则 schema 的值（ruleId → 参数） */
  ruleParams: z.record(z.string(), z.unknown()),
})
export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const AgentVersionStatusSchema = z.enum(['draft', 'published', 'archived'])
export type AgentVersionStatus = z.infer<typeof AgentVersionStatusSchema>

export const AgentVersionSchema = z.object({
  id: IdSchema,
  /** 版本标识：semver 或可读标签 */
  label: z.string().min(1),
  status: AgentVersionStatusSchema,
  config: AgentConfigSchema,
  createdAt: z.number().int(),
  publishedAt: z.number().int().optional(),
})
export type AgentVersion = z.infer<typeof AgentVersionSchema>

export const EvalRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed'])
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>

export const EvalRunSchema = z.object({
  id: IdSchema,
  datasetId: IdSchema,
  configVersion: z.string().min(1),
  status: EvalRunStatusSchema,
  metrics: z.record(z.string(), z.number()).nullable(),
  startedAt: z.number().int().optional(),
  endedAt: z.number().int().optional(),
})
export type EvalRun = z.infer<typeof EvalRunSchema>

export const EvalDatasetKindSchema = z.enum(['structure', 'rag', 'dialog', 'replay'])
export type EvalDatasetKind = z.infer<typeof EvalDatasetKindSchema>

export const EvalDatasetSchema = z.object({
  id: IdSchema,
  kind: EvalDatasetKindSchema,
  name: z.string().min(1),
  version: z.number().int().positive(),
  itemCount: z.number().int().nonnegative(),
})
export type EvalDataset = z.infer<typeof EvalDatasetSchema>
