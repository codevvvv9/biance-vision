/**
 * DecisionPolicy（P1，improvement-plan §2.2 决策表 + §1.1）：
 * 按产品规则生成动作与原因；publish 不再决定买卖方向，只保存已校验结论。
 * - 永续：持仓未确认/过期→请求重确认；止损/失效触发→exit；超预算→reduce(数量)；
 *   风险通过+结构支持→hold(失效条件)；周期冲突/证据不足→wait/insufficient_evidence；
 *   无持仓+已确认 setup+风险计划完整→conditional_entry(带 side 与计划)。
 * - 周期冲突显式输出（执行周期 vs 背景周期方向不一致），不做多数投票、平票不偏多。
 */

export type Direction = 'bull' | 'bear' | 'neutral'
export type PerpAction = 'wait' | 'hold' | 'conditional_entry' | 'reduce' | 'exit' | 'request_reconfirm'
export type FinalAction = PerpAction | 'insufficient_evidence' | 'monitor' | 'await_settlement' | 'settled'

export interface StructureView {
  execDirection: Direction
  backgroundDirection: Direction
  /** 执行周期与背景周期方向冲突（显式输出，不用投票抹平） */
  conflict: boolean
  conflictDetail: string | null
  /** 已确认 setup/触发（引擎事件，knownAt<=asOf） */
  confirmedSetup: { ruleId: string; direction: Direction } | null
  /** 新近失效事件（近 N 根内，含方向与距今根数）——是否构成退出由策略结合持仓方向判断 */
  recentInvalidations: { direction: Direction; barsAgo: number }[]
}

export interface PerpDecisionInput {
  structure: StructureView
  position: {
    side: 'long' | 'short'
    isStale: boolean
    stopPrice: number | null
    /** 快照最后成交价：判断止损是否已被当前价穿越（触发） */
    lastPrice: number | null
  } | null
  reducePlan: { needed: boolean } | null
  riskCap: { ok: boolean; maxQty: number | null } | null
  evidenceSufficient: boolean
  /** 行情质量是否通过（未通过 → 一切持仓动作降为 wait，不允许 hold/reduce/exit 生效） */
  marketQualityOk: boolean
}

export interface PerpDecision {
  action: PerpAction | 'insufficient_evidence'
  side: 'long' | 'short' | null
  reasons: string[]
  conditions: string[]
}

const positionDirection = (side: 'long' | 'short'): Direction => (side === 'long' ? 'bull' : 'bear')

