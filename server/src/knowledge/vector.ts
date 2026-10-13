/**
 * pgvector 支持探测：embedding 列由迁移里的守卫式 DDL 按需补建
 * （无扩展/无权限环境自动跳过）。此处运行时探测一次并缓存：
 * - enabled：knowledge_chunks.embedding 可用，向量召回走 pgvector
 * - disabled：向量召回显式禁用（检索层记录跳过原因，不报错）
 */
import { sql } from 'drizzle-orm'
import { getDb } from '../db.js'
import { log } from '../logger.js'

export type VectorSupport = 'enabled' | 'disabled'

let probed: VectorSupport | null = null
let probeNote = '尚未探测'

export async function probeVectorSupport(force = false): Promise<VectorSupport> {
  if (probed !== null && !force) return probed
  const db = getDb()
  if (!db) {
    probed = 'disabled'
    probeNote = '数据库不可用'
    return probed
  }
  try {
    const res = (await db.execute(sql`
      select count(*)::int as n from information_schema.columns
      where table_name = 'knowledge_chunks' and column_name = 'embedding'`)) as unknown as
      | { n: number }[]
      | { rows: { n: number }[] }
    const rows = Array.isArray(res) ? res : res.rows
    probed = (rows[0]?.n ?? 0) > 0 ? 'enabled' : 'disabled'
    probeNote =
      probed === 'enabled'
        ? 'pgvector 已启用'
        : 'knowledge_chunks.embedding 列不存在（镜像无 pgvector 或迁移守卫跳过）'
  } catch (err) {
    probed = 'disabled'
    probeNote = `探测失败：${(err as Error).message}`
  }
  if (probed === 'disabled') log.info('knowledge', `向量召回禁用：${probeNote}`)
  return probed
}

/** 同步读缓存结果（未探测过时按 disabled 处理，避免阻塞请求路径） */
export function vectorSupportSync(): VectorSupport {
  return probed ?? 'disabled'
}

export function resetVectorProbe(): void {
  probed = null
}

/** 调试/状态展示用 */
export function vectorStatus(): { support: VectorSupport; note: string } {
  return { support: vectorSupportSync(), note: probeNote }
}
