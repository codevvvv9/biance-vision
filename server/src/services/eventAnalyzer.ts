/**
 * EventAnalyzer（P1，improvement-plan §2.3）：
 * - 区分参与前（preview：预览价 60s 时效，研究是否具备参与条件）与已提交（submitted：
 *   执行价/到期/返还固定，只研究剩余期限与到期结果，动作域 monitor/await_settlement/settled）；
 * - 三分支统一：pWin + pLose + pTie = 1（对数阈值）；平价退款净收益 0；
 *   EV = pWin×(payout−stake) − pLose×stake；pTie 未知时 EV 不可用（tie_precision_unknown）；
 * - 盈亏平衡胜率标注「非平价条件」；conditional_entry 五门槛（报价一致/模型覆盖/概率与EV>0/
 *   投入≤事件风险预算/结构与反证通过）由 DecisionPolicy 判定。
 */
import { evaluateEvent } from '../research/event/calc.js'

export type EventOrderState = 'preview' | 'submitted'
export type EventAction = 'conditional_entry' | 'monitor' | 'await_settlement' | 'settled' | 'wait'

export const PREVIEW_TTL_MS = 60_000

export interface EventQuoteInput {
  stake: number
  totalPayout: number
  direction: 'above' | 'below'
  orderState: EventOrderState
  strikeStatus: 'preview' | 'locked'
  previewAsOf: number | null
  eventRiskBudget: number | null
}

export type EventUnavailableCode =
  | 'missing_quote'
  | 'preview_expired'
  | 'tie_precision_unknown'
  | 'ev_not_positive'
  | 'stake_over_budget'
  | 'model_not_published'
  | 'tail_unvalidated'
  | 'stale_reference_price'

export interface EventAnalysis {
  orderState: EventOrderState
  /** 预览价是否过期（过期 → 要求刷新报价，参与判断不可用） */
  previewExpired: boolean
  pWin: number | null
  pTie: number | null
  expectedNet: number | null
  breakevenWinRate: number
  /** 非平价条件下的盈亏平衡胜率 = stake/totalPayout（存在平价概率时不得与无条件 pWin 直接比较） */
  breakevenLabel: string
  winAmount: number
  loseAmount: number
  unavailableCode: EventUnavailableCode | null
  unavailableDetail: string | null
  suggestedAction: EventAction
}