export function decidePerp(input: PerpDecisionInput): PerpDecision {
  const reasons: string[] = []
  if (input.structure.conflict) {
    reasons.push(`周期冲突：${input.structure.conflictDetail ?? '执行周期与背景周期方向不一致'}`)
  }

  // 1) 持仓未确认/过期
  if (input.position !== null && input.position.isStale) {
    return {
      action: 'request_reconfirm',
      side: null,
      reasons: ['持仓超过确认时效，需重新确认后才输出持仓建议（可继续一般结构研究）'],
      conditions: [],
    }
  }

  // 2) 已确认持仓
  if (input.position !== null) {
    const posDir = positionDirection(input.position.side)
    // 行情质量未通过：一切持仓动作硬阻断（只允许一般研究展示）
    if (!input.marketQualityOk) {
      return { action: 'wait', side: null, reasons: [...reasons, '行情质量未通过（时效/缺口）：持仓动作被阻断，不输出 hold/reduce/exit'], conditions: [] }
    }
    // 止损触发（价格维度）：当前价已穿越用户确认的止损价 → exit 条件研究。
    // 必须先于 hold/reduce 判断——价格已破止损还建议持有/减仓是不合理的；
    // 与结构失效退出互补：结构失效看「依据没了」，止损触发看「预算亏完了」。
    if (
      input.position.stopPrice !== null &&
      input.position.lastPrice !== null &&
      (input.position.side === 'long'
        ? input.position.lastPrice <= input.position.stopPrice
        : input.position.lastPrice >= input.position.stopPrice)
    ) {
      return {
        action: 'exit',
        side: null,
        reasons: [
          ...reasons,
          `止损触发：当前价 ${input.position.lastPrice} 已${input.position.side === 'long' ? '跌破' : '升破'}用户确认的止损价 ${input.position.stopPrice}（${input.position.side === 'long' ? '多头 stop 在下方' : '空头 stop 在上方'}）：exit 条件研究，不是即时指令`,
        ],
        conditions: [
          '触发条件：快照最后成交价已穿越止损价（保护性止损视为已执行或待执行，不再按原计划持有）',
          '解除条件：价格回到止损价以内且结构重新确认时，可重新评估新计划（原计划已失效）',
        ],
      }
    }
    // 证据不足或风险计算失败：不允许直接 hold
    if (!input.evidenceSufficient) {
      return { action: 'insufficient_evidence', side: null, reasons: [...reasons, '证据不足：持仓结论不可发布'], conditions: [] }
    }
    // 无止损持仓（评审 F1）：假设止损只用于新仓上限演示；已有持仓没有真实止损 =
    // 风险约束不可用，不得输出 hold/reduce——缺失信息必须显式补全，不得静默通过
    if (input.position.stopPrice === null) {
      return { action: 'wait', side: null, reasons: [...reasons, '未设置止损：已有持仓缺少风险约束，不输出持有结论——请在持仓中补全止损价后重试'], conditions: [] }
    }
    if (input.riskCap !== null && !input.riskCap.ok) {
      return { action: 'wait', side: null, reasons: [...reasons, '风险计算失败（无止损或仓位上限不可算）：不输出持仓动作'], conditions: [] }
    }
    // 失效触发必须「新近 + 失效的原信号方向与持仓方向一致」：
    // invalidation.direction 是失效的原信号方向（引擎 scanInvalidations 按 s.direction 记录），
    // 多头持仓对应的退出条件是「多头结构失效」，而不是出现反方向结构的失效。
    const INVALIDATION_LOOKBACK_BARS = 30
    const invalidationHit = input.structure.recentInvalidations.find(
      (inv) => inv.barsAgo <= INVALIDATION_LOOKBACK_BARS && inv.direction !== 'neutral' && inv.direction === posDir,
    )
    if (invalidationHit !== undefined) {
      return {
        action: 'exit',
        side: null,
        reasons: [...reasons, `新近失效事件（${invalidationHit.barsAgo} 根前）：持仓依据的 ${posDir} 结构已失效（invalidation.direction=${invalidationHit.direction}）：exit 条件研究`],
        conditions: [
          '触发条件：持仓依据的结构失效已确认（新近失效方向与持仓方向一致），exit 是条件研究结论而非即时指令',
          '解除条件：失效被收回或结构重新确认（同方向新 setup 确认）后，本退出条件作废',
        ],
      }
    }
    if (input.reducePlan?.needed === true) {
      return { action: 'reduce', side: null, reasons: [...reasons, '计划止损损失超过风险预算，输出需减少数量'], conditions: [] }
    }
    if (input.structure.conflict) {
      return { action: 'wait', side: null, reasons: [...reasons, '周期冲突时不输出持仓调整，等待冲突解除'], conditions: [] }
    }
    if (input.structure.execDirection === posDir) {
      return {
        action: 'hold',
        side: null,
        reasons: [...reasons, `结构支持持仓方向（执行周期 ${input.structure.execDirection} = 持仓 ${posDir}）`],
        conditions: [
          '失效条件：执行周期方向翻转或出现已确认的反转结构（MTR/趋势线突破+测试）',
          '风险条件：计划止损损失重新超过风险预算时减仓',
        ],
      }
    }
    return { action: 'reduce', side: null, reasons: [...reasons, `执行周期 ${input.structure.execDirection} 与持仓方向 ${posDir} 相悖`], conditions: [] }
  }

  // 3) 无持仓：需要已确认 setup + 完整风险计划才允许 conditional_entry
  if (input.structure.conflict) {
    return { action: 'wait', side: null, reasons: [...reasons, '周期冲突：不凭单一周期方向开新仓'], conditions: [] }
  }
  if (!input.evidenceSufficient) {
    return { action: 'insufficient_evidence', side: null, reasons: [...reasons, '证据不足（无已确认 setup 或知识证据为空）'], conditions: [] }
  }
  const setup = input.structure.confirmedSetup
  if (setup === null) {
    return { action: 'wait', side: null, reasons: [...reasons, '无已确认 setup/触发：不凭「趋势偏多」输出开仓建议'], conditions: [] }
  }
  if (input.position === null && (input.riskCap === null || !input.riskCap.ok || input.riskCap.maxQty === null || input.riskCap.maxQty <= 0)) {
    return { action: 'wait', side: null, reasons: [...reasons, '风险计划不完整（无止损或仓位上限不可计算）：新仓计划必须包含入场条件、止损、目标与仓位上限'], conditions: [] }
  }
  if (setup.direction !== 'bull' && setup.direction !== 'bear') {
    return { action: 'wait', side: null, reasons: [...reasons, `已确认 setup ${setup.ruleId} 无方向（neutral）：不映射为开仓方向`], conditions: [] }
  }
  return {
    action: 'conditional_entry',
    side: setup.direction === 'bear' ? 'short' : 'long',
    reasons: [...reasons, `已确认 setup ${setup.ruleId}@${setup.direction}，风险计划完整`],
    conditions: [
      '入场条件：setup 触发价（信号棒极值）+ 回踩确认',
      '止损：setup 失效位（结构失效即离场）',
      '目标/退出：测量移动或反向 setup 出现',
      `仓位上限：见 riskCap（含费用与滑点假设，步进取整）`,
    ],
  }
}

