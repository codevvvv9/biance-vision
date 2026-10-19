/**
 * ResearchValidator（P1，improvement-plan §1.1/§4.2）：
 * 校验数据、方向、数值、引用与版本一致性；数值/数据错误由代码处理，
 * 不交给 LLM 修复；未通过校验的结论不发布。
 * P1（2026-10-19 复核缺口②）：新增 unsupported_reference 语义支持检查——
 * 引用存在（reference_missing）≠ 证据支持该声明；带引用的声明须与被引证据正文
 * 有内容词项重叠（CJK bigram + 拉丁词项，与 countercaseParse 锚定同口径）。
 * 边界如实声明：这是「主题相关性」级检查，不是极性/蕴含判断（NLI）——
 * 极性矛盾（如「已失效」引「尚未失效」）由数字白名单+提示词约束+抽样评测兜底。
 */
import type { EventAnalysis } from './eventAnalyzer.js'
import { extractCjkBigrams, extractLatinTokens } from '../knowledge/terms.js'

export type ValidationCode =
  | 'numeric_mismatch'
  | 'probability_without_model'
  | 'reference_missing'
  | 'unsupported_reference'
  | 'version_mismatch'
  | 'fabricated_number'
  | 'event_action_violation'
  | 'direction_logic'

/** 概率红线（评审三轮-5 改共现规则）：概率词与数字（%/小数）在同一文本内共现即拒绝——
 * 与措辞/语序/连接词无关（「胜率约90%」「上涨概率达到90%」「胜率超过80%」「90% 的胜率」全覆盖）。
 * fact 声明由代码模板装配数值，豁免；LLM 文本（反证/解释）任何情况不得含概率数字。 */
const PROB_WORD_RE = /概率|胜率|胜算|probability|win\s*rate|winrate/i
const PCT_NUM_RE = /\d+(?:\.\d+)?\s*%/
const DECIMAL_PROB_RE = /(?<![\d.])0?\.\d+(?![\d.])/

function hasFabricatedProb(text: string): boolean {
  return PROB_WORD_RE.test(text) && (PCT_NUM_RE.test(text) || DECIMAL_PROB_RE.test(text))
}

export interface ClaimLike {
  text: string
  kind: 'fact' | 'interpretation'
  evidenceIds: string[]
}

export interface ValidateInput {
  claims: ClaimLike[]
  counterClaims: { text: string; evidenceIds: string[] }[]
  knownEvidenceIds: Set<string>
  /** 冻结证据正文（id → text）：提供时启用语义支持检查（unsupported_reference）。
   *  声明带引用但与全部被引证据正文无内容词项重叠 → 拒绝（引用有效 ≠ 证据支持） */
  evidenceTexts?: Map<string, string>
  /** 概率块启用时的模型版本（null = 概率不可用红线生效） */
  modelVersion: string | null
  event?: {
    analysis: EventAnalysis
    decision: string
  }
  perp?: {
    breakevenOrPnl?: { computed: number; reported: number; label: string; tolerance?: number }
    /** 方向逻辑校验（代码执行）。isExistingPosition=false（新仓计划）：止损须在入场
     * 亏损侧、目标在盈利侧；true（已有持仓）：止损可为浮盈保护止损（越过入场价合法），
     * 已穿越当前价 = 已触发，不拒绝（DecisionPolicy 输出 exit 条件研究） */
    positionLogic?: {
      side: 'long' | 'short'
      entryPrice: number
      stopPrice?: number | null
      targetPrice?: number | null
      isExistingPosition?: boolean
      lastPrice?: number | null
    }
  }
  frozenConfigHash: string | null
  runtimeConfigHash: string | null
}

