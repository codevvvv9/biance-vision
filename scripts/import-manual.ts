/** 把仓库内 Brooks 手册导入知识库并发布（一次性引导；正式入口是 /admin/knowledge 页面） */
import { readFile } from 'node:fs/promises'
import { initDb, getDb, sql } from '../server/src/db.js'
import { ingestBuffer } from '../server/src/knowledge/ingest.js'
import { processDocument } from '../server/src/knowledge/pipeline.js'
import { publishDocument } from '../server/src/knowledge/store.js'
import { refreshCapabilities } from '../server/src/admin/capabilities.js'

const ok = await initDb()
if (!ok) { console.error('PG 不可用'); process.exit(1) }
await refreshCapabilities()
const db = getDb()!
const existing = await db.execute(sql`select id from knowledge_documents where title = 'Brooks 价格行为交易手册' limit 1`)
const rows = Array.isArray(existing) ? existing : (existing as unknown as { rows: { id: string }[] }).rows
if (rows.length > 0) {
  console.log('手册已存在，跳过导入（如需更新请在 /admin/knowledge 重新上传后 reparse+publish）')
  process.exit(0)
}
const md = await readFile('docs/brooks-price-action-manual.md', 'utf8')
const ing = await ingestBuffer({
  buffer: Buffer.from(md, 'utf8'),
  fileName: 'brooks-price-action-manual.md',
  title: 'Brooks 价格行为交易手册',
  sourceType: 'file',
  sourceTier: 'official_derivative',
})
await processDocument(ing.docId)
const pub = await publishDocument(ing.docId, '仓库手册导入（理论关联链路资料）', 'system')
console.log('已发布：', pub.doc.title, '知识版本', pub.knowledgeVersion.label, '文档版本数', pub.knowledgeVersion.docVersionIds.length)
process.exit(0)
