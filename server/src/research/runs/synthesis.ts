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
 * 生成受约束综合解释。llm 传 null（或 LLM 抛错/输出全被拒）→ 模板装配（降级不失败）。
 * 句级校验违例的句子剔除；全部剔除 → 模板 + degraded。
 */
export async function buildSynthesis(
  input: SynthesisInput,
  opts: { llm: SynthesisLlm | null; system: string; timeoutMs?: number },
): Promise<SynthesisResult> {
  const checkNotes: string[] = []
  const template = (): SynthesisResult => ({ text: templateSynthesis(input), source: 'template', checkNotes, didCallLlm: false })

  if (opts.llm === null) return template()

  // 呈给模型：问题 + 决策/事实/条件摘要 + 反证要点 + 编号证据（正文截断）
  const factsBlock = [
    ...input.claims.slice(0, 8).map((c) => `- ${c.text.slice(0, 160)}`),
    ...input.decision.reasons.slice(0, 3).map((r) => `- 理由：${r.slice(0, 120)}`),
    ...input.scenarios.slice(0, 2).map((s) => `- 条件：${s.condition}；失效：${s.invalidation}`),
  ].join('\n')
  const evidenceBlock = input.evidenceTexts.map((t, i) => `[${i + 1}] ${t.slice(0, 400)}`).join('\n')
  const counterBlock = input.counterClaims.slice(0, 4).map((c) => `- ${c.text.slice(0, 100)}`).join('\n')

  let raw = ''
  try {
    const out = await opts.llm({
      system: opts.system,
      user: `用户问题：${input.question ?? `（${input.symbol} ${input.horizon} 结构研究）`}\n\n已计算事实与条件：\n${factsBlock}\n\n反证要点：\n${counterBlock || '（无）'}\n\n编号证据：\n${evidenceBlock || '（无）'}`,
      maxTokens: 420,
      timeoutMs: opts.timeoutMs,
    })
    raw = out.text
  } catch (err) {
    checkNotes.push(`LLM 调用失败：${(err as Error).message.slice(0, 80)}`)
    return { ...template(), degraded: true, didCallLlm: true }
  }

  // 数字白名单：facts ∪ 条件/情景 ∪ 证据正文
  const allowed = numbersOf(factsBlock)
  for (const s of input.scenarios) for (const n of numbersOf(`${s.condition}${s.response}${s.invalidation}`)) allowed.add(n)
  for (const t of input.evidenceTexts) for (const n of numbersOf(t)) allowed.add(n)
  const evidenceTerms = input.evidenceTexts.map((t) => termsOf(t))

  // 句级校验：[k] 有效性 + 概率红线 + 数字白名单 + 锚定支持（引用有效 ≠ 证据支持该句）
  const sentences = raw.split(/(?<=[。！？!?\n])/).filter((s) => s.trim() !== '')
  const kept: string[] = []
  let dropped = 0
  for (const s of sentences) {
    const refs = [...s.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]))
    const badRef = refs.find((k) => k < 1 || k > input.evidenceTexts.length)
    if (badRef !== undefined) {
      dropped++
      continue
    }
    const bare = s.replace(/\s*\[\d{1,2}\]/g, '')
    if (PROB_WORD_RE.test(bare) && (PCT_NUM_RE.test(bare) || DECIMAL_PROB_RE.test(bare))) {
      dropped++
      continue
    }
    const badNum = [...numbersOf(bare)].find((n) => !allowed.has(n))
    if (badNum !== undefined) {
      dropped++
      continue
    }
    if (refs.length > 0) {
      const sTerms = termsOf(bare)
      const supported = refs.some((k) => {
        const evTerms = evidenceTerms[k - 1]
        if (evTerms === undefined) return false
        for (const t of evTerms) if (sTerms.has(t)) return true
        return false
      })
      if (!supported) {
        dropped++
        continue
      }
    }
    kept.push(s)
  }
  if (kept.length === 0) {
    checkNotes.push('LLM 综合输出全部句子被校验剔除，回退模板')
    return { ...template(), degraded: true, didCallLlm: true }
  }
  if (dropped > 0) checkNotes.push(`综合解释剔除 ${dropped} 个违例句`)
  return { text: kept.join(''), source: 'llm', ...(dropped > 0 ? { degraded: true as const } : {}), checkNotes, didCallLlm: true }
}
