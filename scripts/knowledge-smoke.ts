/**
 * 知识库集成 smoke：本地 PostgreSQL（docker compose，127.0.0.1:5434）。
 * 运行：pnpm knowledge:smoke
 *
 * 覆盖（docs/specs/knowledge-rag.md 验收用例的本地可测部分）：
 * 1) 纯函数：chunkBlocks 结构切分 / normalizeQueryTerms 短词归一 / fuseRRF 融合
 * 2) 原生解析：Markdown（标题层级）、HTML（title/heading/figure）
 * 3) 全流程：MD 文档导入（去重）→ processDocument（uploaded→indexed）
 *    → 未发布不参与检索 → publish 生成知识版本 → 检索命中（含页码缺失时的 headingPath）
 * 4) 短词召回：「H2 是什么」经 terms[] GIN 命中（不依赖向量）
 * 5) 引用定位：GET chunk 语义（原文 + 邻接）；重解析后旧版本引用不变（不可变切块）
 * 6) contentHash 重复导入 → duplicate；pgvector/embedding 缺省时显式跳过（parseMeta 记录）
 *
 * 每次运行清理本脚本创建的 smoke-* 文档与知识版本，可重复执行。
 * 不依赖 research-py（用 MD 原生通道）；不依赖外部网络。
 */
import { initDb, getDb, sql } from '../server/src/db.js'
import { chunkBlocks } from '../server/src/knowledge/chunk.js'
import { extractDocTerms, normalizeQueryTerms } from '../server/src/knowledge/terms.js'
import { parseNative } from '../server/src/knowledge/parse.js'
import { fetchCitation, fuseRRF, searchHybrid } from '../server/src/knowledge/retrieval.js'
import { processDocument } from '../server/src/knowledge/pipeline.js'
import { ingestBuffer } from '../server/src/knowledge/ingest.js'
import {
  getDocument,
  latestKnowledgeVersion,
  listChunksOfVersion,
  publishDocument,
  workingVersionId,
} from '../server/src/knowledge/store.js'
import { probeVectorSupport } from '../server/src/knowledge/vector.js'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✔ PASS' : '✖ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// ---- 1) 纯函数 ----
{
  const md = [
    '# Chapter One',
    '',
    'The H2 is the second entry in a bull pullback. Traders wait for the high 2 bar to exceed the prior bar high.',
    '',
    '## Failures',
    '',
    'An H2 in a trading range fails often. Barbwire context makes the second entry unreliable.',
  ].join('\n')
  const blocks = parseNative('md', md).blocks
  check('MD 解析出标题层级', blocks.some((b) => b.kind === 'heading' && b.text === 'Chapter One'))
  const chunks = chunkBlocks(blocks)
  check('切分保留标题路径', chunks.some((c) => c.headingPath.includes('Chapter One')), JSON.stringify(chunks.map((c) => c.headingPath)))

  const { matchedTerms } = normalizeQueryTerms('H2 是什么')
  check('H2 查询归一到规范术语', matchedTerms.includes('h2'), `matched=${matchedTerms.join(',')}`)
  const zhTerms = extractDocTerms('铁丝网形态不交易')
  check('中文 bigram 词项提取', zhTerms.includes('铁丝') && zhTerms.includes('丝网'), zhTerms.slice(0, 6).join(','))

  const fused = fuseRRF([
    [
      { chunkId: 'a', score: 3 },
      { chunkId: 'b', score: 2 },
    ],
    [
      { chunkId: 'b', score: 0.9 },
      { chunkId: 'c', score: 0.8 },
    ],
  ])
  check('RRF 融合双路命中者居首', fused[0].chunkId === 'b', JSON.stringify(fused))
}

const ok = await initDb()
if (!ok) {
  console.error('PostgreSQL 不可用（默认 127.0.0.1:5434；先 docker compose up -d postgres），smoke 无法执行')
  process.exit(1)
}
const db = getDb()!

