import crypto from 'node:crypto'
import { loadJson, saveJson } from './store.js'
import { log, kv, fmtMs } from './logger.js'
import { completeAi } from './ai.js'
import type { AiProfile, ChatMessage } from './ai.js'
import {
  deleteAiConversationDb,
  deleteAiMemoryDb,
  isDbAvailable,
  loadAiDataFromDb,
  upsertAiConversationDb,
  upsertAiMemoryDb,
} from './db.js'

// ---------------------------------------------------------------------------
// AI 会话历史 + 长期记忆（用户级持久化；JSON 镜像为权威，PostgreSQL 可用时双写）
//
// 记忆设计参照 agent memory 最佳实践：
// - 一条记忆 = 一个独立、自包含的事实（偏好 / 背景 / 关注 / 习惯），脱离原对话也能读懂
// - 对话后由模型在后台提取：与既有记忆重复的跳过、矛盾的修正、过时的淘汰
// - 回答时整体注入 system prompt，跨会话生效；用户可在前端查看 / 编辑 / 删除
// ---------------------------------------------------------------------------

export type MemoryKind = 'preference' | 'fact' | 'interest' | 'habit'

export const MEMORY_KINDS: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '背景',
  interest: '关注',
  habit: '习惯',
}

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: number
}

export interface StoredConversation {
  id: string
  username: string
  title: string
  createdAt: number
  updatedAt: number
  /** 上次记忆提取时的消息数：提取游标（控制提取频率，仅 JSON 镜像维护） */
  lastExtractedCount: number
  messages: StoredMessage[]
}

