/**
 * 知识库权限底座自测（pnpm knowledge:access-check，需本地 PostgreSQL）。
 *
 * W1-A（docs/unified-roadmap.md §3）：access=方案甲（参与检索过滤）的双侧断言——
 * 真合法放行 + 伪装拦截（受限内容对普通用户在检索/引用定位/LLM 上下文全链路不可见，
 * superadmin 全量）。覆盖：
 *   A. access.ts 纯函数（上下文构造/判权/受限判定）
 *   B. 检索过滤：普通用户只见 public 文档；缺省上下文=普通用户（安全默认）；超管全量
 *   C. 派生规则卡联动：citations 指向受限源文档的卡片对普通用户隐藏（读取时按源当前 access）
 *   D. fetchCitation 引用定位：受限文档 chunk / 受限源卡片 普通用户 null、超管可定位
 *
 * 每次运行清理本脚本创建的 access-check-* 文档/版本/规则卡，可重复执行。
 * 运行环境：docker compose 的 postgres 在跑（127.0.0.1:5434）；smoke 环境无 worker，
 * processDocument 同步调用（与 knowledge-smoke 同模式）。
 */
import { initDb, getDb, sql } from '../server/src/db.js'
import { searchHybrid, fetchCitation } from '../server/src/knowledge/retrieval.js'
import { processDocument } from '../server/src/knowledge/pipeline.js'
import { ingestBuffer } from '../server/src/knowledge/ingest.js'
import { getDocument, listChunksOfVersion, publishDocument, workingVersionId } from '../server/src/knowledge/store.js'
import { probeVectorSupport } from '../server/src/knowledge/vector.js'
import {
  ADMIN_VIEWER,
  PUBLIC_VIEWER,
  accessCtxFromSession,
  accessCtxForUser,
  canSeeAccess,
  isRestrictedAccess,
} from '../server/src/knowledge/access.js'
import { draftRuleCard, publishRuleCard, getRuleCard } from '../server/src/knowledge/ruleCards.js'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✔ PASS' : '✖ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// ---- A. access.ts 纯函数 ----
{
  check('A1 普通用户上下文判权：public 可见', canSeeAccess(PUBLIC_VIEWER, 'public'))
  check('A2 普通用户上下文判权：purchase/member 不可见', !canSeeAccess(PUBLIC_VIEWER, 'purchase') && !canSeeAccess(PUBLIC_VIEWER, 'member'))
  check('A3 超管上下文全量可见', canSeeAccess(ADMIN_VIEWER, 'public') && canSeeAccess(ADMIN_VIEWER, 'purchase') && canSeeAccess(ADMIN_VIEWER, 'member'))
  check('A4 会话构造：superadmin 会话 → 超管上下文', accessCtxFromSession({ role: 'superadmin' }).viewerRole === 'superadmin')
  check('A5 会话构造：普通/缺失会话 → 普通上下文', accessCtxFromSession({ role: 'user' }).viewerRole === 'user' && accessCtxFromSession(null).viewerRole === 'user')
  check('A6 用户名构造：未知用户按普通（保守）', accessCtxForUser('access-check-nobody').viewerRole === 'user')
  check('A7 受限判定集中一处', isRestrictedAccess('purchase') && isRestrictedAccess('member') && !isRestrictedAccess('public') && !isRestrictedAccess(undefined))
}

const ok = await initDb()
if (!ok) {
  console.error('PostgreSQL 不可用（默认 127.0.0.1:5434；先 docker compose up -d postgres），access-check 无法执行')
  process.exit(1)
}
const db = getDb()!

// 清理旧的 access-check 数据
await db.execute(sql`delete from knowledge_chunks where doc_id in (select id from knowledge_documents where title like 'access-check-%')`)
await db.execute(sql`delete from knowledge_documents where title like 'access-check-%'`)
await db.execute(sql`delete from knowledge_versions where note = 'knowledge-access-check'`)
await db.execute(sql`delete from rule_cards where created_by = 'knowledge-access-check'`)
await probeVectorSupport(true)

const PUB_TITLE = 'access-check-public-doc'
const PUR_TITLE = 'access-check-purchase-doc'

// ---- B. 检索过滤（双侧）----
const pubDoc = await ingestBuffer({
  buffer: Buffer.from(
    ['# H2 Public Chapter', '', 'The H2 second entry in a bull pullback. Sentinel pubonly-alpha marks this public document.'].join('\n'),
    'utf8',
  ),
  fileName: 'access-check-public.md',
  title: PUB_TITLE,
  sourceType: 'file',
  sourceTier: 'community',
  access: 'public',
})
const purDoc = await ingestBuffer({
  buffer: Buffer.from(
    ['# H2 Purchase Chapter', '', 'The H2 with accesscheck-beta concept. Sentinel puronly-beta marks this restricted purchase document.'].join('\n'),
    'utf8',
  ),
  fileName: 'access-check-purchase.md',
  title: PUR_TITLE,
  sourceType: 'file',
  sourceTier: 'community',
  access: 'purchase',
})
check('B1 public/purchase 双文档建档', !!pubDoc.docId && !!purDoc.docId, `${pubDoc.status}/${purDoc.status}`)

