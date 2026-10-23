/**
 * /api/admin/knowledge/* 知识库契约。
 * 对应 docs/specs/knowledge-rag.md：三通道导入、状态机、混合检索打点、
 * manifest 批量导入（与 docs/references/knowledge-source-manifest.json 同构）。
 */

import { z } from 'zod'
import { IdSchema } from './common.js'

export const KnowledgeSourceTypeSchema = z.enum(['file', 'url', 'manifest'])
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeSchema>

/** 文档状态机：uploaded→parsing→parsed→chunked→indexed→published / failed */
export const KnowledgeDocStatusSchema = z.enum([
  'uploaded',
  'parsing',
  'parsed',
  'chunked',
  'indexed',
  'published',
  'failed',
])
export type KnowledgeDocStatus = z.infer<typeof KnowledgeDocStatusSchema>

export const SourceTierSchema = z.enum(['official', 'official_derivative', 'community'])
export type SourceTier = z.infer<typeof SourceTierSchema>

export const AccessSchema = z.enum(['public', 'purchase', 'member'])
export type Access = z.infer<typeof AccessSchema>

export const KnowledgeDocumentSchema = z.object({
  id: IdSchema,
  sourceType: KnowledgeSourceTypeSchema,
  title: z.string(),
  status: KnowledgeDocStatusSchema,
  sourceTier: SourceTierSchema,
  access: AccessSchema,
  /** 已发布次数；0 = 从未发布（工作版本 #1 未转正） */
  version: z.number().int().nonnegative(),
  /** 内容指纹，重复资料去重依据 */
  contentHash: z.string(),
  error: z.string().optional(),
  createdAt: z.number().int(),
})
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>

/** 切分块预览（解析/切分后的人工审核视图） */
export const KnowledgeChunkPreviewSchema = z.object({
  chunkId: z.string().min(1),
  docId: IdSchema,
  pageNo: z.number().int().positive().optional(),
  figureId: z.string().optional(),
  kind: z.enum(['text', 'figure', 'table']),
  /** 截断后的预览文本 */
  text: z.string(),
})
export type KnowledgeChunkPreview = z.infer<typeof KnowledgeChunkPreviewSchema>

/** 检索命中：分数仅作排序参考，不当事实正确率 */
export const SearchHitSchema = z.object({
  chunkId: z.string().min(1),
  score: z.number(),
})
export type SearchHit = z.infer<typeof SearchHitSchema>

/** search-debug 最终命中的可读明细（含页码/图号，供验收与前端展示） */
export const SearchDebugHitSchema = z.object({
  chunkId: z.string().min(1),
  docTitle: z.string(),
  pageNo: z.number().int().positive().nullable().optional(),
  figureId: z.string().nullable().optional(),
  kind: z.enum(['text', 'figure', 'table']),
  snippet: z.string(),
  sourceTier: SourceTierSchema,
})
export type SearchDebugHit = z.infer<typeof SearchDebugHitSchema>

/** search-debug 各阶段打点：归一变体 → 向量/词项召回 → RRF 融合 → 精排 → 邻接扩展 */
export const SearchDebugResultSchema = z.object({
  query: z.string(),
  /** 原问题之外的改写变体 */
  variants: z.array(z.string()),
  vectorHits: z.array(SearchHitSchema),
  termHits: z.array(SearchHitSchema),
  fused: z.array(SearchHitSchema),
  /** 未配置 rerank 能力时为空数组，流水线显式跳过 */
  reranked: z.array(SearchHitSchema),
  /** 邻接上下文扩展说明 */
  adjacencyNotes: z.array(z.string()),
  /** 流水线提示（向量跳过原因、召回异常等），三态可区分 */
  notes: z.array(z.string()).default([]),
  /** 最终命中的可读明细 */
  hits: z.array(SearchDebugHitSchema).default([]),
})
export type SearchDebugResult = z.infer<typeof SearchDebugResultSchema>

/** 资料清单条目：与 docs/references/knowledge-source-manifest.json 同构 */
export const ManifestEntrySchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  type: z.enum(['official_glossary', 'official_doc', 'course', 'faq', 'sample', 'book']),
  title: z.string(),
  topics: z.array(z.string()),
  access: AccessSchema,
  sourceTier: SourceTierSchema,
  /** 商业书籍/会员资料仅 user_upload；URL 导入不绕过访问限制 */
  importMethod: z.enum(['url_fetch', 'user_upload']),
  enabled: z.boolean(),
  notes: z.string().optional(),
})
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>

// ---- W2 第二批：差异轮询 / 解析日志 / 版本历史（契约只增，红线 6/8） ----

/** 解析事件（research-py 阶段事件 + Node 侧 stage 打点共用形状；存于 parseMeta.events） */
export const KnowledgeParseEventSchema = z.object({
  seq: z.number().int(),
  stage: z.string(),
  message: z.string().nullish(),
  atMs: z.number().int(),
  durationMs: z.number().int().nullish(),
})
export type KnowledgeParseEvent = z.infer<typeof KnowledgeParseEventSchema>