export interface AiMemoryItem {
  id: string
  username: string
  kind: MemoryKind
  content: string
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

// 保留上限（个人级数据量，全量内存 + 全量 JSON 镜像足够）
const CONV_KEEP_PER_USER = 30 // 每用户会话数
const MSG_KEEP = 200 // 单会话消息数
const MEM_KEEP_PER_USER = 40 // 每用户记忆条数
const MSG_CONTENT_MAX = 8000 // 单条消息入库长度
const MEM_CONTENT_MAX = 200 // 单条记忆长度
const EXTRACT_EVERY_MSGS = 6 // 每 6 条新消息（3 问 3 答）触发一次记忆提取；首轮对话额外触发一次

interface BadRequestError extends Error {
  statusCode: number
}
function badRequest(msg: string): BadRequestError {
  return Object.assign(new Error(msg), { statusCode: 400 })
}

let conversations: StoredConversation[] = loadJson<StoredConversation[]>('ai-chats.json', []).filter(
  (c) => c && typeof c.id === 'string' && typeof c.username === 'string' && Array.isArray(c.messages),
)
let memories: AiMemoryItem[] = loadJson<AiMemoryItem[]>('ai-memories.json', []).filter(
  (m) => m && typeof m.id === 'string' && typeof m.username === 'string' && typeof m.content === 'string',
)

function persistConversations(): void {
  saveJson('ai-chats.json', conversations)
}

function persistMemories(): void {
  saveJson('ai-memories.json', memories)
}

/**
 * 启动时与数据库合并：JSON 镜像为权威（宕机期间 JSON 写入必更新），
 * 数据库独有的会话 / 记忆（如 JSON volume 丢失）收编回内存并回写镜像。
 */
export async function initAiMemory(): Promise<void> {
  if (!isDbAvailable()) return
  let data: Awaited<ReturnType<typeof loadAiDataFromDb>>
  try {
    data = await loadAiDataFromDb()
  } catch (err) {
    log.warn('ai', 'AI 会话数据从数据库加载失败', kv({ 错误: (err as Error).message }))
    return
  }
  if (!data) return

  let adopted = 0
  const convMap = new Map(conversations.map((c) => [c.id, c]))
  for (const pc of data.conversations) {
    const jc = convMap.get(pc.id)
    if (!jc) {
      conversations.push(pc)
      adopted++
    } else if (pc.updatedAt > jc.updatedAt) {
      conversations[conversations.indexOf(jc)] = pc
      adopted++
    }
  }
  const memMap = new Map(memories.map((m) => [m.id, m]))
  for (const pm of data.memories) {
    const jm = memMap.get(pm.id)
    if (!jm) {
      memories.push(pm)
      adopted++
    } else if (pm.updatedAt > jm.updatedAt) {
      memories[memories.indexOf(jm)] = pm
      adopted++
    }
  }
  if (adopted > 0) {
    persistConversations()
    persistMemories()
    log.ok('ai', '已从数据库恢复 AI 会话/记忆', kv({ 收编条目: adopted }))
  }
}

// ---------------------------------------------------------------------------
// 会话读写
// ---------------------------------------------------------------------------

function userConversations(username: string): StoredConversation[] {
  return conversations.filter((c) => c.username === username)
}

/** 裁剪：每用户只保留最近 CONV_KEEP_PER_USER 个会话，被裁的同步从数据库删除 */
function trimConversations(username: string): void {
  const mine = userConversations(username).sort((a, b) => b.updatedAt - a.updatedAt)
  for (const dropped of mine.slice(CONV_KEEP_PER_USER)) {
    conversations = conversations.filter((c) => c.id !== dropped.id)
    void deleteAiConversationDb(dropped.id).catch((e: Error) => log.warn('ai', '会话数据库删除失败:', e.message))
  }
}

export function listConversations(username: string): ConversationSummary[] {
  return userConversations(username)
    .map((c) => ({
      id: c.id,
      title: c.title || '新对话',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getConversation(username: string, id: string): StoredConversation | null {
  const conv = conversations.find((c) => c.id === id)
  return conv && conv.username === username ? conv : null
}

/** 新建会话（首条消息发送时调用，正常路径不会产生空会话） */
export function createConversation(username: string): StoredConversation {
  const now = Date.now()
  const conv: StoredConversation = {
    id: crypto.randomUUID(),
    username,
    title: '',
    createdAt: now,
    updatedAt: now,
    lastExtractedCount: 0,
    messages: [],
  }
  conversations.push(conv)
  trimConversations(username)
  persistConversations()
  void upsertAiConversationDb(conv).catch((e: Error) => log.warn('ai', '会话数据库写入失败:', e.message))
  return conv
}

export function deleteConversation(username: string, id: string): boolean {
  const conv = getConversation(username, id)
  if (!conv) return false
  conversations = conversations.filter((c) => c.id !== id)
  persistConversations()
  void deleteAiConversationDb(id).catch((e: Error) => log.warn('ai', '会话数据库删除失败:', e.message))
  return true
}

/** 追加消息（内存 + JSON 镜像 + 数据库），更新标题与时间；返回更新后的会话 */
export function appendConversationMessages(
  conv: StoredConversation,
  msgs: { role: 'user' | 'assistant'; content: string }[],
): StoredConversation {
  const now = Date.now()
  for (const m of msgs) {
    const content = m.content.slice(0, MSG_CONTENT_MAX)
    conv.messages.push({ id: crypto.randomUUID(), role: m.role, content, at: now })
    // 标题 = 首条用户消息前 24 字
    if (!conv.title && m.role === 'user') conv.title = content.replace(/\s+/g, ' ').slice(0, 24)
  }
  conv.updatedAt = now
  if (conv.messages.length > MSG_KEEP) conv.messages = conv.messages.slice(-MSG_KEEP)
  persistConversations()
  void upsertAiConversationDb(conv).catch((e: Error) => log.warn('ai', '会话数据库写入失败:', e.message))
  return conv
}

/** 会话 → 模型输入的历史（最近 20 条，去掉 id/at 元数据） */
export function chatHistoryOf(conv: StoredConversation): ChatMessage[] {
  return conv.messages.slice(-20).map((m) => ({ role: m.role, content: m.content }))
}

// ---------------------------------------------------------------------------
// 长期记忆：读写 + 提示词注入 + 后台提取
// ---------------------------------------------------------------------------

export function listMemories(username: string): AiMemoryItem[] {
  return memories.filter((m) => m.username === username).sort((a, b) => a.createdAt - b.createdAt)
}

/** 记忆注入 system prompt 的区段；无记忆返回空串 */
export function memoriesPromptBlock(username: string): string {
  const items = listMemories(username)
  if (items.length === 0) return ''
  const lines = items.map((m) => `- [${MEMORY_KINDS[m.kind] ?? m.kind}] ${m.content}`)
  return [
    '# 用户长期记忆（系统从此前对话中自动总结，跨会话保留）',
    '回答时自然参考以下内容，不必逐条复述；若与用户当前的说法冲突，以当前对话为准：',
    ...lines,
  ].join('\n')
}

function persistMemory(m: AiMemoryItem): void {
  persistMemories()
  void upsertAiMemoryDb(m).catch((e: Error) => log.warn('ai', '记忆数据库写入失败:', e.message))
}

export function updateMemory(username: string, id: string, content: string): AiMemoryItem {
  const item = memories.find((m) => m.id === id && m.username === username)
  if (!item) throw badRequest('记忆不存在')
  const text = content.trim().slice(0, MEM_CONTENT_MAX)
  if (!text) throw badRequest('记忆内容不能为空')
  item.content = text
  item.updatedAt = Date.now()
  persistMemory(item)
  return item
}

export function deleteMemory(username: string, id: string): boolean {
  const item = memories.find((m) => m.id === id && m.username === username)
  if (!item) return false
  memories = memories.filter((m) => m.id !== id)
  persistMemories()
  void deleteAiMemoryDb(id).catch((e: Error) => log.warn('ai', '记忆数据库删除失败:', e.message))
  return true
}

export function clearMemories(username: string): number {
  const mine = memories.filter((m) => m.username === username)
  if (mine.length === 0) return 0
  memories = memories.filter((m) => m.username !== username)
  persistMemories()
  for (const m of mine) {
    void deleteAiMemoryDb(m.id).catch((e: Error) => log.warn('ai', '记忆数据库删除失败:', e.message))
  }
  return mine.length
}

// ---- 记忆提取（后台任务，不阻塞对话回复、不占用户配额） ----

const EXTRACT_SYSTEM_PROMPT = `你是记忆管理器，负责从「用户与行情助手的对话」中提取关于用户的长期记忆。

一条记忆 = 一个独立、自包含的事实或偏好，脱离原对话也能读懂（例如「用户偏好短线交易，主要关注 SOL 和 meme 币」）。

只提取跨对话仍有价值的信息：
- 用户背景（职业、交易经验水平）
- 分析偏好（风格、风险偏好、仓位习惯、关注的板块/币种）
- 明确表达过的要求与习惯（回复详略、语言、格式偏好）
- 长期目标或约束

不要提取：
- 与当下行情临时相关的内容（某币此刻涨跌、今日大盘状态）
- 助手回答的内容本身
- 一次性的具体提问

维护规则：
- 与已有记忆重复或近似 → 不加
- 与已有记忆矛盾（偏好改变等）→ 用 update 修正原条目
- 已明显过时（用户已明确放弃）→ 用 delete 移除

只输出严格 JSON，不要任何其他文本：
{"add":[{"kind":"preference|fact|interest|habit","content":"一句话记忆"}],"update":[{"id":"已有记忆id","content":"修正后的内容"}],"delete":["过时记忆id"]}
没有变更时输出 {"add":[],"update":[],"delete":[]}`

/** 提取中的会话（防止同一会话并发提取） */
const extracting = new Set<string>()

/**
 * 对话完成后按间隔触发记忆提取（fire-and-forget）：
 * 首轮对话提取一次，之后每累计 EXTRACT_EVERY_MSGS 条新消息提取一次。
 */
export function maybeExtractMemories(profile: AiProfile, username: string, conv: StoredConversation): void {
  const grown = conv.messages.length - conv.lastExtractedCount
  if (grown < EXTRACT_EVERY_MSGS && conv.messages.length !== 2) return
  if (extracting.has(conv.id)) return
  extracting.add(conv.id)
  conv.lastExtractedCount = conv.messages.length
  persistConversations()
  void extractMemories(profile, username, conv)
    .catch((e: Error) => log.warn('ai', '记忆提取失败', kv({ 用户: username, 错误: e.message })))
    .finally(() => extracting.delete(conv.id))
}

async function extractMemories(profile: AiProfile, username: string, conv: StoredConversation): Promise<void> {
  const existing = listMemories(username)
  const existingText = existing.length
    ? JSON.stringify(existing.map((m) => ({ id: m.id, kind: m.kind, content: m.content })))
    : '[]'
  const recentText = conv.messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 600)}`)
    .join('\n')
  const startedAt = Date.now()

  const raw = await completeAi(
    profile,
    EXTRACT_SYSTEM_PROMPT,
    `【已有记忆】\n${existingText}\n\n【最近对话】\n${recentText}`,
  )

  const plan = parseExtractJson(raw)
  if (!plan) {
    log.warn('ai', '记忆提取结果无法解析', kv({ 用户: username, 原文: raw.slice(0, 80) }))
    return
  }
  const mine = new Map(existing.map((m) => [m.id, m]))

  let added = 0
  for (const a of plan.add.slice(0, 5)) {
    const kind = (typeof a?.kind === 'string' && a.kind in MEMORY_KINDS ? a.kind : 'fact') as MemoryKind
    const content = typeof a?.content === 'string' ? a.content.trim().slice(0, MEM_CONTENT_MAX) : ''
    if (!content) continue
    if (memories.some((m) => m.username === username && m.content === content)) continue
    const item: AiMemoryItem = {
      id: crypto.randomUUID(),
      username,
      kind,
      content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    memories.push(item)
    persistMemory(item)
    added++
  }
  let updated = 0
  for (const u of plan.update) {
    const target = typeof u?.id === 'string' ? mine.get(u.id) : undefined
    const content = typeof u?.content === 'string' ? u.content.trim().slice(0, MEM_CONTENT_MAX) : ''
    if (!target || !content) continue
    target.content = content
    target.updatedAt = Date.now()
    persistMemory(target)
    updated++
  }
  let removed = 0
  for (const id of plan.delete) {
    if (typeof id !== 'string') continue
    const target = mine.get(id)
    if (!target) continue
    memories = memories.filter((m) => m.id !== id)
    persistMemories()
    void deleteAiMemoryDb(id).catch((e: Error) => log.warn('ai', '记忆数据库删除失败:', e.message))
    removed++
  }

  // 总量裁剪：超限时淘汰最旧的
  const mineList = memories.filter((m) => m.username === username).sort((a, b) => a.updatedAt - b.updatedAt)
  for (const dropped of mineList.slice(0, Math.max(0, mineList.length - MEM_KEEP_PER_USER))) {
    memories = memories.filter((m) => m.id !== dropped.id)
    persistMemories()
    void deleteAiMemoryDb(dropped.id).catch((e: Error) => log.warn('ai', '记忆数据库删除失败:', e.message))
    removed++
  }

  if (added || updated || removed) {
    log.ok('ai', '长期记忆已更新', kv({
      用户: username,
      增: added || undefined,
      改: updated || undefined,
      删: removed || undefined,
      现存: listMemories(username).length,
      耗时: fmtMs(Date.now() - startedAt),
    }))
  }
}

/** 容错解析模型输出的 JSON 计划（直接 parse 失败时截取首尾花括号再试） */
function parseExtractJson(raw: string): { add: { kind?: unknown; content?: unknown }[]; update: { id?: unknown; content?: unknown }[]; delete: unknown[] } | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let parsed = tryParse(raw.trim())
  if (parsed === null) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) parsed = tryParse(raw.slice(start, end + 1))
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  return {
    add: Array.isArray(p.add) ? (p.add as { kind?: unknown; content?: unknown }[]) : [],
    update: Array.isArray(p.update) ? (p.update as { id?: unknown; content?: unknown }[]) : [],
    delete: Array.isArray(p.delete) ? (p.delete as unknown[]) : [],
  }
}