export function validateResearch(input: ValidateInput): { ok: true } | { ok: false; issues: { code: ValidationCode; detail: string }[] } {
  const issues: { code: ValidationCode; detail: string }[] = []

  // 1) 引用完整性
  for (const c of [...input.claims, ...input.counterClaims]) {
    for (const id of c.evidenceIds) {
      if (!input.knownEvidenceIds.has(id)) {
        issues.push({ code: 'reference_missing', detail: `引用了不存在的证据 ${id}` })
      }
    }
  }

  // 1b) 语义支持（P1 缺口②）：引用存在 ≠ 证据支持。带引用的声明须与至少一条被引
  // 证据正文有内容词项重叠（≥1 个 CJK bigram/拉丁词项；数字与标点不参与）。
  // 证据正文映射缺失（旧调用方/历史数据）时跳过——不因缺少文本而误拒。
  if (input.evidenceTexts !== undefined) {
    const termCache = new Map<string, Set<string>>()
    const termsOfEvidence = (id: string): Set<string> | null => {
      const text = input.evidenceTexts!.get(id)
      if (text === undefined) return null
      let t = termCache.get(id)
      if (t === undefined) {
        t = new Set([...extractLatinTokens(text.toLowerCase()), ...extractCjkBigrams(text)])
        termCache.set(id, t)
      }
      return t
    }
    const checkSupport = (c: { text: string; evidenceIds: string[] }, what: string): void => {
      if (c.evidenceIds.length === 0) return
      const claimTerms = new Set([...extractLatinTokens(c.text.toLowerCase()), ...extractCjkBigrams(c.text)])
      if (claimTerms.size === 0) return
      const supported = c.evidenceIds.some((id) => {
        const evTerms = termsOfEvidence(id)
        if (evTerms === null) return true // 证据正文不可得：退回存在性语义（不误拒）
        for (const t of evTerms) if (claimTerms.has(t)) return true
        return false
      })
      if (!supported) {
        issues.push({ code: 'unsupported_reference', detail: `${what}与被引证据正文无内容词项重叠（引用有效但证据不支持该表述）：${c.text.slice(0, 80)}` })
      }
    }
    input.claims.forEach((c) => checkSupport(c, '声明 '))
    input.counterClaims.forEach((c) => checkSupport(c, '反证 '))
  }

  // 2) 概率红线（评审 R6 收紧）：概率唯一来自统计模块——LLM 产出文本（反证 counterClaims）
  // 与一切非 fact 声明（解释类）在任何情况下都不得含概率/胜率数字（modelVersion 存在不代表
  // 文本数字来自模型）；fact 声明由代码模板装配，豁免。覆盖百分比/小数/倒装形态。
  for (const c of input.counterClaims) {
    if (hasFabricatedProb(c.text)) {
      issues.push({ code: 'fabricated_number', detail: `反证声明含未经统计模块的概率表述：${c.text.slice(0, 80)}` })
    }
  }
  for (const c of input.claims) {
    if (c.kind !== 'fact' && hasFabricatedProb(c.text)) {
      issues.push({ code: 'fabricated_number', detail: `声明含未经统计模块的概率表述：${c.text.slice(0, 80)}` })
    }
  }

  // 3) 事件数值复算：EV 与三分支一致；已提交订单不得出现参与前动作
  if (input.event !== undefined) {
    const a = input.event.analysis
    if (a.pWin !== null && a.pTie !== null && a.expectedNet !== null) {
      const pLose = 1 - a.pWin - a.pTie
      const expect = a.pWin * (a.winAmount) - pLose * a.loseAmount
      if (Math.abs(expect - a.expectedNet) > 1e-4) {
        issues.push({ code: 'numeric_mismatch', detail: `EV 复算不一致：${a.expectedNet} ≠ ${expect.toFixed(6)}` })
      }
    }
    if (a.orderState === 'submitted' && !['monitor', 'await_settlement', 'settled', 'wait'].includes(input.event.decision)) {
      issues.push({ code: 'event_action_violation', detail: `已提交订单不允许动作 ${input.event.decision}（只允许监控/等待结算/已结算）` })
    }
    if (a.orderState === 'preview' && a.suggestedAction === 'conditional_entry' && a.expectedNet !== null && a.expectedNet <= 0) {
      issues.push({ code: 'event_action_violation', detail: 'conditional_entry 与 EV<=0 矛盾' })
    }
  }

  // 4) 数值复算（perp）；tolerance 可由调用方按量纲显式放宽（如保证金级 1e-3）
  if (input.perp?.breakevenOrPnl !== undefined) {
    const { computed, reported, label, tolerance } = input.perp.breakevenOrPnl
    const tol = tolerance ?? 1e-6
    if (Math.abs(computed - reported) > tol) {
      issues.push({ code: 'numeric_mismatch', detail: `${label} 复算不一致：${reported} ≠ ${computed}` })
    }
  }

  // 4b) 方向逻辑（perp，代码执行，不交给 LLM）：
  // 新仓计划：止损在入场亏损侧、目标在盈利侧；
  // 已有持仓：浮盈保护止损可越过入场价，有效性 = 相对当前价在可触发一侧
  if (input.perp?.positionLogic !== undefined) {
    const p = input.perp.positionLogic
    if (p.stopPrice !== undefined && p.stopPrice !== null) {
      if (p.isExistingPosition === true) {
        // 已穿越当前价的止损 = 已触发（真实会发生：用户未手动执行）：不再拒绝整run，
        // 交由 DecisionPolicy 的止损触发分支给出 exit 条件研究（含触发/解除条件与价格明细）。
        // 校验器只拦「价格数据非法」（lastPrice<=0）这一类硬错误。
        if (p.lastPrice !== undefined && p.lastPrice !== null && p.lastPrice <= 0) {
          issues.push({ code: 'direction_logic', detail: `当前价 ${p.lastPrice} 非法（<=0）：止损触发判断不可用` })
        }
      } else {
        if (p.side === 'long' && p.stopPrice >= p.entryPrice) {
          issues.push({ code: 'direction_logic', detail: `多头新仓止损 ${p.stopPrice} 未低于入场 ${p.entryPrice}` })
        }
        if (p.side === 'short' && p.stopPrice <= p.entryPrice) {
          issues.push({ code: 'direction_logic', detail: `空头新仓止损 ${p.stopPrice} 未高于入场 ${p.entryPrice}` })
        }
      }
    }
    if (p.targetPrice !== undefined && p.targetPrice !== null) {
      if (p.side === 'long' && p.targetPrice <= p.entryPrice) {
        issues.push({ code: 'direction_logic', detail: `多头目标 ${p.targetPrice} 未高于入场 ${p.entryPrice}` })
      }
      if (p.side === 'short' && p.targetPrice >= p.entryPrice) {
        issues.push({ code: 'direction_logic', detail: `空头目标 ${p.targetPrice} 未低于入场 ${p.entryPrice}` })
      }
    }
  }

  // 5) 版本一致性：运行配置哈希与冻结哈希一致（防运行中被新发布影响）
  if (input.frozenConfigHash !== null && input.runtimeConfigHash !== null && input.frozenConfigHash !== input.runtimeConfigHash) {
    issues.push({ code: 'version_mismatch', detail: '运行中配置哈希与冻结值不一致' })
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