/** GET /documents/:id/events 响应（ParseLogDrawer 数据源；单轮=最近一轮） */
export const KnowledgeEventsResponseSchema = z.object({
  docId: z.string(),
  title: z.string(),
  status: KnowledgeDocStatusSchema,
  /** 第 N 次解析（每次 processDocument 递增；W2 打点启用前的旧文档为 0） */
  runNo: z.number().int().nonnegative(),
  attemptId: z.string().nullable(),
  /** false=事件记录启用前导入的旧文档（前端显示降级文案） */
  hasEvents: z.boolean(),
  events: z.array(KnowledgeParseEventSchema),
})
export type KnowledgeEventsResponse = z.infer<typeof KnowledgeEventsResponseSchema>

/** GET /documents/statuses 单项（轻量投影，响应 < 2KB）；'gone'=文档已不存在（差异轮询的删除翻转信号） */
export const KnowledgeDocStatusLiteSchema = z.object({
  id: z.string(),
  status: z.union([KnowledgeDocStatusSchema, z.literal('gone')]),
  errorCode: z.string().nullable(),
  /** 距最近一次状态更新（updatedAt）的毫秒数；uploaded 停留判定用 */
  ageMs: z.number().int().nonnegative(),
})
export type KnowledgeDocStatusLite = z.infer<typeof KnowledgeDocStatusLiteSchema>

/** worker 心跳投影（app_settings['knowledge_worker_heartbeat']；alive 阈值 90s） */
export const KnowledgeWorkerHeartbeatSchema = z.object({
  alive: z.boolean(),
  /** 距最近一次心跳的毫秒数；从未上报（app 进程无 worker）时为 null */
  heartbeatAgeMs: z.number().int().nullable(),
})
export type KnowledgeWorkerHeartbeat = z.infer<typeof KnowledgeWorkerHeartbeatSchema>

/** GET /documents/statuses 响应（差异轮询） */
export const KnowledgeStatusesResponseSchema = z.object({
  statuses: z.array(KnowledgeDocStatusLiteSchema),
  worker: KnowledgeWorkerHeartbeatSchema,
})
export type KnowledgeStatusesResponse = z.infer<typeof KnowledgeStatusesResponseSchema>

/** GET /versions 单项（版本历史弹窗） */
export const KnowledgeVersionSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  docCount: z.number().int(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number().int(),
})
export type KnowledgeVersionSummary = z.infer<typeof KnowledgeVersionSummarySchema>

export const KnowledgeVersionsResponseSchema = z.object({
  versions: z.array(KnowledgeVersionSummarySchema),
})
export type KnowledgeVersionsResponse = z.infer<typeof KnowledgeVersionsResponseSchema>

/** 批量操作结果（部分失败汇报） */
export const KnowledgeBatchResponseSchema = z.object({
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
})

// ---- W2 第三批：manifest 条目状态 / 上传预检 / 用户侧证据源（契约只增，红线 6/8） ----

/** GET /manifest-entries 单项（DB 行投影：含导入状态与最近错误，ManifestDialog 数据源） */
export const KnowledgeManifestEntryStatusSchema = z.object({
  id: z.string(),
  url: z.string(),
  type: z.string(),
  title: z.string(),
  topics: z.array(z.string()),
  /** pending | imported | skipped | failed */
  status: z.string(),
  docId: z.string().nullable(),
  lastError: z.string().nullable(),
  enabled: z.boolean(),
  access: AccessSchema,
  sourceTier: SourceTierSchema,
  importMethod: z.enum(['url_fetch', 'user_upload']),
  notes: z.string().nullable(),
  updatedAt: z.number().int(),
})
export type KnowledgeManifestEntryStatus = z.infer<typeof KnowledgeManifestEntryStatusSchema>

export const KnowledgeManifestEntriesResponseSchema = z.object({
  entries: z.array(KnowledgeManifestEntryStatusSchema),
})
export type KnowledgeManifestEntriesResponse = z.infer<typeof KnowledgeManifestEntriesResponseSchema>

/** POST /documents/precheck 响应（上传前三道校验的第三道：contentHash 服务端查重） */
export const KnowledgePrecheckResponseSchema = z.object({
  duplicate: z.boolean(),
  /** duplicate 时指向已有文档 */
  existingId: z.string().nullable(),
  existingTitle: z.string().nullable(),
})
export type KnowledgePrecheckResponse = z.infer<typeof KnowledgePrecheckResponseSchema>

/**
 * GET /research/runs/:id/evidence 单项新增的「证据源」字段（W2 流程 7，只增不改）：
 * fileUrl 指向用户侧鉴权读取端点（按当前 access 判权，受限/无文件/规则卡时为 null）；
 * docUpdated=true 表示文档已重发布/归档/清除，冻结定位可能失效（前端不高亮并提示）。
 */
export const EvidenceSourceSchema = z.object({
  docId: z.string().nullable(),
  /** 冻结时的切块指纹（evidence_items.contentHash） */
  contentHash: z.string().nullable(),
  fileUrl: z.string().nullable(),
  docUpdated: z.boolean(),
})
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>
export type KnowledgeBatchResponse = z.infer<typeof KnowledgeBatchResponseSchema>
