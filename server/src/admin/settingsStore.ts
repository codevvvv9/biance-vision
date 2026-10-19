/**
 * 服务端下发配置（P1-8，vertical-agent-architecture.md §4.H-1 + §4.I-3）：
 * - 免责文案：app_settings 键 research_disclaimers = {perp, event, common}；修改即时生效
 *   （replyAssembler 每次组装时读取，不缓存不重启）；红线 #10：前端只渲染不内置文案。
 * - 输入面板配置：app_settings 键 chat_input_config = { scenes: { [product|taskScene]: {placeholder, suggestionLimit} } }；
 *   缺失回退内置（Workbench SCENES hint）。
 * 管理：GET/PUT /api/admin/settings/disclaimers、/api/admin/settings/chat-input（requireSuperadmin+audit）。
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db.js'
import { appSettings } from '../models.js'

export interface DisclaimerConfig {
  perp: string
  event: string
  common: string
}

export const DEFAULT_DISCLAIMERS: DisclaimerConfig = {
  common: '研究结论基于历史结构与公开数据，不构成投资建议；合约交易有爆仓风险。',
  perp: '永续研究：计划盈亏与费用由代码按冻结费率计算，不构成投资建议；合约交易有爆仓风险。',
  event: '事件合约研究：EV 与概率唯一来自统计模块，不可用时明示；不构成投资建议。',
}

const DISCLAIMER_KEY = 'research_disclaimers'

export async function getDisclaimers(): Promise<DisclaimerConfig> {
  try {
    const rows = await getDb()!.select().from(appSettings).where(eq(appSettings.key, DISCLAIMER_KEY)).limit(1)
    const v = (rows[0]?.value ?? {}) as Partial<DisclaimerConfig>
    return {
      perp: typeof v.perp === 'string' && v.perp !== '' ? v.perp : DEFAULT_DISCLAIMERS.perp,
      event: typeof v.event === 'string' && v.event !== '' ? v.event : DEFAULT_DISCLAIMERS.event,
      common: typeof v.common === 'string' && v.common !== '' ? v.common : DEFAULT_DISCLAIMERS.common,
    }
  } catch {
    return DEFAULT_DISCLAIMERS
  }
}

export async function saveDisclaimers(patch: Partial<DisclaimerConfig>): Promise<DisclaimerConfig> {
  const db = getDb()!
  const current = await getDisclaimers()
  const next: DisclaimerConfig = {
    perp: typeof patch.perp === 'string' ? patch.perp.trim().slice(0, 500) : current.perp,
    event: typeof patch.event === 'string' ? patch.event.trim().slice(0, 500) : current.event,
    common: typeof patch.common === 'string' ? patch.common.trim().slice(0, 500) : current.common,
  }
  await db
    .insert(appSettings)
    .values({ key: DISCLAIMER_KEY, value: next as unknown as Record<string, unknown> })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next as unknown as Record<string, unknown> } })
  return next
}

export interface ChatInputSceneConfig {
  placeholder?: string
  suggestionLimit?: number
}

export interface ChatInputConfig {
  /** 键为产品（spot/perp/event）或任务场景（structure-scan 等）；查用时先场景后产品 */
  scenes: Record<string, ChatInputSceneConfig>
}

const CHAT_INPUT_KEY = 'chat_input_config'
const EMPTY_INPUT_CONFIG: ChatInputConfig = { scenes: {} }

export async function getChatInputConfig(): Promise<ChatInputConfig> {
  try {
    const rows = await getDb()!.select().from(appSettings).where(eq(appSettings.key, CHAT_INPUT_KEY)).limit(1)
    const v = (rows[0]?.value ?? {}) as { scenes?: unknown }
    if (v.scenes === undefined || typeof v.scenes !== 'object' || v.scenes === null) return EMPTY_INPUT_CONFIG
    const scenes: Record<string, ChatInputSceneConfig> = {}
    for (const [k, raw] of Object.entries(v.scenes as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue
      const s = raw as { placeholder?: unknown; suggestionLimit?: unknown }
      scenes[k] = {
        ...(typeof s.placeholder === 'string' && s.placeholder !== '' ? { placeholder: s.placeholder.slice(0, 200) } : {}),
        ...(typeof s.suggestionLimit === 'number' && Number.isInteger(s.suggestionLimit) && s.suggestionLimit >= 0 && s.suggestionLimit <= 8 ? { suggestionLimit: s.suggestionLimit } : {}),
      }
    }
    return { scenes }
  } catch {
    return EMPTY_INPUT_CONFIG
  }
}

/** 非法 JSON 拒绝：占位须非空字符串 ≤200、建议上限 0-8 整数 */
export function validateChatInputConfig(value: unknown): ChatInputConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { scenes?: unknown }
  if (typeof v.scenes !== 'object' || v.scenes === null) return null
  const scenes: Record<string, ChatInputSceneConfig> = {}
  for (const [k, raw] of Object.entries(v.scenes as Record<string, unknown>)) {
    if (!/^[\w-]{1,32}$/.test(k)) return null
    if (typeof raw !== 'object' || raw === null) return null
    const s = raw as { placeholder?: unknown; suggestionLimit?: unknown }
    const out: ChatInputSceneConfig = {}
    if (s.placeholder !== undefined) {
      if (typeof s.placeholder !== 'string' || s.placeholder.length === 0 || s.placeholder.length > 200) return null
      out.placeholder = s.placeholder
    }
    if (s.suggestionLimit !== undefined) {
      if (typeof s.suggestionLimit !== 'number' || !Number.isInteger(s.suggestionLimit) || s.suggestionLimit < 0 || s.suggestionLimit > 8) return null
      out.suggestionLimit = s.suggestionLimit
    }
    scenes[k] = out
  }
  return { scenes }
}

export async function saveChatInputConfig(value: unknown): Promise<ChatInputConfig> {
  const parsed = validateChatInputConfig(value)
  if (parsed === null) throw Object.assign(new Error('输入面板配置不合法（scenes 键须为 \\w- 且 ≤32 字符；placeholder 非空 ≤200 字；suggestionLimit 0-8 整数）'), { statusCode: 400 })
  const db = getDb()!
  await db
    .insert(appSettings)
    .values({ key: CHAT_INPUT_KEY, value: parsed as unknown as Record<string, unknown> })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: parsed as unknown as Record<string, unknown> } })
  return parsed
}