// 清理旧的 smoke 数据（文档/切块/版本，保留其它资料）
await db.execute(sql`delete from knowledge_chunks where doc_id in (select id from knowledge_documents where title like 'smoke-%')`)
await db.execute(sql`delete from knowledge_documents where title like 'smoke-%'`)
await db.execute(sql`delete from knowledge_versions where note = 'knowledge-smoke'`)
await db.execute(sql`delete from rule_cards where created_by = 'knowledge-smoke'`)
await db.execute(sql`delete from case_windows where created_by = 'knowledge-smoke'`)
await probeVectorSupport(true)

// ---- 2) 导入 + 全流程处理 ----
const mdContent = Buffer.from(
  [
    '# H2 Second Entry',
    '',
    'The H2 (high 2) is the second push up during a pullback in a bull trend. It is the most reliable with-trend entry: wait for a bar whose high exceeds the previous bar high, then enter on a stop above that bar.',
    '',
    '## H2 Failure',
    '',
    'When the market is in barbwire or a tight trading range, an H2 fails often and traders should skip it. Countertrend second entries need strong momentum to work.',
    '',
    '# L2 Short Setup',
    '',
    'The L2 (low 2) mirrors the H2: the second push down in a bear pullback. Sell below the prior bar low with a protective stop above the signal bar.',
  ].join('\n'),
  'utf8',
)

const ingested = await ingestBuffer({
  buffer: mdContent,
  fileName: 'smoke-h2-guide.md',
  title: 'smoke-h2-guide',
  sourceType: 'file',
  sourceTier: 'official_derivative',
})
check('导入建档成功', !!ingested.docId, JSON.stringify(ingested))
// smoke 环境无队列消费进程：直接同步处理（app 内由 worker 消费同一函数）
await processDocument(ingested.docId)
const doc1 = await getDocument(ingested.docId)
check('处理到 indexed', doc1?.status === 'indexed', `status=${doc1?.status} error=${doc1?.error ?? ''}`)
check(
  'embedding 缺省时显式跳过记录',
  doc1 !== null && (doc1.parseMeta.embeddingSkipped === true || doc1.parseMeta.embedded !== undefined),
  JSON.stringify(doc1?.parseMeta),
)

// ---- 3) 未发布不参与检索 ----
{
  const before = await searchHybrid('H2 second entry')
  check('未发布文档不可见', !before.hits.some((h) => h.chunk.docId === ingested.docId), `hits=${before.hits.length}`)
}

// ---- 4) 发布 + 检索命中 ----
const pub = await publishDocument(ingested.docId, 'knowledge-smoke', 'smoke')
check('发布生成知识版本', pub.knowledgeVersion.docVersionIds.includes(`${ingested.docId}#1`), pub.knowledgeVersion.label)
check('文档状态 published + version=1', pub.doc.status === 'published' && pub.doc.version === 1)

{
  const outcome = await searchHybrid('H2 是什么')
  check('「H2 是什么」词项召回命中', outcome.hits.some((h) => h.chunk.docId === ingested.docId), `hits=${outcome.hits.length}`)
  check('命中含文档标题与切片', outcome.hits.every((h) => h.docTitle !== '' && h.chunk.text !== ''))
  check('调试打点含词项命中', outcome.debug.termHits.length > 0, `termHits=${outcome.debug.termHits.length}`)
  check('调试结构完整（adjacencyNotes 存在）', Array.isArray(outcome.debug.adjacencyNotes))
}

{
  const outcome = await searchHybrid('H2 fails in barbwire', { mode: 'counter' })
  check('反证模式命中失败语境', outcome.hits.length > 0 && outcome.hits.some((h) => /barbwire|fails/i.test(h.chunk.text)))
}