/** 事件决策：参与前走 eventEntryGate；已提交 → monitor/await_settlement/settled */
export function decideEventSubmitted(state: { expired: boolean; settled: boolean }): 'monitor' | 'await_settlement' | 'settled' {
  if (state.settled) return 'settled'
  if (state.expired) return 'await_settlement'
  return 'monitor'
}

/** 方向研究（1w 等研究期限）：只输出分布与模式标识，不给参与动作 */
export function decideDirection(): 'wait' {
  return 'wait'
}

/**
 * 事件参与的方向适用性门控（涨跌事件，反证完成后执行）：
 * 报价方向（above=看涨 / below=看跌）必须得到结构方向支持——
 * - veto：任一非中性周期方向与报价方向相反 → 顺势纪律下逆势参与不通过；
 * - insufficient：两周期中性（交易区间概率双向）→ 结构不提供方向优势；
 * - pass：至少一个周期支持且无反向周期 → 通过（附反证审查结论）。
 * verdict/reasons 直接进入最终建议：通过、否决或证据不足三态明确输出。
 */
export interface EventDirectionGateInput {
  quoteDirection: 'above' | 'below'
  execDirection: Direction
  backgroundDirection: Direction
  /** 带引用的反证结论数（LLM 归纳与规则反例） */
  linkedCounterClaims: number
  /** 反证结论摘要（进入 reasons，可追溯） */
  counterSummaries: string[]
}

export type EventDirectionGate =
  | { verdict: 'pass'; reasons: string[] }
  | { verdict: 'veto'; reasons: string[] }
  | { verdict: 'insufficient'; reasons: string[] }

export function gateEventDirection(input: EventDirectionGateInput): EventDirectionGate {
  const dir: Direction = input.quoteDirection === 'above' ? 'bull' : 'bear'
  const label = input.quoteDirection === 'above' ? '看涨（到期高于执行价）' : '看跌（到期低于执行价）'
  const structureNote = `执行周期 ${input.execDirection} / 背景周期 ${input.backgroundDirection}，报价方向 ${label}`
  const oppose =
    (input.execDirection !== 'neutral' && input.execDirection !== dir) ||
    (input.backgroundDirection !== 'neutral' && input.backgroundDirection !== dir)
  const support = input.execDirection === dir || input.backgroundDirection === dir
  if (oppose) {
    return {
      verdict: 'veto',
      reasons: [
        `理论适用性否决：${structureNote}——逆势参与不通过（Brooks 顺势纪律）`,
        ...(input.counterSummaries.length > 0 ? [`反证佐证：${input.counterSummaries[0]}`] : []),
      ],
    }
  }
  if (!support) {
    return {
      verdict: 'insufficient',
      reasons: [`方向证据不足：${structureNote}——两周期中性，结构不提供方向优势（交易区间概率双向）`],
    }
  }
  return {
    verdict: 'pass',
    reasons: [
      `理论适用性通过：${structureNote}`,
      input.linkedCounterClaims > 0
        ? `反证审查：${input.linkedCounterClaims} 条带引用反证已评估，无方向性否决`
        : '反证审查：未命中方向性反证',
    ],
  }
}

/** countercase 阶段消费门控的决策改写（导出供单测；反证完成后进入最终建议） */
export function applyEventDirectionGate(
  decision: { action: string; side: 'long' | 'short' | null; reasons: string[]; conditions: string[] },
  input: {
    quoteDirection: 'above' | 'below'
    execDirection: Direction
    backgroundDirection: Direction
    linkedCounterClaims: number
    counterSummaries: string[]
  },
): { action: string; side: 'long' | 'short' | null; reasons: string[]; conditions: string[] } {
  const gate = gateEventDirection(input)
  if (gate.verdict === 'pass') {
    return { ...decision, reasons: [...decision.reasons, ...gate.reasons] }
  }
  return {
    action: 'wait',
    side: null,
    reasons: [...decision.reasons.filter((r) => !r.includes('五门槛')), ...gate.reasons],
    conditions: ['解除条件：结构方向与报价方向重新一致（或报价刷新为顺势方向）时重新评估参与'],
  }
}
