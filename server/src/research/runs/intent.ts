/**
 * LLM 增强意图分类（agent-orchestration 查询规划的 LLM 叠加层）：
 * 确定性 classifyIntent 在先（免费、稳定）；chat 能力已配置时叠加一次 LLM 分类
 * （严格 JSON 输出 + 枚举校验）。LLM 未配置/超时/输出非法一律降级为确定性结果——
 * 不伪造理解。意图层只做路由：结论仍由流水线与代码校验器产出，提示词不能改变校验。
 * P0-6：提示词经注册表解析（指针→published > 工程默认；会话层不冻结全文，
 * promptRef 记录进 conversation_messages.promptRefs 供审计）。
 */
import { kv, log } from '../../logger.js'
import { resolveLlmClient } from '../llm.js'
import { resolvePromptTemplate } from '../prompts.js'
import type { ResolvedPrompt } from '../prompts.js'
import type { Intent } from './conversation.js'

export interface OrchestratedIntent {
  intent: Intent
  /** LLM 拆出的附加子问题（≤2；仅 concept 类会被内联附答，不另起 run） */
  subQuestions: string[]
  source: 'deterministic' | 'llm'
  /** 本条消息实际使用的提示词版本（审计；模板经注册表解析） */
  promptRef: Pick<ResolvedPrompt, 'name' | 'templateId' | 'version'> | null
}

const INTENTS: readonly Intent[] = ['concept', 'structure', 'perp', 'event', 'replay', 'news', 'system', 'translate']

/**
 * 编排后的意图：LLM 输出通过枚举与格式校验才覆盖确定性结果；
 * subQuestions 只保留 4-120 字、与原消息不同的字符串。
 */
export async function classifyIntentOrchestrated(text: string, deterministic: Intent): Promise<OrchestratedIntent> {
  const fallback: OrchestratedIntent = { intent: deterministic, subQuestions: [], source: 'deterministic', promptRef: null }
  const llm = resolveLlmClient()
  if (llm === null) return fallback
  try {
    const prompt = await resolvePromptTemplate('intent-classifier')
    const out = await llm.complete({
      system: prompt.content,
      user: text.slice(0, 1000),
      maxTokens: 260,
      temperature: 0,
      timeoutMs: 12_000,
    })
    const ref: Pick<ResolvedPrompt, 'name' | 'templateId' | 'version'> = {
      name: prompt.name,
      templateId: prompt.templateId,
      version: prompt.version,
    }
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
    return { intent, subQuestions, source: 'llm', promptRef: ref }
  } catch (err) {
    log.warn('conversation', 'LLM 意图分类失败，降级确定性', kv({ 错误: (err as Error).message.slice(0, 80) }))
    return fallback
  }
}
