/**
 * 受约束综合解释（P1-2，vertical-agent-architecture.md §4.E-2 / §6 P1-2）：
 * publish 前对用户原问题做一次综合——提示词只允许引用：已计算事实（claims/fact 行）、
 * 适用与失效条件（规则卡/结构规则）、已冻结证据；产出经统一校验：
 *   1) [k] 引用编号 ∈ 1..证据数；
 *   2) 锚定词项支持（句与被引证据正文有内容词项重叠，与 countercaseParse 同口径）；
 *   3) 数字白名单（句中数字 ⊆ facts ∪ 证据正文的数字集；禁止产出任何新数字）；
 *   4) 概率红线（概率词+数字共现拒绝）。
 * 违例句剔除；全部违例或 LLM 失败 → 回退代码装配模板（降级不失败，红线 #1）。
 *
 * 默认开启条件：ruleParams.synthesis.enabled !== false 且 chat 能力可用（无 LLM 时
 * 直接走模板，不发起调用）；对应预算 6→7 在 freezeRunConfig 落地（enabled 时生效）。
 */
import { extractCjkBigrams, extractLatinTokens } from '../../knowledge/terms.js'

/** 可注入的 LLM 调用形态（生产传 resolveLlmClient() 的 complete 绑定；评测传 mock） */
export type SynthesisLlm = (input: { system: string; user: string; maxTokens?: number; timeoutMs?: number }) => Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } }>

export interface SynthesisInput {
  question: string | null
  symbol: string
  horizon: string
  decision: { action: string; side: string | null; reasons: string[]; conditions: string[] }
  claims: { text: string; kind: 'fact' | 'interpretation'; evidenceIds: string[] }[]
  counterClaims: { text: string; evidenceIds: string[] }[]
  scenarios: { condition: string; response: string; invalidation: string }[]
  /** 呈给模型的编号证据正文（[1..N]，锚定支持与数字白名单同源于此） */
  evidenceTexts: string[]
}

export interface SynthesisResult {
  text: string
  source: 'llm' | 'template'
  /** true = LLM 输出被校验剔除/失败后回退模板 */
  degraded?: boolean
  checkNotes: string[]
  /** 本次是否真实发起 LLM 调用（调用方据此记账 usage.llmCalls） */
  didCallLlm: boolean
  /** 成功调用的 token 用量（调用方据此累计 usage.tokens/costUsd；失败/模板为 null） */
  usage: { promptTokens: number; completionTokens: number } | null
}

/** 决策动作中文标签（模板装配与前端 ResultCard 共用口径） */
export const DECISION_LABEL_ZH: Record<string, string> = {
  wait: '等待',
  hold: '持有',
  conditional_entry: '条件参与',
  reduce: '减仓',
  exit: '退出',
  long: '做多',
  short: '做空',
  request_reconfirm: '请重新确认持仓',
  insufficient_evidence: '证据不足',
  monitor: '监控订单',
  await_settlement: '等待结算',
  settled: '已结算',
}

const PROB_WORD_RE = /概率|胜率|胜算|probability|win\s*rate|winrate/i
const PCT_NUM_RE = /\d+(?:\.\d+)?\s*%/
const DECIMAL_PROB_RE = /(?<![\d.])0?\.\d+(?![\d.])/

function numbersOf(text: string): Set<string> {
  return new Set(text.match(/\d+(?:\.\d+)?/g) ?? [])
}

function termsOf(text: string): Set<string> {
  return new Set([...extractLatinTokens(text.toLowerCase()), ...extractCjkBigrams(text)])
}

/** 代码装配模板回答（数字全部来自 facts/条件行；LLM 不可用/被拒时回退，永远可信） */
export function templateSynthesis(input: SynthesisInput): string {
  const q = input.question !== null && input.question.trim() !== '' ? `针对「${input.question.trim().slice(0, 80)}」` : `针对 ${input.symbol}（${input.horizon}）研究`
  const label = DECISION_LABEL_ZH[input.decision.action] ?? input.decision.action
  const side = input.decision.side === 'long' ? '（多）' : input.decision.side === 'short' ? '（空）' : ''
  const reasons = input.decision.reasons.slice(0, 3).join('；')
  const cond = [...input.decision.conditions, ...input.scenarios.map((s) => `${s.condition}（失效：${s.invalidation}）`)].slice(0, 3).join('；')
  const counters = input.counterClaims.filter((c) => c.evidenceIds.length > 0).slice(0, 2).map((c) => c.text.slice(0, 60)).join('；')
  return [
    `${q}：当前结论为「${label}${side}」。`,
    reasons !== '' ? `主要理由：${reasons}。` : '',
    cond !== '' ? `前提条件：${cond}。` : '',
    counters !== '' ? `需要留意的反证：${counters}。` : '',
  ]
    .filter((p) => p !== '')
    .join('')
}

