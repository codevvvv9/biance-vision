import { memberCalls } from '../membership/context.js'
/**
 * LLM 角色执行器客户端（OpenAI 兼容 /chat/completions）。
 * 对应 docs/specs/agent-orchestration.md 的 LlmClient；chat 能力未配置时
 * resolveLlmClient 返回 null——阶段层显式跳过叙述生成（不伪造）。
 * 预算（maxLlmCalls）由调用方按 usage 计数在服务端强制，模型输出不能提高上限。
 */
import type { LlmClient } from './orchestrator/types.js'
import { aiProfileByName, getAiProfilesMasked } from '../ai.js'
import { getCapabilities, resolveSecret } from '../admin/capabilities.js'

function resolveMembershipKey(name: string): string {
  if (!getAiProfilesMasked()[name]) throw new Error('会员 AI 档案不可用')
  const key = aiProfileByName(name)?.apiKey
  if (!key) throw new Error('会员 AI 密钥不可用')
  return key
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('chat 能力未配置（待配置）：叙述类结论不生成，不伪造')
    this.name = 'LlmNotConfiguredError'
  }
}

/** 默认每 run 的 LLM 调用上限（agent 版本 budgets 未发布时的护栏） */
export const DEFAULT_MAX_LLM_CALLS = 6

/** LLM 单价（USD / 百万 token）：环境变量 RESEARCH_LLM_USD_PER_MTOK_PROMPT / _COMPLETION。
 * 两个都配置时费用上限（budgets.maxCostUsd）才真正可执行；未配置返回 null——
 * 不用拍脑袋单价假装执行费用控制。 */
const USD_PER_MTOK_PROMPT = Number(process.env.RESEARCH_LLM_USD_PER_MTOK_PROMPT ?? '') || null
const USD_PER_MTOK_COMPLETION = Number(process.env.RESEARCH_LLM_USD_PER_MTOK_COMPLETION ?? '') || null

/** 按实际 usage 估算单次调用费用（USD）；单价未配置 → null（费用累计保持 0） */
export function estimateLlmCostUsd(usage: { promptTokens: number; completionTokens: number }): number | null {
  if (USD_PER_MTOK_PROMPT === null || USD_PER_MTOK_COMPLETION === null) return null
  return (usage.promptTokens / 1e6) * USD_PER_MTOK_PROMPT + (usage.completionTokens / 1e6) * USD_PER_MTOK_COMPLETION
}

/** 调用前费用上限预估（USD）：prompt 按 chars/4 粗估 token + maxTokens 全用满的最坏情况；
 *  单价未配置 → null（费用上限无从谈起，不假装预留） */
export function estimateMaxLlmCallCostUsd(promptChars: number, maxTokens: number): number | null {
  if (USD_PER_MTOK_PROMPT === null || USD_PER_MTOK_COMPLETION === null) return null
  const promptTokens = Math.ceil(promptChars / 4)
  return (promptTokens / 1e6) * USD_PER_MTOK_PROMPT + (maxTokens / 1e6) * USD_PER_MTOK_COMPLETION
}

export class OpenAICompatibleLlm implements LlmClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey: string | null
  private readonly maxTokens: number
  private readonly temperature?: number
  private readonly outputCap?: number

  constructor(input: { baseUrl: string; model: string; secretRef?: string; maxTokens?: number; temperature?: number }) {
    this.baseUrl = input.baseUrl.replace(/\/+$/, '')
    this.model = input.model
    this.apiKey = input.secretRef?.startsWith('membership-profile:') ? resolveMembershipKey(input.secretRef.slice('membership-profile:'.length)) : resolveSecret(input.secretRef)
    this.maxTokens = input.maxTokens && input.maxTokens > 0 ? input.maxTokens : 2000
    this.temperature = input.temperature
    this.outputCap = input.secretRef?.startsWith('membership-profile:') && input.maxTokens && input.maxTokens > 0 ? input.maxTokens : undefined
    if (!this.baseUrl || !this.model) throw new LlmNotConfiguredError()
  }

  async complete(input: {
    system: string
    user: string
    maxTokens?: number
    temperature?: number
    timeoutMs?: number
  }): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } }> {
    // 调用时长 = min(运行剩余预算, 90s 硬顶)；剩余预算已耗尽 → 拒绝发起（调用前检查，不是事后）
    if (input.timeoutMs !== undefined && input.timeoutMs <= 0) {
      throw new Error('运行时间预算已耗尽：LLM 调用在发起前被拒绝')
    }
    const timeout = Math.min(90_000, input.timeoutMs ?? 90_000)
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          max_tokens: this.outputCap ? Math.min(input.maxTokens ?? this.maxTokens, this.outputCap) : input.maxTokens ?? this.maxTokens,
          temperature: input.temperature ?? this.temperature ?? 0.2,
        }),
        signal: AbortSignal.timeout(Math.max(1_000, timeout)),
      })
    } catch (err) {
      throw new Error(`LLM 接口不可达：${(err as Error).message}`)
    }
    if (!res.ok) {
      throw new Error(`LLM 接口 → ${res.status}：${(await res.text().catch(() => '')).slice(0, 300)}`)
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const text = json.choices?.[0]?.message?.content ?? ''
    if (text === '') throw new Error('LLM 返回空内容')
    return {
      text,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    }
  }
}

/** chat 能力已配置且 baseUrl/model 齐备 → 客户端；否则 null（显式待配置）。
 * frozenCaps：run 冻结配置中的 capabilities。评审三轮-3：调用方显式传入冻结配置时
 * 严格尊重它——冻结为关闭（{enabled:false}，无 baseUrl）也有效，绝不回退全局实时配置；
 * 只有完全未传（undefined，历史 run 无冻结能力字段的兼容路径）才读全局生效配置。 */
export function resolveLlmClient(frozenCaps?: { chat?: { enabled?: boolean; baseUrl?: string; model?: string; secretRef?: string; maxTokens?: number; temperature?: number } } | null): OpenAICompatibleLlm | null {
  if (frozenCaps !== undefined) {
    const frozen = frozenCaps?.chat
    if (frozen === undefined || frozen === null) return null
    if (frozen.enabled !== true || frozen.baseUrl === undefined || frozen.baseUrl === '' || frozen.model === undefined || frozen.model === '') return null
    try {
      return new OpenAICompatibleLlm({ baseUrl: frozen.baseUrl, model: frozen.model, secretRef: frozen.secretRef, maxTokens: frozen.maxTokens, temperature: frozen.temperature })
    } catch {
      return null
    }
  }
  const ctx = memberCalls.getStore()
  if (ctx?.chat && ctx.chatName) return new OpenAICompatibleLlm({ baseUrl: ctx.chat.baseUrl, model: ctx.chat.model, secretRef: `membership-profile:${ctx.chatName}`, maxTokens: ctx.chat.maxTokens, temperature: ctx.chat.temperature })
  const cap = getCapabilities().chat
  if (!cap?.enabled || !cap.baseUrl || !cap.model) return null
  try {
    return new OpenAICompatibleLlm({ baseUrl: cap.baseUrl, model: cap.model, secretRef: cap.secretRef })
  } catch {
    return null
  }
}

/** 把 LLM 叙述输出解析为声明行：忽略空行/编号前缀/markdown 符号 */
export function parseClaimLines(text: string, max = 8): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter((l) => l !== '' && l.length <= 400)
    .slice(0, max)
}
