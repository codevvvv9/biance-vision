/**
 * LLM 增强意图分类（agent-orchestration 查询规划的 LLM 叠加层）：
 * 确定性 classifyIntent 在先（免费、稳定）；chat 能力已配置时叠加一次 LLM 分类
 * （严格 JSON 输出 + 枚举校验）。LLM 未配置/超时/输出非法一律降级为确定性结果——
 * 不伪造理解。意图层只做路由：结论仍由流水线与代码校验器产出，提示词不能改变校验。
 */
import { kv, log } from '../../logger.js'
import { resolveLlmClient } from '../llm.js'
import type { Intent } from './conversation.js'

export interface OrchestratedIntent {
  intent: Intent
  /** LLM 拆出的附加子问题（≤2；仅 concept 类会被内联附答，不另起 run） */
  subQuestions: string[]
  source: 'deterministic' | 'llm'
}

const INTENTS: readonly Intent[] = ['concept', 'structure', 'perp', 'event', 'replay', 'news', 'system']

const CLASSIFIER_SYSTEM = `你是 Brooks 价格行为研究助手的意图分类器。把用户消息分类为恰好一个意图，只输出 JSON：
{"intent":"...","subQuestions":["..."]}

intent 取值：
- concept：询问概念/术语/方法含义（「什么是」「怎么理解」「是什么意思」）
- structure：问行情结构/方向/能不能买卖（「现在能买吗」「看涨还是看跌」「结构如何」「要不要抄底」）
- perp：涉及用户自己的永续持仓/杠杆/止损/加减仓/强平（「我的多单」「止损放哪」「改成 20 倍」）
- event：事件合约/执行价/到期/报价语义（「到期高于 70000」「这份报价值不值」）
- replay：复盘历史时点（「昨天这时候」「复盘上周」「如果当时」）
- news：新闻/消息面/涨跌归因（「为什么大跌」「有什么消息」）
- system：寒暄、与交易研究无关、能力询问（「你好」「你是谁」「你能做什么」）

规则：
- 拿不准选 structure。
- 「能不能买/要不要卖」无持仓语境 → structure；明确提到自己的持仓/多单/空单/杠杆 → perp。
- subQuestions：消息明显包含 2 个以上相互独立的问题、主意图只能覆盖其一时，把其余问题原文列出（至多 2 个）；否则空数组。
- 只输出 JSON，不要任何其他文字。`

/**
 * 编排后的意图：LLM 输出通过枚举与格式校验才覆盖确定性结果；
 * subQuestions 只保留 4-120 字、与原消息不同的字符串。
 */
export async function classifyIntentOrchestrated(text: string, deterministic: Intent): Promise<OrchestratedIntent> {
  const fallback: OrchestratedIntent = { intent: deterministic, subQuestions: [], source: 'deterministic' }
  const llm = resolveLlmClient()
  if (llm === null) return fallback
  try {
    const out = await llm.complete({
      system: CLASSIFIER_SYSTEM,
      user: text.slice(0, 1000),
      maxTokens: 260,
      temperature: 0,
      timeoutMs: 12_000,
    })
    const m = out.text.match(/\{[\s\S]*\}/)
    if (m === null) {
      log.warn('conversation', 'LLM 意图输出非 JSON，降级确定性', kv({ 输出: out.text.slice(0, 80) }))
      return fallback
    }
    const parsed = JSON.parse(m[0]) as { intent?: unknown; subQuestions?: unknown }
    const intent = typeof parsed.intent === 'string' && (INTENTS as readonly string[]).includes(parsed.intent)
      ? (parsed.intent as Intent)
      : null
    if (intent === null) {
      log.warn('conversation', 'LLM 意图枚举非法，降级确定性', kv({ 输出: String(parsed.intent).slice(0, 40) }))
      return fallback
    }
    const subQuestions = Array.isArray(parsed.subQuestions)
      ? parsed.subQuestions
          .filter((q): q is string => typeof q === 'string')
          .map((q) => q.trim())
          .filter((q) => q.length >= 4 && q.length <= 120 && q !== text)
          .slice(0, 2)
      : []
    if (intent !== deterministic) {
      log.ok('conversation', 'LLM 意图纠偏', kv({ 确定性: deterministic, LLM: intent }))
    }
    return { intent, subQuestions, source: 'llm' }
  } catch (err) {
    log.warn('conversation', 'LLM 意图分类失败，降级确定性', kv({ 错误: (err as Error).message.slice(0, 80) }))
    return fallback
  }
}
