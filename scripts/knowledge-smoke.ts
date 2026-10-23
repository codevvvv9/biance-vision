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
 * 11) W2 第三批：上传预检（findDocumentByContentHash）/ 清单条目状态（sync 入库+状态保留）/
 *     证据源投影（fileUrl/docUpdated 双侧：公开/受限/重发布/清除/归档/无文件/规则卡）
 *
 * 每次运行清理本脚本创建的 smoke-* 文档与知识版本，可重复执行。
 * 不依赖 research-py（用 MD 原生通道）；不依赖外部网络。
 */
import { initDb, getDb, sql } from '../server/src/db.js'
import { chunkBlocks } from '../server/src/knowledge/chunk.js'
import { extractDocTerms, normalizeQueryTerms } from '../server/src/knowledge/terms.js'
import { parseNative } from '../server/src/knowledge/parse.js'
import { fetchCitation, fuseRRF, searchHybrid } from '../server/src/knowledge/retrieval.js'
import { ADMIN_VIEWER } from '../server/src/knowledge/access.js'
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
  const before = await searchHybrid('H2 second entry', { access: ADMIN_VIEWER })
  check('未发布文档不可见', !before.hits.some((h) => h.chunk.docId === ingested.docId), `hits=${before.hits.length}`)
}

// ---- 4) 发布 + 检索命中 ----
const pub = await publishDocument(ingested.docId, 'knowledge-smoke', 'smoke')
check('发布生成知识版本', pub.knowledgeVersion.docVersionIds.includes(`${ingested.docId}#1`), pub.knowledgeVersion.label)
check('文档状态 published + version=1', pub.doc.status === 'published' && pub.doc.version === 1)

{
  const outcome = await searchHybrid('H2 是什么', { access: ADMIN_VIEWER })
  check('「H2 是什么」词项召回命中', outcome.hits.some((h) => h.chunk.docId === ingested.docId), `hits=${outcome.hits.length}`)
  check('命中含文档标题与切片', outcome.hits.every((h) => h.docTitle !== '' && h.chunk.text !== ''))
  check('调试打点含词项命中', outcome.debug.termHits.length > 0, `termHits=${outcome.debug.termHits.length}`)
  check('调试结构完整（adjacencyNotes 存在）', Array.isArray(outcome.debug.adjacencyNotes))
}

{
  const outcome = await searchHybrid('H2 fails in barbwire', { mode: 'counter', access: ADMIN_VIEWER })
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
  const citation = await fetchCitation(target.id, { access: ADMIN_VIEWER })
  check('引用定位返回原文与文档', citation !== null && citation.docTitle === 'smoke-h2-guide')
  check('引用含标题路径', (citation?.chunk.headingPath.length ?? 0) > 0)

  // 重解析生成新工作版本 → 已发布 #1 切块不变
  await processDocument(ingested.docId)
  const after = await fetchCitation(target.id, { access: ADMIN_VIEWER })
  check('发布后重解析不影响旧引用', after?.chunk.id === target.id && after?.chunk.contentHash === citation?.chunk.contentHash)
  const docAfter = await getDocument(ingested.docId)
  check('重解析后回到 indexed（工作版本 #2）', docAfter?.status === 'indexed', `status=${docAfter?.status}`)
  const workChunks = await listChunksOfVersion(workingVersionId(docAfter!))
  check('工作版本切块已重建', workChunks.length === chunks.length)
  }

  // 检索仍命中已发布 #1（工作版本 #2 不可见）
  const outcome = await searchHybrid('H2 second entry', { access: ADMIN_VIEWER })
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


