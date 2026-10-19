/**
 * 研究记忆收编（P1-5，vertical-agent-architecture.md §6 P1-5）：
 * 从链路 A 的 aiMemory（JSON 镜像+PG 双写）抽出纯 PG 记忆模块进链路 B（研究会话）。
 * - 存储：research_memories 表（PG 权威，红线 #6——不写任何 JSON 镜像文件）；
 * - 提取：run 发布后/附答完成后 fire-and-forget（每会话累计 6 条新消息触发一次；
 *   提取失败只记日志，不影响会话主流程）；
 * - 提示词：memory-extraction 模板经注册表解析（P0-6 同链路）；
 * - 注入：后续 run 的综合解释提示词 {{memory}} 占位（≤400 字，prompts.renderPrompt）。
 * 链路 A（/api/ai/chat + aiMemory.ts）保持不动，P2-1 再退役。
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '../db.js'
import { conversationMessages, conversations, researchMemories } from '../models.js'
import type { ResearchMemoryRow } from '../models.js'
import { kv, log } from '../logger.js'
import { resolveLlmClient } from './llm.js'
import { resolvePromptTemplate, renderPrompt } from './prompts.js'

/** 每会话累计多少条新消息触发一次提取（与链路 A 的 EXTRACT_EVERY_MSGS 同值） */
export const EXTRACT_EVERY_MSGS = 6
/** 每用户记忆上限（超出删最旧；与链路 A 的 40 条同值） */
export const MEMORY_CAP = 40
/** 注入提示词的记忆块最大字符数 */
export const MEMORY_BLOCK_MAX_CHARS = 400

const KINDS = ['preference', 'fact', 'interest', 'habit'] as const
type MemoryKind = (typeof KINDS)[number]

export function listResearchMemories(userId: string, limit = MEMORY_CAP): Promise<ResearchMemoryRow[]> {
  return getDb()!
    .select()
    .from(researchMemories)
    .where(eq(researchMemories.userId, userId))
    .orderBy(desc(researchMemories.createdAt))
    .limit(limit)
}

/** {{memory}} 注入块（空记忆返回 ''；调用方拼进综合解释提示词变量） */
export async function memoryBlock(userId: string, maxChars = MEMORY_BLOCK_MAX_CHARS): Promise<string> {
  try {
    const rows = await listResearchMemories(userId, 12)
    if (rows.length === 0) return ''
    const lines: string[] = []
    let used = 0
    for (const r of rows) {
      const line = `- ${r.content}`
      if (used + line.length > maxChars) break
      lines.push(line)
      used += line.length
    }
    return lines.join('\n')
  } catch {
    return '' // 记忆读取失败不阻塞研究
  }
}

/** 并发防护：提取中的会话集合（进程内） */
const extracting = new Set<string>()

/**
 * 会话记忆提取（fire-and-forget）：累计 EXTRACT_EVERY_MSGS 条新消息触发；
 * transcript 取最近 12 条消息；LLM 输出 {add,update,delete} JSON（与链路 A 同协议，
 * update/delete 按 id 修正/移除已有记忆）。任何失败只记日志。
 */