/**
 * 呈给模型的输入块与 user 提示词（单一拼装来源）：
 * buildSynthesis 与调用方的调用前费用预估（estimateMaxLlmCallCostUsd）共用同一文本，
 * 保证预检长度与实际请求一致。
 */
export function synthesisUserPrompt(input: SynthesisInput): { factsBlock: string; counterBlock: string; evidenceBlock: string; user: string } {
  const factsBlock = [
    ...input.claims.slice(0, 8).map((c) => `- ${c.text.slice(0, 160)}`),
    ...input.decision.reasons.slice(0, 3).map((r) => `- 理由：${r.slice(0, 120)}`),
    ...input.scenarios.slice(0, 2).map((s) => `- 条件：${s.condition}；失效：${s.invalidation}`),
  ].join('\n')
  const evidenceBlock = input.evidenceTexts.map((t, i) => `[${i + 1}] ${t.slice(0, 400)}`).join('\n')
  const counterBlock = input.counterClaims.slice(0, 4).map((c) => `- ${c.text.slice(0, 100)}`).join('\n')
  const user = `用户问题：${input.question ?? `（${input.symbol} ${input.horizon} 结构研究）`}\n\n已计算事实与条件：\n${factsBlock}\n\n反证要点：\n${counterBlock || '（无）'}\n\n编号证据：\n${evidenceBlock || '（无）'}`
  return { factsBlock, counterBlock, evidenceBlock, user }
}

// ---- 决策一致性红线（2026-10-20 评审 #2）----
// 综合解释是「研究结论的转述」而非交易指令；以下形态无论有无引用一律剔除：
// - 满仓/全仓/梭哈：仓位上限纪律，LLM 不得建议性提及（条件句同样剔除）；
// - 无止损建议：风控红线；
// - 无条件立即指令（立即/马上/务必 × 动作词，句内无「若/如果/一旦/当」等条件词）；
// - 开仓方向矛盾：无条件句含做多/买入（或对称做空）而决策方向不符——只匹配开仓性
//   动作词（「看多/看空」是结构描述、「卖出/平仓」可能是 exit 决策的平多动作，不误伤）；
//   反证句允许在条件词之下讨论反向情形。
const OVERSIZE_RE = /满仓|全仓|梭哈/
const NO_STOP_RE = /无需?设?置?止损|不用止损|不需要止损|不必止损/
const URGENCY_RE = /立即|马上|务必|一定要/
const ACT_RE = /做多|做空|买入|卖出|开仓|加仓|进场|入场|清仓|平仓/
const LONG_RE = /做多|开多|买入|建多/
const SHORT_RE = /做空|开空|建空/
const COND_RE = /若|如果|一旦|当|条件|触发|跌破|突破|除非|否则/

function decisionConflict(bare: string, decision: SynthesisInput['decision']): boolean {
  if (OVERSIZE_RE.test(bare)) return true
  if (NO_STOP_RE.test(bare)) return true
  if (URGENCY_RE.test(bare) && ACT_RE.test(bare) && !COND_RE.test(bare)) return true
  if (!COND_RE.test(bare)) {
    if (decision.side !== 'long' && LONG_RE.test(bare)) return true
    if (decision.side !== 'short' && SHORT_RE.test(bare)) return true
  }
  return false
}

export interface SynthesisCheckResult {
  /** 校验后保留的句子（已剥离 [k] 标记？否——保留原文含标记，与既有行为一致） */
  kept: string[]
  /** 被剔除的句子总数 */
  dropped: number
  /** 分类计数：无来源支撑 / 决策红线 / 引用越界 / 概率红线 / 数字白名单外 */
  by: { unsupported: number; decision: number; badRef: number; prob: number; badNum: number }
  notes: string[]
}

/**
 * 句级校验（buildSynthesis 与 validate 阶段复查共用；2026-10-20 评审 #2 对齐）：
 * 1) [k] 引用编号 ∈ 1..证据数；
 * 2) 概率红线（概率词+数字共现拒绝）；
 * 3) 数字白名单（句中数字 ⊆ facts ∪ 条件/情景 ∪ 证据正文；禁止产出任何新数字）；
 * 4) 决策一致性（满仓/无止损/无条件立即指令/无条件方向矛盾 → 剔除）；
 * 5) 来源锚定：带 [k] 的句须被所引证据支持（词项重叠）；无 [k] 的句须与
 *    证据 ∪ 事实/条件 ∪ 反证要点任一有词项重叠——无引用 ≠ 无来源。
 */
