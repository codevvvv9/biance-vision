/**
 * 向量召回链路 smoke：验证 embedding 写入 → pgvector 向量召回 → RRF 融合全链路。
 * 运行：pnpm vector:smoke
 *
 * 前置：
 * - PostgreSQL 为 pgvector 镜像且 vector 扩展已建（探测 disabled 时输出 SKIP 并退出 0）
 * - embedding 能力可用：EMBEDDING_BASE_URL / EMBEDDING_MODEL（+ EMBEDDING_API_KEY），
 *   或 Admin 能力配置；离线验证可用 `node scripts/mock-embeddings.mjs`（词袋向量，
 *   语义≈词重叠，仅验证管线，不代表真实语义检索质量）
 */
import { initDb, getDb, sql } from '../server/src/db.js'
import { processDocument } from '../server/src/knowledge/pipeline.js'
import { ingestBuffer } from '../server/src/knowledge/ingest.js'
import { publishDocument } from '../server/src/knowledge/store.js'
import { searchHybrid } from '../server/src/knowledge/retrieval.js'
import { probeVectorSupport } from '../server/src/knowledge/vector.js'
import { resolveEmbeddingClient } from '../server/src/knowledge/embeddings.js'
import { getCapabilities, refreshCapabilities } from '../server/src/admin/capabilities.js'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✔ PASS' : '✖ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const ok = await initDb()
if (!ok) {
  console.error('PostgreSQL 不可用（先 docker compose up -d postgres），smoke 无法执行')
  process.exit(1)
}
const support = await probeVectorSupport(true)
if (support !== 'enabled') {
  console.log(`SKIP：pgvector 未启用（${support}）。切 pgvector 镜像并 CREATE EXTENSION vector 后重跑。`)
  process.exit(0)
}
await refreshCapabilities()
const embedder = resolveEmbeddingClient(getCapabilities().embedding)
if (!embedder) {
  console.log('SKIP：embedding 能力未配置。设 EMBEDDING_BASE_URL / EMBEDDING_MODEL（离线可用 node scripts/mock-embeddings.mjs）后重跑。')
  process.exit(0)
}

const db = getDb()!
await db.execute(sql`delete from knowledge_chunks where doc_id in (select id from knowledge_documents where title like 'vsmoke-%')`)
await db.execute(sql`delete from knowledge_documents where title like 'vsmoke-%'`)
await db.execute(sql`delete from knowledge_versions where note = 'vsmoke'`)

// 1) 导入双语文档 → 解析切分 → embedding 写入
const md = Buffer.from(
  [
    '# Second Entry in a Pullback',
    '',
    'The second push up during a pullback in a bull trend is the classic with-trend buy. Wait for a bar whose high exceeds the prior bar high, then place a buy stop above it. 回调中第二次上破是顺势买入的经典时机：等一根高点超过前一根高点的 bar，在其上方挂止损单进场。',
    '',
    '## When It Fails',
    '',
    'Inside a tight trading range or barbwire, the second push up fails often and traders should stand aside. 在紧凑区间或铁丝网里，第二次上破经常失败，应当观望。',
  ].join('\n'),
  'utf8',
)
const ing = await ingestBuffer({ buffer: md, fileName: 'vsmoke-entry.md', title: 'vsmoke-second-entry', sourceType: 'file' })
await processDocument(ing.docId)
{
  const expectedDims = getCapabilities().embedding.dims ?? 1536
  const rows = await db.execute(
    sql`select count(*)::int as n, max(vector_dims(embedding))::int as dims from knowledge_chunks where doc_id = ${ing.docId} and embedding is not null`,
  )
  const list = rows as unknown as { n: number; dims: number }[] | { rows: { n: number; dims: number }[] }
  const r = (Array.isArray(list) ? list : list.rows)[0]
  check(`切块向量已写入（${expectedDims} 维）`, (r?.n ?? 0) > 0 && r?.dims === expectedDims, `rows=${r?.n} dims=${r?.dims}`)
}

// 2) 发布 → 自然语言查询（不含精确术语别名，词项与向量双路召回）
await publishDocument(ing.docId, 'vsmoke', 'vsmoke')
{
  const outcome = await searchHybrid('is the second push up during a pullback reliable', { finalLimit: 5 })
  check('向量召回命中（vectorHits > 0）', outcome.debug.vectorHits.length > 0, `vectorHits=${outcome.debug.vectorHits.length}`)
  check('RRF 融合包含向量结果', outcome.debug.fused.some((f) => outcome.debug.vectorHits.some((v) => v.chunkId === f.chunkId)))
  check('最终命中目标文档', outcome.hits.some((h) => h.chunk.docId === ing.docId), `hits=${outcome.hits.length}`)
  check('向量召回未被跳过', !outcome.debug.notes.some((n) => n.includes('向量召回跳过') || n.includes('pgvector 未启用')), outcome.debug.notes.join('；'))
}
{
  const outcome = await searchHybrid('铁丝网里第二次上破还能做吗', { mode: 'counter', finalLimit: 5 })
  check('中文反证查询命中（词项+向量）', outcome.hits.length > 0 && outcome.hits.some((h) => /barbwire|铁丝网/i.test(h.chunk.text) || /观望|fails/.test(h.chunk.text)))
}

// 清理
await db.execute(sql`delete from knowledge_chunks where doc_id in (select id from knowledge_documents where title like 'vsmoke-%')`)
await db.execute(sql`delete from knowledge_documents where title like 'vsmoke-%'`)
await db.execute(sql`delete from knowledge_versions where note = 'vsmoke'`)

console.log(failures === 0 ? '\n向量链路全部通过 ✔' : `\n失败 ${failures} 项 ✖`)
process.exit(failures === 0 ? 0 : 1)
