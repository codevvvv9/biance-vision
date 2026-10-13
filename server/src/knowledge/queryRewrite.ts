/**
 * LLM 查询改写（knowledge-rag spec 的 variants 消费点）：
 * chat 能力已配置且策略 variants>0 时，由 LLM 生成改写变体（术语规范名展开/同义表述），
 * 经反漂移校验后进入召回（词项并集 + 向量）；未配置、超时、输出非法时返回空——
 * 调用方回退到仅确定性变体，不阻塞检索。
 */
import type { AgentCapabilities } from 'biance-vision-brooks'
import { OpenAICompatibleLlm, resolveLlmClient } from '../research/llm.js'
import { extractCjkBigrams, extractLatinTokens, normalizeQueryTerms } from './terms.js'

export interface LlmVariantsOutcome {
  variants: string[]
  note: string
}

/** 反漂移校验：变体必须与原查询词项或命中术语共享至少一个词项（CJK bigram 或拉丁词项） */
function sharesAnchor(variant: string, anchors: Set<string>): boolean {
  const tokens = [...extractLatinTokens(variant.toLowerCase()), ...extractCjkBigrams(variant)]
  return tokens.some((t) => anchors.has(t))
}

/**
 * 生成 LLM 改写变体（≤max 个）。
 * 校验规则：字符串、4-120 字、不与原查询重复、通过反漂移校验；任一不满足即丢弃该条。
 */
export async function proposeLlmVariants(
  query: string,
  matchedTerms: string[],
  max: number,
  caps?: AgentCapabilities | null,
): Promise<LlmVariantsOutcome> {
  if (max <= 0) return { variants: [], note: '改写变体未开启' }
  // 评审 F4：run 内调用传入冻结能力（严格使用，不回退全局）；非 run 路径（未传）读全局生效配置
  const llm =
    caps !== undefined
      ? caps?.chat?.enabled === true && caps.chat.baseUrl !== undefined && caps.chat.baseUrl !== '' && caps.chat.model !== undefined && caps.chat.model !== ''
        ? new OpenAICompatibleLlm({ baseUrl: caps.chat.baseUrl, model: caps.chat.model, secretRef: caps.chat.secretRef })
        : null
      : resolveLlmClient()
  if (llm === null) return { variants: [], note: 'chat 能力未配置，LLM 改写跳过（仅确定性变体）' }
  try {
    const out = await llm.complete({
      system:
        '你是检索查询改写器。给定中文交易研究问题与命中的 Brooks 术语，生成改写查询用于知识库召回。' +
        '规则：保持原意；可展开术语规范名、中英文对应、同义表述；不得引入原问题没有的概念；' +
        '每个变体不超过 120 字；只输出 JSON 字符串数组，不要任何解释。',
      user: `问题：${query.slice(0, 500)}\n命中术语：${matchedTerms.slice(0, 8).join('、') || '（无）'}\n生成至多 ${max} 个改写查询。`,
      maxTokens: 300,
      temperature: 0,
      timeoutMs: 15_000,
    })
    const m = out.text.match(/\[[\s\S]*\]/)
    if (m === null) return { variants: [], note: 'LLM 改写输出非 JSON 数组，已丢弃' }
    const parsed: unknown = JSON.parse(m[0])
    if (!Array.isArray(parsed)) return { variants: [], note: 'LLM 改写输出非数组，已丢弃' }
    const anchors = new Set([...normalizeQueryTerms(query).terms, ...matchedTerms])
    const seen = new Set<string>([query])
    const variants: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const v = item.trim()
      if (v.length < 4 || v.length > 120 || seen.has(v)) continue
      if (!sharesAnchor(v, anchors)) continue
      seen.add(v)
      variants.push(v)
      if (variants.length >= max) break
    }
    return {
      variants,
      note: variants.length > 0 ? `LLM 改写变体 ${variants.length} 条进入召回` : 'LLM 改写变体均未通过校验，仅确定性变体',
    }
  } catch (err) {
    return { variants: [], note: `LLM 改写失败（${(err as Error).message.slice(0, 80)}），仅确定性变体` }
  }
}
