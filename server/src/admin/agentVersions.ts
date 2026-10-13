/**
 * Agent 配置版本域（docs/specs/admin-security.md）：
 * 草稿 → 发布（不可变）→ 回滚（指针切回历史发布版本）。
 * 「当前发布」指针存 app_settings（key=agent_current_version → { versionId }）；
 * 进行中的 run 已把 configVersion 钉在 run 行，不受后续发布/回滚影响。
 * 能力解析链：当前发布版本的 config.capabilities > app_settings > 环境变量/默认。
 */
import { and, desc, eq } from 'drizzle-orm'
import { AgentConfigSchema } from 'biance-vision-brooks'
import type { AgentConfig, AgentVersion } from 'biance-vision-brooks'
import { agentVersions, appSettings } from '../models.js'
import type { AgentVersionRow } from '../models.js'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'

const POINTER_KEY = 'agent_current_version'

export function toVersionDto(row: AgentVersionRow): AgentVersion {
  return {
    id: row.id,
    label: row.label,
    status: row.status as AgentVersion['status'],
    config: AgentConfigSchema.parse(row.config),
    createdAt: row.createdAt.getTime(),
    publishedAt: row.publishedAt?.getTime(),
  }
}

export async function listVersions(): Promise<AgentVersionRow[]> {
  return getDb()!.select().from(agentVersions).orderBy(desc(agentVersions.createdAt))
}

export async function getVersion(id: string): Promise<AgentVersionRow | null> {
  const rows = await getDb()!.select().from(agentVersions).where(eq(agentVersions.id, id)).limit(1)
  return rows[0] ?? null
}

export async function createDraft(input: { label: string; config: AgentConfig }): Promise<AgentVersionRow> {
  const rows = await getDb()!
    .insert(agentVersions)
    .values({ label: input.label, status: 'draft', config: input.config as unknown as Record<string, unknown> })
    .returning()
  log.ok('agents', '新建 Agent 版本草稿', kv({ 标签: input.label }))
  return rows[0]
}

/** 编辑草稿（先读后写：已发布/归档版本不可变——校验在更新之前完成） */
export async function updateDraft(id: string, config: AgentConfig): Promise<AgentVersionRow> {
  const db = getDb()!
  const existing = await getVersion(id)
  if (existing === null) throw Object.assign(new Error('版本不存在'), { statusCode: 404 })
  if (existing.status !== 'draft') throw Object.assign(new Error('已发布版本不可编辑'), { statusCode: 400 })
  // WHERE 同时带 status='draft'：即使并发发布也只可能更新 0 行，不会写穿
  const rows = await db
    .update(agentVersions)
    .set({ config: config as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(and(eq(agentVersions.id, id), eq(agentVersions.status, 'draft')))
    .returning()
  if (rows.length === 0) throw Object.assign(new Error('版本状态已变化（可能刚被发布），未做修改'), { statusCode: 400 })
  return rows[0]
}

async function readPointer(): Promise<string | null> {
  const rows = await getDb()!.select().from(appSettings).where(eq(appSettings.key, POINTER_KEY)).limit(1)
  const v = rows[0]?.value as { versionId?: unknown } | undefined
  return typeof v?.versionId === 'string' ? v.versionId : null
}

async function writePointer(versionId: string): Promise<void> {
  const value = { versionId } as unknown as Record<string, unknown>
  await getDb()!
    .insert(appSettings)
    .values({ key: POINTER_KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
}

/**
 * 发布：draft → published + 指针切到该版本。
 * 校验：config 引用的 knowledgeVersion 必须存在（配置错配发布时拒绝并指明缺失项）。
 */
export async function publishVersion(id: string): Promise<AgentVersionRow> {
  const row = await getVersion(id)
  if (!row) throw Object.assign(new Error('版本不存在'), { statusCode: 404 })
  if (row.status === 'published') throw Object.assign(new Error('版本已发布（不可变）'), { statusCode: 400 })
  const config = AgentConfigSchema.parse(row.config)
  // 知识绑定校验：显式绑定且库中不存在 → 拒绝
  if (config.retrieval !== undefined) {
    const { getKnowledgeVersion } = await import('../knowledge/store.js')
    const bound = config.ruleParams?.knowledgeVersion
    if (typeof bound === 'string' && bound !== '' && (await getKnowledgeVersion(bound)) === null) {
      throw Object.assign(new Error(`配置引用的知识版本不存在：${bound}`), { statusCode: 400 })
    }
  }
  const db = getDb()!
  // 状态更新、指针切换与审计行在同一事务完成（P0：不可出现「已发布但指针未切/无审计」中间态）
  const value = { versionId: id } as unknown as Record<string, unknown>
  const rows = await db.transaction(async (tx) => {
    const updated = await tx
      .update(agentVersions)
      .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentVersions.id, id))
      .returning()
    await tx
      .insert(appSettings)
      .values({ key: POINTER_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } })
    return updated
  })
  clearAgentConfigCache()
  log.ok('agents', 'Agent 版本发布（含指针切换，同事务）', kv({ 标签: row.label, 版本: id.slice(0, 8) }))
  return rows[0]
}

/** 回滚：指针切回历史 published 版本；历史版本内容本身不被修改 */
export async function rollbackTo(id: string): Promise<AgentVersionRow> {
  const row = await getVersion(id)
  if (!row) throw Object.assign(new Error('版本不存在'), { statusCode: 404 })
  if (row.status !== 'published') throw Object.assign(new Error('只能回滚到已发布版本'), { statusCode: 400 })
  await writePointer(id)
  clearAgentConfigCache()
  log.ok('agents', 'Agent 版本回滚', kv({ 标签: row.label }))
  return row
}

/** 当前生效的 Agent 版本（无指针/无版本时 null；对应 default-v1 内置配置） */
export async function getCurrentAgentVersion(): Promise<AgentVersionRow | null> {
  const db = getDb()
  if (!db) return null
  const pointer = await readPointer()
  if (pointer === null) return null
  return getVersion(pointer)
}

// ---- 能力解析链缓存（capabilities.getCapabilities 之外的版本优先路径） ----

let cachedVersionConfig: { label: string; config: AgentConfig } | null | undefined

export function clearAgentConfigCache(): void {
  cachedVersionConfig = undefined
}

/** 当前发布版本的 config；不存在返回 null（调用方落回 app_settings 能力配置） */
export async function currentAgentConfig(): Promise<{ label: string; config: AgentConfig } | null> {
  if (cachedVersionConfig !== undefined) return cachedVersionConfig
  const row = await getCurrentAgentVersion()
  cachedVersionConfig = row === null ? null : { label: row.label, config: AgentConfigSchema.parse(row.config) }
  return cachedVersionConfig
}