await processDocument(pubDoc.docId)
await processDocument(purDoc.docId)
const pubRow = await getDocument(pubDoc.docId)
const purRow = await getDocument(purDoc.docId)
check('B2 双文档处理到 indexed', pubRow?.status === 'indexed' && purRow?.status === 'indexed', `${pubRow?.status}/${purRow?.status} err=${purRow?.error ?? ''}`)
// 建档 access 落库正确（伪装拦截的前提：受限文档确实带着受限标记进库）
check('B3 purchase 文档 access 落库', purRow?.access === 'purchase', `access=${purRow?.access}`)

await publishDocument(pubDoc.docId, 'knowledge-access-check', 'access-check')
await publishDocument(purDoc.docId, 'knowledge-access-check', 'access-check')

const asUser = await searchHybrid('H2 entry pullback', { access: PUBLIC_VIEWER })
const userTitles = asUser.hits.map((h) => h.docTitle)
check('B4 普通用户检索命中 public 文档且零受限命中', userTitles.includes(PUB_TITLE) && !userTitles.includes(PUR_TITLE), userTitles.join(','))
check('B5 普通用户检索零受限命中', !userTitles.includes(PUR_TITLE), userTitles.join(','))
check('B6 权限过滤留痕（notes）', asUser.debug.notes.some((n) => n.includes('权限过滤')), asUser.debug.notes.join('；'))

const asAdmin = await searchHybrid('H2 entry pullback', { access: ADMIN_VIEWER })
const adminTitles = asAdmin.hits.map((h) => h.docTitle)
check('B7 超管检索全量（双文档均可见）', adminTitles.includes(PUB_TITLE) && adminTitles.includes(PUR_TITLE), adminTitles.join(','))

const asDefault = await searchHybrid('H2 entry pullback')
check('B8 缺省上下文=普通用户（安全默认，漏传只更保守）', !asDefault.hits.some((h) => h.docTitle === PUR_TITLE), asDefault.hits.map((h) => h.docTitle).join(','))

// ---- C. 派生规则卡联动 ----
const draft = await draftRuleCard('accesscheck-beta', 'knowledge-access-check')
const draftCitedPur = draft.card.citations.some((c) => c.docVersionId.startsWith(`${purDoc.docId}#`))
check('C1 草拟引用确实指向受限源（citations）', draftCitedPur, draft.card.citations.map((c) => c.docVersionId).join(','))
if (draftCitedPur) {
  await publishRuleCard(draft.card.id)
  const cardAdmin = await searchHybrid('accesscheck-beta', { access: ADMIN_VIEWER })
  check('C2 超管可召回受限源规则卡', cardAdmin.hits.some((h) => h.chunk.id.startsWith('rulecard:')), cardAdmin.hits.map((h) => h.chunk.id).join(','))
  const cardUser = await searchHybrid('accesscheck-beta', { access: PUBLIC_VIEWER })
  check('C3 普通用户不召回受限源规则卡（读取时联动）', !cardUser.hits.some((h) => h.chunk.id.startsWith('rulecard:')), cardUser.hits.map((h) => h.chunk.id).join(','))
  check('C4 联动留痕（notes）', cardUser.debug.notes.some((n) => n.includes('权限联动')), cardUser.debug.notes.join('；'))

  // ---- D. fetchCitation 引用定位判权 ----
  const cardAdminCite = await fetchCitation(`rulecard:${draft.card.id}`, { access: ADMIN_VIEWER })
  const cardUserCite = await fetchCitation(`rulecard:${draft.card.id}`, { access: PUBLIC_VIEWER })
  check('D1 受限源卡片：超管可定位 / 普通用户 null', cardAdminCite !== null && cardUserCite === null, `${cardAdminCite !== null}/${cardUserCite === null}`)
}

const purChunks = purRow !== null ? await listChunksOfVersion(workingVersionId(purRow)) : []
const purChunkId = purChunks[0]?.id ?? ''
check('D2 受限文档 chunk 存在', purChunkId !== '', purChunks.length.toString())
if (purChunkId !== '') {
  const citUser = await fetchCitation(purChunkId, { access: PUBLIC_VIEWER })
  const citAdmin = await fetchCitation(purChunkId, { access: ADMIN_VIEWER })
  check('D3 受限 chunk：普通 null / 超管可定位', citUser === null && citAdmin !== null, `${citUser === null}/${citAdmin !== null}`)
}
const pubChunks = pubRow !== null ? await listChunksOfVersion(workingVersionId(pubRow)) : []
if ((pubChunks[0]?.id ?? '') !== '') {
  const pubCitUser = await fetchCitation(pubChunks[0].id, { access: PUBLIC_VIEWER })
  check('D4 public chunk 普通用户可定位（真合法放行）', pubCitUser !== null, '')
}

// ---- 清理 ----
await db.execute(sql`delete from knowledge_chunks where doc_id in (select id from knowledge_documents where title like 'access-check-%')`)
await db.execute(sql`delete from knowledge_documents where title like 'access-check-%'`)
await db.execute(sql`delete from knowledge_versions where note = 'knowledge-access-check'`)
// 发布历史行（表无 created_by，按概念名定位本脚本的卡片发布事件，避免下次 as-of 干扰）
await db.execute(sql`delete from knowledge_publications where kind = 'rulecard' and concept = 'accesscheck-beta'`)
await db.execute(sql`delete from rule_cards where created_by = 'knowledge-access-check'`)

if (failures > 0) {
  console.error(`\n知识库权限底座自测未通过 ✖（${failures} 项失败）`)
  process.exit(1)
}
console.log('\n知识库权限底座自测全部通过 ✔（方案甲：检索/引用定位/规则卡联动双侧钉住）')
