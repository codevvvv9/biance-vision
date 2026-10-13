/**
 * /api/portfolio 永续持仓契约。
 * 对应 docs/specs/perpetual.md：持仓全部为用户从 App 手动录入并显式确认，
 * 携带 confirmedAt/staleAfter 语义；精确强平价仅展示用户录入值。
 */

import { z } from 'zod'
import { DecimalStringSchema, PositiveDecimalStringSchema, SymbolSchema } from '../market.js'
import { IdSchema } from './common.js'

/** 持仓录入输入（写操作即一次用户确认） */
export const PositionInputSchema = z.object({
  symbol: SymbolSchema,
  side: z.enum(['long', 'short']),
  qty: PositiveDecimalStringSchema,
  entryPrice: DecimalStringSchema,
  leverage: z.number().int().min(1).max(125),
  marginMode: z.enum(['cross', 'isolated']),
  /** 单笔可承受损失金额 */
  riskBudget: DecimalStringSchema,
  stopPrice: DecimalStringSchema.optional(),
  /** 用户从 App 抄录的强平价；未知为 null，不得用简化估算冒充 */
  liquidationPrice: DecimalStringSchema.nullable().optional(),
  confirmedAt: z.number().int(),
  /** 确认失效时长（小时），超过未再确认标记 stale */
  staleAfterHours: z.number().int().positive().default(72),
})
export type PositionInput = z.infer<typeof PositionInputSchema>

export const PositionSchema = PositionInputSchema.extend({
  id: IdSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** 服务端派生：超过 staleAfterHours 未再确认 */
  isStale: z.boolean(),
})
export type Position = z.infer<typeof PositionSchema>
