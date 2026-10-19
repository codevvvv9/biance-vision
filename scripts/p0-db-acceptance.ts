/**
 * P0 落地真实 DB 验收（一次性脚本，本地 PG）：
 * - 迁移 0016/0017 已应用（case_windows.published_at / prompt_templates / pointers / prompt_refs）
 * - 种子：五个 published v1 + 指针就位
 * - freezeRunConfig：raw.prompts 含 counter-reviewer 与 query-rewrite 全文+版本号（P0-6 验收）
 * - 指针清空回退：resolvePromptTemplate → default 源；恢复指针后 → registry 源
 * - P0-4 as-of：发布时刻晚于 asOf 的规则卡/案例不进入检索视图
 * 运行：DATABASE_URL 可用环境 tsx scripts/p0-db-acceptance.ts
 */
import { getDb, initDb, sql } from '../server/src/db.js'
import { freezeRunConfig } from '../server/src/research/runs/store.js'
import { resolvePromptTemplate, PROMPT_NAMES } from '../server/src/research/prompts.js'
import { publishedRuleCards, publishedCasesForRetrieval } from '../server/src/knowledge/ruleCards.js'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${msg}`)
  } else {
    failed++
    console.error(`  ❌ ${msg}`)
  }
}

await initDb() // 连接 + 自动执行迁移（0016/0017 在此应用）
const db = getDb()
assert(db !== null, '本地 PostgreSQL 可连接')

if (db !== null) {
  // 1) 迁移已应用
  const cols = await db.execute(sql`select column_name from information_schema.columns where table_name='case_windows' and column_name='published_at'`)
  const colRows = (Array.isArray(cols) ? cols : (cols as { rows: unknown[] }).rows) as { column_name: string }[]
  assert(colRows.length === 1, '迁移 0016：case_windows.published_at 列存在')

  const tbls = await db.execute(sql`select table_name from information_schema.tables where table_name in ('prompt_templates','prompt_template_pointers')`)
  const tblRows = (Array.isArray(tbls) ? tbls : (tbls as { rows: unknown[] }).rows) as { table_name: string }[]
  assert(tblRows.length === 2, '迁移 0017：prompt_templates + prompt_template_pointers 表存在')

  const msgCol = await db.execute(sql`select column_name from information_schema.columns where table_name='conversation_messages' and column_name='prompt_refs'`)
  const msgRows = (Array.isArray(msgCol) ? msgCol : (msgCol as { rows: unknown[] }).rows) as { column_name: string }[]
  assert(msgRows.length === 1, '迁移 0017：conversation_messages.prompt_refs 列存在')

  // 2) 种子与指针
  const seedRows = await db.execute(sql`select name from prompt_templates where status = 'published'`)
  const seeds = (Array.isArray(seedRows) ? seedRows : (seedRows as { rows: unknown[] }).rows) as { name: string }[]
  const seedNames = new Set(seeds.map((s) => s.name))
  assert(
    PROMPT_NAMES.every((n) => seedNames.has(n)),
    `种子：五个 published v1 就位（${seeds.length} 行：${[...seedNames].join(',')}）`,
  )
  const ptrRows = await db.execute(sql`select count(*)::int as n from prompt_template_pointers`)
  const ptrCount = ((Array.isArray(ptrRows) ? ptrRows : (ptrRows as { rows: unknown[] }).rows) as { n: number }[])[0]?.n ?? 0
  assert(ptrCount >= 5, `指针：≥5 条（实际 ${ptrCount}）`)

  // 3) freezeRunConfig 冻结 prompts（P0-6 核心验收）
  const frozen = await freezeRunConfig()
  const prompts = (frozen.raw as { prompts?: Record<string, { content?: string; version?: number | null; templateId?: string | null }> }).prompts
  assert(prompts !== undefined, 'frozenConfig.raw.prompts 存在')
  if (prompts !== undefined) {
    for (const name of ['counter-reviewer', 'query-rewrite'] as const) {
      const p = prompts[name]
      assert(
        p !== undefined && typeof p.content === 'string' && p.content.length > 50 && typeof p.version === 'number' && typeof p.templateId === 'string',
        `冻结 ${name}：全文+版本号（v${String(p?.version)}，${String(p?.content?.length)} 字）`,
      )
    }
    const counter = prompts['counter-reviewer']
    assert(counter?.content?.includes('[k]') === true, 'counter-reviewer 冻结文本含 [k] 证据编号要求（P0-3 版模板）')
  }

  // 4) 指针清空回退（事务性破坏→验证→恢复）
  const ptrBeforeRows = await db.execute(sql`select published_id from prompt_template_pointers where name = 'counter-reviewer' and scene = ''`)
  const ptrBefore = (Array.isArray(ptrBeforeRows) ? ptrBeforeRows : (ptrBeforeRows as { rows: unknown[] }).rows) as { published_id: string }[]
  await db.execute(sql`delete from prompt_template_pointers where name = 'counter-reviewer'`)
  const fallback = await resolvePromptTemplate('counter-reviewer')
  assert(fallback.source === 'default', `指针清空 → 回退工程默认（source=${fallback.source}），不阻塞`)
  if (ptrBefore[0] !== undefined) {
    await db.execute(sql`insert into prompt_template_pointers (name, scene, published_id) values ('counter-reviewer', '', ${ptrBefore[0].published_id})`)
  }
  const restored = await resolvePromptTemplate('counter-reviewer')
  assert(restored.source === 'registry' && restored.version !== null, `指针恢复 → registry 解析（v${String(restored.version)}）`)

  // 4b) secrets.json 读取（e2e 发现的既有路径 bug：曾指向 server/src/data/）
  const { readSecrets } = await import('../server/src/admin/capabilities.js')
  const fsmod = await import('node:fs')
  const secretsPath = new URL('../server/data/secrets.json', import.meta.url)
  if (fsmod.existsSync(secretsPath)) {
    assert(Object.keys(readSecrets()).length > 0, 'secrets.json 存在时 readSecrets 必须能读到（路径修复回归钉）')
  }

  // 5) P0-4 as-of 过滤
  const pastCards = await publishedRuleCards(new Date(Date.now() - 365 * 86400_000))
  const nowCards = await publishedRuleCards()
  const pastCases = await publishedCasesForRetrieval(new Date(Date.now() - 365 * 86400_000))
  const nowCases = await publishedCasesForRetrieval()
  console.log(`  ℹ️ 规则卡 published=${nowCards.length}，一年前 as-of=${pastCards.length}；案例 published=${nowCases.length}，一年前 as-of=${pastCases.length}`)
  assert(pastCards.length <= nowCards.length && pastCases.length <= nowCases.length, 'as-of 过滤不增集（过去时刻 ⊆ 当前）')

  // 5b) as-of 复现性钉（2026-10-19 二轮审查三缺口回归钉）：自建测试数据，断言后清理
  {
    const { draftRuleCard, updateRuleCardDraft, publishRuleCard, buildCaseWindow, setCasePublished } = await import('../server/src/knowledge/ruleCards.js')
    const { searchHybrid } = await import('../server/src/knowledge/retrieval.js')
    const concept = 'dbcheck-asof' // 词项提取截断 >20 字符 token：概念名不得带时间戳数字后缀
    const content = (v: string) => ({ definition: `${v}：测试定义`, conditions: [], context: '', invalidation: '', confusable: [], counterExamples: [], ruleId: 'dbcheck', sourceNote: 'db-check' })
    try {
      const d1 = await draftRuleCard(concept, 'db-check')
      await updateRuleCardDraft(d1.card.id, content('v1内容'))
      const p1 = await publishRuleCard(d1.card.id)
      const t1 = new Date(p1.publishedAt!.getTime() + 100)
      await new Promise((r) => setTimeout(r, 1100))
      const d2 = await draftRuleCard(concept, 'db-check')
      await updateRuleCardDraft(d2.card.id, content('v2内容'))
      await publishRuleCard(d2.card.id)
      // 同概念双版：as-of 只回概念生效版本（v1），当前语义只有 v2
      const cur = (await publishedRuleCards()).filter((c) => c.concept === concept)
      const asof = (await publishedRuleCards(t1)).filter((c) => c.concept === concept)
      assert(cur.length === 1 && cur[0].version === 2, `同概念当前语义应恰 1 条 v2（实际 ${cur.length} 条）`)
      assert(asof.length === 1 && asof[0].version === 1 && String(asof[0].content.definition).includes('v1内容'), `as-of(v1) 应恰 1 条 v1 快照（实际 ${asof.length} 条）`)
      // 端到端：v1 行已归档、v2 已发布，as-of 检索仍把 v1 历史内容带进最终结果
      const sh = await searchHybrid(`${concept} 测试定义`, { knowledgeAsOf: t1, skipRerank: true })
      const hit = sh.hits.find((h) => h.chunk.id.startsWith('rulecard:'))
      assert(hit !== undefined && (hit.chunk as { text: string }).text.includes('v1内容'), 'as-of 检索端到端：归档行历史内容仍进入最终结果（组装不回查当前状态）')
      // 案例发布→下架事件重放
      const cw = await buildCaseWindow({ symbol: 'BTCUSDT', marketType: 'usdm_perp', interval: '1m', annotation: 'db-check 下架重放' }, 'db-check')
      const pub = await setCasePublished(cw.id, true)
      const tp = new Date(pub.publishedAt!.getTime() + 100)
      await new Promise((r) => setTimeout(r, 200))
      await setCasePublished(cw.id, false)
      assert((await publishedCasesForRetrieval(tp)).some((c) => c.id === `case:${cw.id}`), '案例下架前 as-of 可见')
      assert(!(await publishedCasesForRetrieval(new Date())).some((c) => c.id === `case:${cw.id}`), '案例下架后 as-of 不可见（unpublish 事件重放）')
      assert(!(await publishedCasesForRetrieval()).some((c) => c.id === `case:${cw.id}`), '案例下架后当前语义不可见')
      console.log('  ✅ as-of 复现性钉：概念生效版本 / 归档端到端 / 下架事件重放')
    } finally {
      await getDb()!.execute(sql.raw(`delete from knowledge_publications where ref_id in (select id from rule_cards where concept='${concept}')`))
      await getDb()!.execute(sql.raw(`delete from rule_cards where concept='${concept}'`))
      await getDb()!.execute(sql.raw(`delete from knowledge_publications where kind='case' and ref_id in (select id from case_windows where annotation='db-check 下架重放')`))
      await getDb()!.execute(sql.raw(`delete from case_windows where annotation='db-check 下架重放'`))
    }
  }
}

console.log(`\nP0 DB 验收：${passed} 通过 / ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