// ---- 5) 引用定位与不可变 ----
{
  const chunks = await listChunksOfVersion(`${ingested.docId}#1`)
  const target = chunks.find((c) => /second push up/i.test(c.text)) ?? chunks[0]
  check('切块存在（可定位引用）', target !== undefined)
  if (target === undefined) {
    console.log('✖ FAIL 后续引用断言跳过（无切块）')
    failures++
  } else {
  const citation = await fetchCitation(target.id)
  check('引用定位返回原文与文档', citation !== null && citation.docTitle === 'smoke-h2-guide')
  check('引用含标题路径', (citation?.chunk.headingPath.length ?? 0) > 0)

  // 重解析生成新工作版本 → 已发布 #1 切块不变
  await processDocument(ingested.docId)
  const after = await fetchCitation(target.id)
  check('发布后重解析不影响旧引用', after?.chunk.id === target.id && after?.chunk.contentHash === citation?.chunk.contentHash)
  const docAfter = await getDocument(ingested.docId)
  check('重解析后回到 indexed（工作版本 #2）', docAfter?.status === 'indexed', `status=${docAfter?.status}`)
  const workChunks = await listChunksOfVersion(workingVersionId(docAfter!))
  check('工作版本切块已重建', workChunks.length === chunks.length)
  }

  // 检索仍命中已发布 #1（工作版本 #2 不可见）
  const outcome = await searchHybrid('H2 second entry')
  check('检索只命中已发布版本（工作版本 #2 不可见）', outcome.hits.every((h) => h.chunk.docVersionId !== `${ingested.docId}#2`))
}

// ---- 6) 重复导入 ----
{
  const dup = await ingestBuffer({
    buffer: mdContent,
    fileName: 'smoke-h2-copy.md',
    title: 'smoke-h2-copy',
    sourceType: 'file',
  })
  check('contentHash 重复导入被识别', dup.status === 'duplicate' && dup.existingId === ingested.docId)
  const dupDoc = await getDocument(dup.docId)
  check('重复导入不新建文档', dupDoc?.title === 'smoke-h2-guide')
}

// ---- 7) 知识版本累积（第二份文档发布后包含两份） ----
{
  const html = Buffer.from(
    '<html><head><title>L2 Guide</title></head><body><h1>L2 low 2</h1><p>The L2 is the second entry short in a bear flag.</p><img src="chart.png" alt="L2 example chart"/></body></html>',
    'utf8',
  )
  const ing2 = await ingestBuffer({ buffer: html, fileName: 'smoke-l2.html', title: 'smoke-l2', sourceType: 'file' })
  await processDocument(ing2.docId)
  const parsed = parseNative('html', html.toString('utf8'))
  check('HTML 解析出标题与图', parsed.title === 'L2 Guide' && parsed.blocks.some((b) => b.kind === 'figure'))
  const pub2 = await publishDocument(ing2.docId, 'knowledge-smoke', 'smoke')
  check(
    '知识版本累积包含两份文档',
    pub2.knowledgeVersion.docVersionIds.includes(`${ingested.docId}#1`) && pub2.knowledgeVersion.docVersionIds.includes(`${ing2.docId}#1`),
    pub2.knowledgeVersion.label,
  )
  const latest = await latestKnowledgeVersion()
  check('最新版本即刚发布版本', latest?.id === pub2.knowledgeVersion.id)
}