export function analyzeEvent(
  quote: EventQuoteInput,
  probability: { probabilityUp: number; probabilityTie: number | null; modelVersion: string } | null,
  modelUnavailable: { code: string; detail: string } | null,
  asOf: number,
): EventAnalysis {
  const evalNums = evaluateEvent({ stake: quote.stake, totalPayout: quote.totalPayout, direction: quote.direction }, null)
  const base = {
    breakevenWinRate: evalNums.breakevenWinRate,
    breakevenLabel: '非平价条件下的盈亏平衡胜率 = 投入/总返还',
    winAmount: evalNums.winAmount,
    loseAmount: evalNums.loseAmount,
  }
  const previewExpired =
    quote.orderState === 'preview' &&
    quote.strikeStatus !== 'locked' &&
    quote.previewAsOf !== null &&
    asOf - quote.previewAsOf > PREVIEW_TTL_MS

  // 已提交订单：固定值研究剩余期限与结算，不允许提前减仓/抛仓建议
  if (quote.orderState === 'submitted') {
    return {
      orderState: 'submitted',
      previewExpired: false,
      pWin: null,
      pTie: null,
      expectedNet: null,
      ...base,
      unavailableCode: null,
      unavailableDetail: '已提交订单：执行价/到期/返还已固定，输出监控与结算研究，不提供参与前 EV 判断',
      suggestedAction: 'monitor',
    }
  }

  // 参与前：预览过期 → 要求刷新
  if (previewExpired) {
    return {
      orderState: 'preview',
      previewExpired: true,
      pWin: null,
      pTie: null,
      expectedNet: null,
      ...base,
      unavailableCode: 'preview_expired',
      unavailableDetail: `预览执行价/返还超过 ${PREVIEW_TTL_MS / 1000}s 时效，请刷新报价后重新分析`,
      suggestedAction: 'wait',
    }
  }

  // 概率不可用
  if (probability === null) {
    const code = modelUnavailable?.code ?? 'model_not_published'
    return {
      orderState: 'preview',
      previewExpired: false,
      pWin: null,
      pTie: null,
      expectedNet: null,
      ...base,
      unavailableCode: code as EventUnavailableCode,
      unavailableDetail: modelUnavailable?.detail ?? '概率不可用',
      suggestedAction: 'wait',
    }
  }

  // 平价精度未知 → pTie 不可算 → EV 不可用（不假设 pTie=0）
  if (probability.probabilityTie === null) {
    return {
      orderState: 'preview',
      previewExpired: false,
      pWin: probability.probabilityUp,
      pTie: null,
      expectedNet: null,
      ...base,
      unavailableCode: 'tie_precision_unknown',
      unavailableDetail: '结算精度未知：平价概率不可计算，事件 EV 保持不可用（不假设平价概率为 0）',
      suggestedAction: 'wait',
    }
  }

  // probabilityUp 语义 = P(到期指数价高于执行价)。direction=below 时赢概率是
  // P(低于执行价) = 1 − pAbove − pTie（缺一不可，否则看跌单用看涨概率算 EV）。
  const pAbove = probability.probabilityUp
  const pTie = Math.min(Math.max(probability.probabilityTie, 0), Math.max(0, 1 - pAbove))
  const pWin = quote.direction === 'above' ? pAbove : Math.max(0, 1 - pAbove - pTie)
  const pLose = Math.max(0, 1 - pWin - pTie)
  const expectedNet = pWin * (quote.totalPayout - quote.stake) - pLose * quote.stake
  return {
    orderState: 'preview',
    previewExpired: false,
    pWin,
    pTie,
    expectedNet: Number(expectedNet.toFixed(6)),
    ...base,
    unavailableCode: null,
    unavailableDetail: null,
    suggestedAction: expectedNet > 0 ? 'conditional_entry' : 'wait',
  }
}

/**
 * 事件参与五门槛（improvement-plan §2.3）：报价有效 ∧ 模型覆盖剩余期限 ∧ 概率/EV 可用且
 * EV>0 ∧ 投入≤事件风险预算 ∧ 结构与反证通过。返回 [通过?, 原因码]。
 */
export function eventEntryGate(
  analysis: EventAnalysis,
  quote: EventQuoteInput,
  structurePassed: boolean,
): { pass: boolean; code: EventUnavailableCode | 'ev_not_positive' | 'stake_over_budget' | null; detail: string } {
  if (analysis.unavailableCode !== null) {
    return { pass: false, code: analysis.unavailableCode, detail: analysis.unavailableDetail ?? '' }
  }
  if (analysis.expectedNet === null || analysis.pWin === null) {
    return { pass: false, code: 'ev_not_positive', detail: 'EV 或概率不可用' }
  }
  if (analysis.expectedNet <= 0) {
    return { pass: false, code: 'ev_not_positive', detail: `EV=${analysis.expectedNet} 不大于零，不参与` }
  }
  if (quote.eventRiskBudget === null) {
    return { pass: false, code: 'stake_over_budget', detail: '事件风险预算未确认：参与前必须先录入单笔可承受损失' }
  }
  if (quote.stake > quote.eventRiskBudget) {
    return { pass: false, code: 'stake_over_budget', detail: `投入 ${quote.stake} 超过事件风险预算 ${quote.eventRiskBudget}` }
  }
  if (!structurePassed) {
    return { pass: false, code: 'stale_reference_price' as EventUnavailableCode, detail: '结构或反证检查未通过' }
  }
  return { pass: true, code: null, detail: '' }
}