// ---- 8) 规则卡层：草拟（chat 未配置=模板占位 / 已配置=LLM）→ 发布 → 检索命中 ----
{
  const { draftRuleCard, getRuleCard, updateRuleCardDraft, publishRuleCard, deleteRuleCardDraft } = await import('../server/src/knowledge/ruleCards.js')
  const draft = await draftRuleCard('h2', 'knowledge-smoke')
  check(
    '规则卡草拟（template|llm，随 chat 配置）',
    draft.card.status === 'draft' && (draft.card.draftedBy === 'template' || draft.card.draftedBy === 'llm'),
    `draftedBy=${draft.card.draftedBy} 证据 ${draft.evidenceCount}`,
  )
  // 先尝试直接发布：模板草稿含「待人工补全」占位 → 被拒后人工补全再发；
  // LLM 草稿（chat 已配置）完整 → 直接可发布。两条路径都必须收敛到 published。
  let published: Awaited<ReturnType<typeof publishRuleCard>> | null = null
  let placeholderRejected = false
  try {
    published = await publishRuleCard(draft.card.id)
  } catch (e) {
    placeholderRejected = (e as Error).message.includes('待人工补全')
  }
  if (placeholderRejected) {
    check('含「待人工补全」占位时发布被拒（模板草稿）', placeholderRejected)
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
    published = await publishRuleCard(draft.card.id)
  } else {
    check('chat 已配置时 LLM 草稿完整可发布', draft.card.draftedBy === 'llm', `draftedBy=${draft.card.draftedBy}`)
  }
  // version 不锁定 1：重复执行或此前残留的已发布同概念卡会递增版本，语义只要求成功发布
  check('发布成功（published）', published !== null && published.status === 'published', `version=${published?.version ?? '-'}`)
  const pub = published as NonNullable<typeof published>
  let publishedImmutable = false
  try {
    await updateRuleCardDraft(pub.id, {
      definition: 'x', conditions: [], context: '', invalidation: '', confusable: [], counterExamples: [], ruleId: '', sourceNote: '',
    })
  } catch (e) {
    publishedImmutable = (e as Error).message.includes('不可编辑')
  }
  check('已发布规则卡不可编辑', publishedImmutable)

  const outcome = await searchHybrid('H2 second entry 是什么', { access: ADMIN_VIEWER })
  const cardHit = outcome.hits.find((h) => h.chunk.id.startsWith('rulecard:'))
  check('规则卡进入检索命中', cardHit !== undefined && cardHit.docTitle.startsWith('规则卡：h2'), cardHit?.docTitle ?? '未命中')
  const { fetchCitation } = await import('../server/src/knowledge/retrieval.js')
  const citation = cardHit ? await fetchCitation(cardHit.chunk.id, { access: ADMIN_VIEWER }) : null
  check('规则卡引用定位', citation !== null && citation.docTitle.includes('h2'))

  // 草稿不可见：再草拟一张不发布 → 检索不命中
  const draft2 = await draftRuleCard('barbwire', 'knowledge-smoke')
  const outcome2 = await searchHybrid('barbwire 铁丝网', { access: ADMIN_VIEWER })
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

  const beforePublish = await searchHybrid('BTCUSDT 案例', { access: ADMIN_VIEWER })
  check('未发布案例不参与检索', !beforePublish.hits.some((h) => h.chunk.id === `case:${cw.id}`))
  await setCasePublished(cw.id, true)
  const afterPublish = await searchHybrid('BTCUSDT 案例', { access: ADMIN_VIEWER })
  const caseHit = afterPublish.hits.find((h) => h.chunk.id === `case:${cw.id}`)
  check('发布案例进入检索（只见可见字段）', caseHit !== undefined && !JSON.stringify(caseHit.chunk).includes('returnPct'), caseHit?.docTitle ?? '未命中')
}

