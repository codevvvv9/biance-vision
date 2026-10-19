/**
 * 提示词模板版本域（P0-6，复用 agentVersions 生命周期模式）：
 * 草稿 → 发布（不可变，同事务：旧 published 归档 retired + 指针切换）→ 回滚（指针切回）。
 * published 行永久保留可解析；run 冻结引用具体 templateId+version，与「当前生效」无关。
 */
import { and, desc, eq } from 'drizzle-orm'
import { promptTemplates, promptTemplatePointers } from '../models.js'
import type { PromptTemplateRow } from '../models.js'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'
import { PROMPT_NAMES } from '../research/prompts.js'
import type { PromptName } from '../research/prompts.js'
import { writePromptPointer, nextPromptVersion } from '../research/prompts.js'

export interface PromptTemplateDto {
  id: string
  name: string
  scene: string
  status: 'draft' | 'published' | 'retired'
  version: number
  content: string
  note: string
  publishedAt: number | null
  createdAt: number
}

export function toDto(row: PromptTemplateRow): PromptTemplateDto {
  return {
    id: row.id,
    name: row.name,
    scene: row.scene,
    status: row.status as PromptTemplateDto['status'],
    version: row.version,
    content: row.content,
    note: row.note,
    publishedAt: row.publishedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  }
}

function normScene(scene: string | undefined | null): string {
  return (scene ?? '').trim()
}

export function assertPromptName(name: string): PromptName {
  if (!(PROMPT_NAMES as readonly string[]).includes(name)) {
    throw Object.assign(new Error(`未知模板名：${name}（可选：${PROMPT_NAMES.join(' / ')}）`), { statusCode: 400 })
  }
  return name as PromptName
}

export async function listTemplates(name?: string, scene?: string): Promise<PromptTemplateRow[]> {
  const conds = []
  if (name !== undefined && name !== '') conds.push(eq(promptTemplates.name, name))
  const sc = normScene(scene)
  if (scene !== undefined && scene !== '') conds.push(eq(promptTemplates.scene, sc))
  const q = getDb()!.select().from(promptTemplates)
  return conds.length > 0 ? q.where(and(...conds)).orderBy(desc(promptTemplates.version)) : q.orderBy(desc(promptTemplates.createdAt))
}

export async function getTemplate(id: string): Promise<PromptTemplateRow | null> {
  const rows = await getDb()!.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1)
  return rows[0] ?? null
}

/** 新建草稿：同 (name,scene) 内 version 递增 */
export async function createDraft(input: { name: string; scene?: string | null; content: string; note?: string; createdBy: string }): Promise<PromptTemplateRow> {
  const name = assertPromptName(input.name)
  const scene = normScene(input.scene)
  const content = input.content.trim()
  if (content.length === 0 || content.length > 20_000) {
    throw Object.assign(new Error('模板内容须为 1-20000 字'), { statusCode: 400 })
  }
  const version = await nextPromptVersion(name, scene)
  const rows = await getDb()!
    .insert(promptTemplates)
    .values({ name, scene, status: 'draft', version, content, note: input.note?.slice(0, 500) ?? '', createdBy: input.createdBy })
    .returning()
  log.ok('prompts', '新建提示词草稿', kv({ 模板: name, 场景: scene || '全局', 版本: version }))
  return rows[0]
}

/** 编辑草稿（published/retired 不可变：先读后写 + WHERE status='draft' 防写穿） */
export async function updateDraft(id: string, patch: { content?: string; note?: string }): Promise<PromptTemplateRow> {
  const db = getDb()!
  const existing = await getTemplate(id)
  if (existing === null) throw Object.assign(new Error('模板不存在'), { statusCode: 404 })
  if (existing.status !== 'draft') throw Object.assign(new Error('已发布模板不可编辑（发布新版本=新建草稿→发布）'), { statusCode: 400 })
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.content !== undefined) {
    const content = patch.content.trim()
    if (content.length === 0 || content.length > 20_000) throw Object.assign(new Error('模板内容须为 1-20000 字'), { statusCode: 400 })
    set.content = content
  }
  if (patch.note !== undefined) set.note = patch.note.slice(0, 500)
  const rows = await db
    .update(promptTemplates)
    .set(set)
    .where(and(eq(promptTemplates.id, id), eq(promptTemplates.status, 'draft')))
    .returning()
  if (rows.length === 0) throw Object.assign(new Error('模板状态已变化（可能刚被发布），未做修改'), { statusCode: 400 })
  return rows[0]
}

/** 发布：draft→published + 同 (name,scene) 旧 published 归档 retired + 指针切换（同一事务） */
export async function publishTemplate(id: string): Promise<PromptTemplateRow> {
  const db = getDb()!
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1)
    const row = rows[0]
    if (row === undefined) throw Object.assign(new Error('模板不存在'), { statusCode: 404 })
    if (row.status !== 'draft') throw Object.assign(new Error('仅草稿可发布'), { statusCode: 400 })
    // 旧 published 不归档（永久保留可解析；生效由指针唯一决定）——归档会让 rollback 的
    // 「只能回滚到已发布版本」永远失败（e2e 实测死锁），retired 保留给未来显式下线
    const updated = await tx
      .update(promptTemplates)
      .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(promptTemplates.id, id), eq(promptTemplates.status, 'draft')))
      .returning()
    if (updated.length === 0) throw Object.assign(new Error('发布冲突（状态已变化）'), { statusCode: 400 })
    await tx
      .insert(promptTemplatePointers)
      .values({ name: row.name, scene: row.scene, publishedId: id })
      .onConflictDoUpdate({
        target: [promptTemplatePointers.name, promptTemplatePointers.scene],
        set: { publishedId: id, updatedAt: new Date() },
      })
    log.ok('prompts', '提示词发布（含指针切换，同事务）', kv({ 模板: row.name, 场景: row.scene || '全局', 版本: row.version }))
    return updated[0]
  })
}

/** 回滚：指针切回历史版本（published/retired 皆可——发布不归档，但兼容历史归档行）；
 * retired 目标置回 published（同事务），版本内容不被修改 */
export async function rollbackTo(id: string): Promise<PromptTemplateRow> {
  const db = getDb()!
  const row = await getTemplate(id)
  if (row === null) throw Object.assign(new Error('模板不存在'), { statusCode: 404 })
  if (row.status !== 'published' && row.status !== 'retired') throw Object.assign(new Error('只能回滚到已发布/历史版本（草稿不可）'), { statusCode: 400 })
  const updated = await db.transaction(async (tx) => {
    if (row.status === 'retired') {
      await tx.update(promptTemplates).set({ status: 'published', updatedAt: new Date() }).where(eq(promptTemplates.id, id))
    }
    await tx
      .insert(promptTemplatePointers)
      .values({ name: row.name, scene: row.scene, publishedId: id })
      .onConflictDoUpdate({ target: [promptTemplatePointers.name, promptTemplatePointers.scene], set: { publishedId: id, updatedAt: new Date() } })
    const rows = await tx.select().from(promptTemplates).where(eq(promptTemplates.id, id)).limit(1)
    return rows[0]
  })
  log.ok('prompts', '提示词回滚', kv({ 模板: row.name, 场景: row.scene || '全局', 版本: row.version }))
  return updated
}

/** 当前生效指针（name+scene → publishedId） */
export async function currentPointers(): Promise<{ name: string; scene: string; publishedId: string }[]> {
  return getDb()!.select({ name: promptTemplatePointers.name, scene: promptTemplatePointers.scene, publishedId: promptTemplatePointers.publishedId }).from(promptTemplatePointers)
}
