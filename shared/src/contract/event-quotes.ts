/**
 * /api/event-quotes 事件合约报价契约与 EV 评估形态。
 * 对应 docs/specs/event-contracts.md：官方无 API，报价全部为用户从 App 抄录；
 * stake 与 totalPayout（含本金总返还）始终分列；倒计时/剩余期限由服务端派生。
 */

import { z } from 'zod'
import { DecimalStringSchema, PositiveDecimalStringSchema, ResearchHorizonSchema, SymbolSchema } from '../market.js'
import { IdSchema } from './common.js'

/** 报价录入输入；保存时冻结 asOf，关键字段不可静默修改（更正=作废重建） */
export const EventQuoteInputSchema = z
  .object({
    symbol: SymbolSchema,
    strikePrice: DecimalStringSchema,
    expiryAt: z.number().int(),
    /** 录入时刻冻结的研究基准时间 */
    asOf: z.number().int(),
    /** 投入金额 */
    stake: PositiveDecimalStringSchema,
    /** 含本金的总返还（不是净收益） */
    totalPayout: PositiveDecimalStringSchema,
    /** 预测方向：到期时刻标的价格相对执行价的高/低 */
    direction: z.enum(['above', 'below']),
    /** App 展示的结算参考价 */
    refPrice: DecimalStringSchema.nullable(),
    note: z.string().max(500).optional(),
    /** 参与前研究（预览价 60s 时效）/ 已提交订单（固定值，只研究剩余期限与结算） */
    orderState: z.enum(['preview', 'submitted']).default('preview'),
    /** preview=执行价未锁定 / locked=App 确认的固定执行价 */
    strikeStatus: z.enum(['preview', 'locked']).default('preview'),
    /** 用户确认的事件风险预算（单笔可承受损失）；参与门槛必填 */
    eventRiskBudget: PositiveDecimalStringSchema.optional(),
    /**
     * 期限语义：duration=录入时长换算到期（默认，兼容旧客户端）；exact=App 展示的精确到期时刻。
     * 已提交订单（submitted）必须使用 exact（到期时刻已锁定，不接受时长估算）。
     */
    expiryKind: z.enum(['duration', 'exact']).default('duration'),
    /** 期限桶标签（如 10m/1h）；duration 模式下服务端按 expiryAt−asOf 匹配桶并核对一致性 */
    horizon: ResearchHorizonSchema.optional(),
  })
  .refine((v) => Number(v.totalPayout) >= Number(v.stake), {
    message: 'totalPayout（含本金总返还）必须大于等于 stake',
    path: ['totalPayout'],
  })
export type EventQuoteInput = z.infer<typeof EventQuoteInputSchema>

export const EventQuoteSchema = z.object({
  id: IdSchema,
  symbol: SymbolSchema,
  strikePrice: DecimalStringSchema,
  expiryAt: z.number().int(),
  asOf: z.number().int(),
  stake: PositiveDecimalStringSchema,
  totalPayout: PositiveDecimalStringSchema,
  direction: z.enum(['above', 'below']),
  refPrice: DecimalStringSchema.nullable(),
  note: z.string().max(500).optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** 服务端时钟派生的剩余期限（毫秒），不入库存储 */
  remainingMs: z.number().int(),
  /** 到期后追加：研究估算/用户确认结果，互不覆盖 */
  estimatedOutcome: z.enum(['above', 'below', 'tie']).nullable().optional(),
  userConfirmedOutcome: z.enum(['above', 'below', 'tie']).nullable().optional(),
})
export type EventQuote = z.infer<typeof EventQuoteSchema>

/**
 * 报价的 EV 评估结果（全部由代码计算，LLM 不参与数值）。
 * 概率不可用时数值字段保持可算部分、unavailableReason 说明原因。
 */
export const EventEvaluationSchema = z.object({
  /** 无平价退款时的盈亏平衡胜率 = stake / totalPayout */
  breakevenWinRate: z.number().min(0).max(1),
  /** 期望净收益 EV = pWin×(totalPayout−stake) − pLose×stake */
  expectedNet: DecimalStringSchema,
  /** 盈利分支净得 = totalPayout − stake */
  winAmount: DecimalStringSchema,
  /** 亏损分支损失 = stake */
  loseAmount: DecimalStringSchema,
  /** 是否存在平价退款分支（单独处理，不并入胜负 EV） */
  hasTieRefund: z.boolean(),
  countdownMs: z.number().int(),
  /** 剩余期限是否落入已验证期限桶且在容差内 */
  horizonMatched: z.boolean(),
  /** 概率/EV 不可用原因（期限未验证、超出容差、模型未就绪、数据过期等） */
  unavailableReason: z.string().nullable(),
})
export type EventEvaluation = z.infer<typeof EventEvaluationSchema>