export function checkSynthesisText(raw: string, input: SynthesisInput): SynthesisCheckResult {
  const { factsBlock, counterBlock } = synthesisUserPrompt(input)
  const allowed = numbersOf(factsBlock)
  for (const s of input.scenarios) for (const n of numbersOf(`${s.condition}${s.response}${s.invalidation}`)) allowed.add(n)
  for (const t of input.evidenceTexts) for (const n of numbersOf(t)) allowed.add(n)
  const evidenceTerms = input.evidenceTexts.map((t) => termsOf(t))
  // 无引用句的来源池：全体证据词项 ∪ 事实/条件块 ∪ 反证要点块 ∪ 决策行 ∪ 用户问题
  // （action 标签/side/reasons/conditions——「结构支持继续持有」的信息来源是决策本身，
  //  决策语义不进池会把合法转述句误判为无来源；问题文本是综合解释的作答对象，同为合法源）
  const decisionLine = `${DECISION_LABEL_ZH[input.decision.action] ?? input.decision.action} ${input.decision.side ?? ''} ${input.decision.reasons.join('；')} ${input.decision.conditions.join('；')}`
  const sourceTerms = new Set<string>()
  for (const t of evidenceTerms) for (const w of t) sourceTerms.add(w)
  for (const w of termsOf(factsBlock)) sourceTerms.add(w)
  for (const w of termsOf(counterBlock)) sourceTerms.add(w)
  for (const w of termsOf(decisionLine)) sourceTerms.add(w)
  if (input.question !== null) for (const w of termsOf(input.question)) sourceTerms.add(w)

  const sentences = raw.split(/(?<=[。！？!?\n])/).filter((s) => s.trim() !== '')
  const kept: string[] = []
  const by = { unsupported: 0, decision: 0, badRef: 0, prob: 0, badNum: 0 }
  for (const s of sentences) {
    const refs = [...s.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]))
    if (refs.some((k) => k < 1 || k > input.evidenceTexts.length)) {
      by.badRef++
      continue
    }
    const bare = s.replace(/\s*\[\d{1,2}\]/g, '')
    if (PROB_WORD_RE.test(bare) && (PCT_NUM_RE.test(bare) || DECIMAL_PROB_RE.test(bare))) {
      by.prob++
      continue
    }
    const badNum = [...numbersOf(bare)].find((n) => !allowed.has(n))
    if (badNum !== undefined) {
      by.badNum++
      continue
    }
    if (decisionConflict(bare, input.decision)) {
      by.decision++
      continue
    }
    const sTerms = termsOf(bare)
    if (refs.length > 0) {
      // 引用有效 ≠ 证据支持该句：所引证据中至少一条与句子有词项重叠
      const supported = refs.some((k) => {
        const evTerms = evidenceTerms[k - 1]
        if (evTerms === undefined) return false
        for (const t of evTerms) if (sTerms.has(t)) return true
        return false
      })
      if (!supported) {
        by.unsupported++
        continue
      }
    } else {
      // 无引用句的来源锚定：与来源池无任何词项重叠 → 无依据（"天气晴朗适合旅行"类）
      let supported = false
      for (const t of sTerms) {
        if (sourceTerms.has(t)) {
          supported = true
          break
        }
      }
      if (!supported) {
        by.unsupported++
        continue
      }
    }
    kept.push(s)
  }
  const dropped = by.badRef + by.prob + by.badNum + by.decision + by.unsupported
  const notes: string[] = []
  if (dropped > 0) notes.push(`综合解释剔除 ${dropped} 个违例句（无来源 ${by.unsupported}，决策红线 ${by.decision}，引用越界 ${by.badRef}，概率 ${by.prob}，数字 ${by.badNum}）`)
  return { kept, dropped, by, notes }
}

/**
 * 生成受约束综合解释。llm 传 null（或 LLM 抛错/输出全被拒）→ 模板装配（降级不失败）。
 * 句级校验违例的句子剔除；全部剔除 → 模板 + degraded。
 */
export async function buildSynthesis(
  input: SynthesisInput,
  opts: { llm: SynthesisLlm | null; system: string; timeoutMs?: number },
): Promise<SynthesisResult> {
  const checkNotes: string[] = []
  const template = (): SynthesisResult => ({ text: templateSynthesis(input), source: 'template', checkNotes, didCallLlm: false, usage: null })

  if (opts.llm === null) return template()

  let raw = ''
  let usage: { promptTokens: number; completionTokens: number } | null = null
  try {
    const out = await opts.llm({
      system: opts.system,
      user: synthesisUserPrompt(input).user,
      maxTokens: 420,
      timeoutMs: opts.timeoutMs,
    })
    raw = out.text
    usage = out.usage
  } catch (err) {
    checkNotes.push(`LLM 调用失败：${(err as Error).message.slice(0, 80)}`)
    return { ...template(), degraded: true, didCallLlm: true, usage: null }
  }

  const check = checkSynthesisText(raw, input)
  checkNotes.push(...check.notes)
  if (check.kept.length === 0) {
    checkNotes.push('LLM 综合输出全部句子被校验剔除，回退模板')
    return { ...template(), degraded: true, didCallLlm: true, usage }
  }
  return {
    text: check.kept.join(''),
    source: 'llm',
    ...(check.dropped > 0 ? { degraded: true as const } : {}),
    checkNotes,
    didCallLlm: true,
    usage,
  }
}