// ---- 8) 规则卡层：草拟（模板）→ 占位拒绝发布 → 补全 → 发布 → 检索命中 ----
{
  const { draftRuleCard, getRuleCard, updateRuleCardDraft, publishRuleCard, deleteRuleCardDraft } = await import('../server/src/knowledge/ruleCards.js')
  const draft = await draftRuleCard('h2', 'knowledge-smoke')
  check('规则卡草拟（模板，chat 未配置）', draft.card.status === 'draft' && draft.card.draftedBy === 'template', `证据 ${draft.evidenceCount}`)
  let placeholderRejected = false
  try {
    await publishRuleCard(draft.card.id)
  } catch (e) {
    placeholderRejected = (e as Error).message.includes('待人工补全')
  }
  check('含「待人工补全」占位时发布被拒', placeholderRejected)
  await updateRuleCardDraft(draft.card.id, {
    definition: 'H2 是多头回调中第二次上推（二次进场），最可靠的顺势进场点。',
    conditions: ['回调处于多头趋势', '第二次上破前根高点'],
    context: '趋势中的回调；交易区间内不可靠',
    invalidation: '跌破回调起点或出现反向 MTR',
    confusable: ['H1', 'L2'],
    counterExamples: ['铁丝网中的 H2 常失败'],
    ruleId: 'hl_count',
    sourceNote: '人工补全',
  })
  const published = await publishRuleCard(draft.card.id)
  check('补全后发布成功（v1 published）', published.status === 'published' && published.version === 1)
  let publishedImmutable = false
  try {
    await updateRuleCardDraft(published.id, {
      definition: 'x', conditions: [], context: '', invalidation: '', confusable: [], counterExamples: [], ruleId: '', sourceNote: '',
    })
  } catch (e) {
    publishedImmutable = (e as Error).message.includes('不可编辑')
  }
  check('已发布规则卡不可编辑', publishedImmutable)

  const outcome = await searchHybrid('H2 second entry 是什么')
  const cardHit = outcome.hits.find((h) => h.chunk.id.startsWith('rulecard:'))
  check('规则卡进入检索命中', cardHit !== undefined && cardHit.docTitle.startsWith('规则卡：h2'), cardHit?.docTitle ?? '未命中')
  const { fetchCitation } = await import('../server/src/knowledge/retrieval.js')
  const citation = cardHit ? await fetchCitation(cardHit.chunk.id) : null
  check('规则卡引用定位', citation !== null && citation.docTitle.includes('h2'))

  // 草稿不可见：再草拟一张不发布 → 检索不命中
  const draft2 = await draftRuleCard('barbwire', 'knowledge-smoke')
  const outcome2 = await searchHybrid('barbwire 铁丝网')
  check('未发布规则卡不参与检索', !outcome2.hits.some((h) => h.chunk.id === `rulecard:${draft2.card.id}`))
  await deleteRuleCardDraft(draft2.card.id)
}

// ---- 9) 案例层：构建 → 可见/结果分列 → 发布 → 检索只见可见字段 ----
{
  const { buildCaseWindow, setCasePublished } = await import('../server/src/knowledge/ruleCards.js')
  const cw = await buildCaseWindow(
    { symbol: 'BTCUSDT', marketType: 'usdm_perp', interval: '15m', lookback: 120, forwardBars: 8, annotation: '多头回调 H2 二次进场案例' },
    'knowledge-smoke',
  )
  const vc = cw.visibleContext as Record<string, unknown>
  check('案例可见上下文含结构（无 outcome 字段）', typeof vc.regime === 'string' && !('returnPct' in vc) && !('direction' in vc), `regime=${vc.regime}`)
  const oc = cw.outcome as Record<string, unknown>
  check('案例未来结果单独存储', typeof oc.returnPct === 'number' && typeof oc.direction === 'string', `${oc.direction} ${oc.returnPct}%`)
  check('案例默认未发布', cw.published === false)

  const beforePublish = await searchHybrid('BTCUSDT 案例')
  check('未发布案例不参与检索', !beforePublish.hits.some((h) => h.chunk.id === `case:${cw.id}`))
  await setCasePublished(cw.id, true)
  const afterPublish = await searchHybrid('BTCUSDT 案例')
  const caseHit = afterPublish.hits.find((h) => h.chunk.id === `case:${cw.id}`)
  check('发布案例进入检索（只见可见字段）', caseHit !== undefined && !JSON.stringify(caseHit.chunk).includes('returnPct'), caseHit?.docTitle ?? '未命中')
}

// ---- 清理 ----
await db.execute(sql`delete from knowledge_chunks where doc_id in (select id from knowledge_documents where title like 'smoke-%')`)
await db.execute(sql`delete from knowledge_documents where title like 'smoke-%'`)
await db.execute(sql`delete from knowledge_versions where note = 'knowledge-smoke'`)
await db.execute(sql`delete from rule_cards where created_by = 'knowledge-smoke'`)
await db.execute(sql`delete from case_windows where created_by = 'knowledge-smoke'`)

console.log(failures === 0 ? '\n全部通过 ✔' : `\n失败 ${failures} 项 ✖`)
process.exit(failures === 0 ? 0 : 1)