// ---- 10) W2 第二批：解析事件时间线 / runNo 轮次 / 失败事件 / worker 心跳 ----
{
  const mdW2 = Buffer.from('# W2 Log Probe\n\nThe wedge is a tight trading range. H2 entry above the prior bar high works.\n', 'utf8')
  const ing = await ingestBuffer({ buffer: mdW2, fileName: 'smoke-w2-log.md', title: 'smoke-w2-log', sourceType: 'file' })

  await processDocument(ing.docId)
  let doc = await getDocument(ing.docId)
  const events1 = (doc?.parseMeta.events ?? []) as { seq: number; stage: string; atMs: number }[]
  const stages1 = events1.map((e) => e.stage)
  check(
    'W2 事件时间线：enqueued 起始 + Node 侧 stage 齐（chunking/embedding/completed）',
    stages1[0] === 'enqueued' && ['chunking', 'embedding', 'completed'].every((s) => stages1.includes(s)),
    stages1.join('→'),
  )
  check('W2 runNo 首次=1', Number(doc?.parseMeta.runNo) === 1, `runNo=${String(doc?.parseMeta.runNo)}`)
  check('W2 事件 seq 连续递增', events1.every((e, i) => e.seq === i + 1), `n=${events1.length}`)

  // 重解析 → runNo 递增且时间线重建（单轮覆盖语义）
  await processDocument(ing.docId)
  doc = await getDocument(ing.docId)
  const events2 = (doc?.parseMeta.events ?? []) as { seq: number; stage: string }[]
  check('W2 重解析 runNo=2', Number(doc?.parseMeta.runNo) === 2, `runNo=${String(doc?.parseMeta.runNo)}`)
  check('W2 重解析后事件只保留本轮（仍以 enqueued 起始）', events2[0]?.stage === 'enqueued', events2.map((e) => e.stage).join('→'))

  // 失败路径：空内容 → parseNative 抛错 → failed 事件落库
  const ingEmpty = await ingestBuffer({ buffer: Buffer.from('   \n', 'utf8'), fileName: 'smoke-w2-empty.md', title: 'smoke-w2-empty', sourceType: 'file' })
  await processDocument(ingEmpty.docId).catch(() => {})
  const docFail = await getDocument(ingEmpty.docId)
  const eventsFail = (docFail?.parseMeta.events ?? []) as { stage: string }[]
  check(
    'W2 失败路径：failed 事件落库且状态机 failed',
    docFail?.status === 'failed' && eventsFail[eventsFail.length - 1]?.stage === 'failed',
    `status=${docFail?.status} stages=${eventsFail.map((e) => e.stage).join('→')}`,
  )

  // worker 心跳：touch 后 alive=true（statuses 端点聚合的数据源）
  const { touchWorkerHeartbeat, workerHeartbeat, listKnowledgeVersions } = await import('../server/src/knowledge/store.js')
  await touchWorkerHeartbeat()
  const hb = await workerHeartbeat()
  check('W2 worker 心跳 touch 后 alive', hb.alive && (hb.heartbeatAgeMs ?? 0) < 90_000, JSON.stringify(hb))

  // 版本历史投影：listKnowledgeVersions 返回 createdAt 为 Date（端点侧转 getTime）
  const versions = await listKnowledgeVersions()
  check('W2 版本历史可列出（createdAt 为 Date）', versions.every((v) => v.createdAt instanceof Date), `n=${versions.length}`)
}

