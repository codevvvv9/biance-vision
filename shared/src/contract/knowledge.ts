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
