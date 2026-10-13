/**
 * 共享契约公共件：统一错误形态、ID、分页查询与 SSE 信封。
 * 查询参数 schema 面向 URL query string，数值用 z.coerce 解析。
 */

import { z } from 'zod'

/** 统一 API 错误形态（写路径失败如 storage: unavailable 也走此形态） */
export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export const IdSchema = z.string().min(1)
export type Id = z.infer<typeof IdSchema>

/** 分页查询：limit 1-200 默认 50 */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PageQuery = z.infer<typeof PageQuerySchema>

/** SSE 通用信封：event 名 + JSON data + 服务端时间戳 */
export interface SseEvent<T> {
  type: string
  data: T
  at: number
}

/** 由 payload schema 生成对应的 SSE 信封 schema */
export const sseEventSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    type: z.string().min(1),
    data: dataSchema,
    at: z.number().int(),
  })