// ---- 11) W2 第三批：上传预检 / 清单条目状态 / 证据源投影（用户侧原文） ----
{
  const { findDocumentByContentHash, upsertManifestEntries, listManifestEntries, setManifestEntryStatus } = await import(
    '../server/src/knowledge/store.js'
  )

  // 上传预检（UploadDialog 第三道校验的存储层）
  const docRow = await getDocument(ingested.docId)
  const hit = await findDocumentByContentHash(docRow?.contentHash ?? '')
  check('W3 预检：已知 contentHash 命中', hit?.id === ingested.docId, hit?.title ?? '未命中')
  const miss = await findDocumentByContentHash('0'.repeat(64))
  check('W3 预检：未知 contentHash 不命中', miss === null)

  // 清单条目（ManifestDialog 数据源）：sync 入库 → 状态/lastError 落库 → 重新同步保留状态
  const entry = {
    id: 'smoke-manifest-1',
    url: 'https://example.com/brooks-glossary',
    type: 'official_glossary' as const,
    title: 'smoke 清单条目',
    topics: ['h2'],
    access: 'public' as const,
    sourceTier: 'official' as const,
    importMethod: 'url_fetch' as const,
    enabled: true,
  }
  await upsertManifestEntries([entry])
  await setManifestEntryStatus(entry.id, 'failed', { lastError: 'smoke 模拟抓取失败' })
  const row1 = (await listManifestEntries()).find((r) => r.id === entry.id)
  check('W3 清单条目：入库 + 状态与 lastError 可读', row1?.status === 'failed' && row1?.lastError === 'smoke 模拟抓取失败')
  await upsertManifestEntries([{ ...entry, title: 'smoke 清单条目 v2' }])
  const row2 = (await listManifestEntries()).find((r) => r.id === entry.id)
  check('W3 清单条目：重新同步覆盖字段、导入状态保留', row2?.title === 'smoke 清单条目 v2' && row2?.status === 'failed')

  // 证据源投影（用户侧原文，纯函数双侧断言）
  const { projectEvidenceSource } = await import('../server/src/research/runs/evidenceSource.js')
  const { PUBLIC_VIEWER } = await import('../server/src/knowledge/access.js')
  const ev = { id: 'ev-smoke-1', kind: 'knowledge_chunk' as const, docVersionId: `${ingested.docId}#1`, contentHash: 'chunkhash' }
  const base = { id: docRow!.id, version: docRow!.version, status: docRow!.status, access: docRow!.access, blobKey: docRow!.blobKey }
  const p1 = projectEvidenceSource(ev, base, PUBLIC_VIEWER)
  check(
    'W3 证据源：公开文档普通用户可读（fileUrl+docId+指纹透传）',
    p1.fileUrl === '/api/research/evidence/ev-smoke-1/file' && p1.docId === ingested.docId && p1.contentHash === 'chunkhash' && p1.docUpdated === false,
    JSON.stringify(p1),
  )
  const pUser = projectEvidenceSource(ev, { ...base, access: 'purchase' }, PUBLIC_VIEWER)
  const pAdmin = projectEvidenceSource(ev, { ...base, access: 'purchase' }, ADMIN_VIEWER)
  check('W3 证据源：受限文档普通用户 fileUrl=null（方案甲）', pUser.fileUrl === null, JSON.stringify(pUser))
  check('W3 证据源：受限文档超管仍可读（双侧）', pAdmin.fileUrl !== null)
  const pBump = projectEvidenceSource(ev, { ...base, version: base.version + 1 }, PUBLIC_VIEWER)
  check('W3 证据源：文档重发布后 docUpdated=true（不定位提示失效）', pBump.docUpdated === true && pBump.fileUrl !== null)
  const pGone = projectEvidenceSource(ev, null, ADMIN_VIEWER)
  check('W3 证据源：文档已清除 fileUrl=null + docUpdated=true', pGone.fileUrl === null && pGone.docUpdated === true)
  const pArchived = projectEvidenceSource(ev, { ...base, status: 'archived' }, ADMIN_VIEWER)
  check('W3 证据源：归档文档 fileUrl=null + docUpdated=true', pArchived.fileUrl === null && pArchived.docUpdated === true)
  const pNoBlob = projectEvidenceSource(ev, { ...base, blobKey: null }, PUBLIC_VIEWER)
  check('W3 证据源：URL 导入无本地文件 fileUrl=null', pNoBlob.fileUrl === null)
  const pRule = projectEvidenceSource({ id: 'ev2', kind: 'rule_card', docVersionId: 'rulecard:x#v1', contentHash: null }, null, ADMIN_VIEWER)
  check('W3 证据源：规则卡证据无原文入口', pRule.fileUrl === null && pRule.docUpdated === false && pRule.docId === null)
}

// ---- 清理 ----
await db.execute(sql`delete from knowledge_chunks where doc_id in (select id from knowledge_documents where title like 'smoke-%')`)
await db.execute(sql`delete from knowledge_documents where title like 'smoke-%'`)
await db.execute(sql`delete from knowledge_versions where note = 'knowledge-smoke'`)
await db.execute(sql`delete from rule_cards where created_by = 'knowledge-smoke'`)
await db.execute(sql`delete from case_windows where created_by = 'knowledge-smoke'`)
await db.execute(sql`delete from knowledge_manifest_entries where id like 'smoke-%'`)

console.log(failures === 0 ? '\n全部通过 ✔' : `\n失败 ${failures} 项 ✖`)
process.exit(failures === 0 ? 0 : 1)