export function maybeExtractMemories(userId: string, conversationId: string): void {
  void (async () => {
    try {
      if (extracting.has(conversationId)) return
      const d = getDb()
      if (!d) return
      const convRows = await d.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conversationId)).limit(1)
      if (convRows.length === 0) return
      const ctx = (convRows[0].context ?? {}) as { memoryExtractedCount?: number }
      const msgRows = await d
        .select({ id: conversationMessages.id, role: conversationMessages.role, content: conversationMessages.content })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(desc(conversationMessages.createdAt))
        .limit(200)
      const total = msgRows.length
      const lastExtracted = typeof ctx.memoryExtractedCount === 'number' ? ctx.memoryExtractedCount : 0
      if (total - lastExtracted < EXTRACT_EVERY_MSGS) return
      extracting.add(conversationId)
      // 先推进水位（失败不重试同一批——宁可少提取不重复提取）
      await d
        .update(conversations)
        .set({ context: { ...ctx, memoryExtractedCount: total }, updatedAt: new Date() } as Record<string, unknown>)
        .where(eq(conversations.id, conversationId))
      const llm = resolveLlmClient()
      if (llm === null) return
      const existing = await listResearchMemories(userId)
      const prompt = await resolvePromptTemplate('memory-extraction')
      const recent = msgRows
        .slice(0, 12)
        .reverse()
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 600)}`)
        .join('\n')
      const raw = await llm.complete({
        system: prompt.content,
        user: `【已有记忆】\n${JSON.stringify(existing.map((m) => ({ id: m.id, kind: m.kind, content: m.content })))}\n\n【最近对话】\n${recent}`,
        maxTokens: 600,
        timeoutMs: 30_000,
      })
      const plan = parsePlan(raw.text)
      if (plan === null) {
        log.warn('memory', '研究记忆提取结果无法解析', kv({ 用户: userId.slice(0, 8), 原文: raw.text.slice(0, 80) }))
        return
      }
      const mine = new Map(existing.map((m) => [m.id, m]))
      let added = 0
      for (const a of plan.add.slice(0, 5)) {
        const kind = (KINDS as readonly string[]).includes(a.kind) ? (a.kind as MemoryKind) : 'fact'
        const content = a.content.trim().slice(0, 200)
        if (content === '' || existing.some((m) => m.content === content)) continue
        await d.insert(researchMemories).values({ userId, kind, content })
        added++
      }
      let updated = 0
      for (const u of plan.update) {
        const target = mine.get(u.id)
        const content = u.content.trim().slice(0, 200)
        if (target === undefined || content === '') continue
        await d.update(researchMemories).set({ content, updatedAt: new Date() }).where(and(eq(researchMemories.id, u.id), eq(researchMemories.userId, userId)))
        updated++
      }
      let removed = 0
      for (const id of plan.delete) {
        if (typeof id !== 'string' || !mine.has(id)) continue
        await d.delete(researchMemories).where(and(eq(researchMemories.id, id), eq(researchMemories.userId, userId)))
        removed++
      }
      // 上限裁剪：超出 MEMORY_CAP 删最旧
      const countRows = await d.execute(sql`select count(*)::int as c from research_memories where user_id = ${userId}`)
      const count = ((Array.isArray(countRows) ? countRows[0] : (countRows as { rows: { c: number }[] }).rows[0])?.c ?? 0) as number
      if (count > MEMORY_CAP) {
        const oldest = await d
          .select({ id: researchMemories.id })
          .from(researchMemories)
          .where(eq(researchMemories.userId, userId))
          .orderBy(researchMemories.createdAt)
          .limit(count - MEMORY_CAP)
        for (const o of oldest) await d.delete(researchMemories).where(eq(researchMemories.id, o.id))
      }
      if (added + updated + removed > 0) {
        log.ok('memory', '研究记忆提取完成', kv({ 用户: userId.slice(0, 8), 会话: conversationId.slice(0, 8), 新增: added, 修正: updated, 移除: removed }))
      }
    } catch (err) {
      log.warn('memory', '研究记忆提取失败（不影响会话主流程）', kv({ 错误: (err as Error).message.slice(0, 120) }))
    } finally {
      extracting.delete(conversationId)
    }
  })()
}

interface ExtractPlan {
  add: { kind: string; content: string }[]
  update: { id: string; content: string }[]
  delete: unknown[]
}

function parsePlan(raw: string): ExtractPlan | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (m === null) return null
  try {
    const parsed = JSON.parse(m[0]) as { add?: unknown; update?: unknown; delete?: unknown }
    return {
      add: Array.isArray(parsed.add)
        ? parsed.add.filter((a): a is { kind: string; content: string } => typeof a === 'object' && a !== null && typeof (a as { content?: unknown }).content === 'string')
        : [],
      update: Array.isArray(parsed.update)
        ? parsed.update.filter((u): u is { id: string; content: string } => typeof u === 'object' && u !== null && typeof (u as { id?: unknown }).id === 'string' && typeof (u as { content?: unknown }).content === 'string')
        : [],
      delete: Array.isArray(parsed.delete) ? parsed.delete : [],
    }
  } catch {
    return null
  }
}

export { renderPrompt }
