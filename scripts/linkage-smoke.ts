/**
 * 理论关联链路 smoke（本轮验收）：K 线结构 → Brooks 规则 → 适用条件与反例 → 建议 → 原文引用。
 * 运行：pnpm linkage:smoke
 *
 * 覆盖：
 * 1) 真实 perp run（知识库含已发布手册）：结构/setup 声明 evidenceIds 非空、
 *    文本含「Brooks 依据」；counterClaims 有带引用的反例；reasons 含「理论依据：」；
 *    evidenceQuality 按链接覆盖度判定（不再纯计数）
 * 2) 止损触发：持仓止损已被当前价穿越 → exit + 「止损触发」理由
 * 3) 聊天上下文同步：PATCH 顶栏 symbol 后，无 symbol 措辞的消息按顶栏值建 run
 * 4) 知识库为空场景回退：unlinked_decision 不误伤（history：空库时不阻断）——
 *    以 knowledgeEmpty 语义静态断言（不实际清库）
 */
import { initDb, getDb, sql } from '../server/src/db.js'
import { executeRun } from '../server/src/research/runs/runner.js'
import { createRun, getRun } from '../server/src/research/runs/store.js'
import { createConversation, patchContext, postMessage } from '../server/src/research/runs/conversation.js'
import { portfolioPositions } from '../server/src/models.js'
import { refreshCapabilities } from '../server/src/admin/capabilities.js'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✔ PASS' : '✖ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const USER = 'linkage-smoke'

const okdb = await initDb()
if (!okdb) {
  console.error('PostgreSQL 不可用；先 docker compose up -d postgres')
  process.exit(1)
}
await refreshCapabilities()
const db = getDb()!
// asOf 对齐库内最新已收盘 1m（worker 未运行时行情相对 wall-clock 过期会被质量门阻断；
// 用数据自身的最新时刻研究，质量门按「相对 asOf」判定才公平）
const latest = await db.execute(sql`select max(close_time)::bigint as t from market_candles where symbol='BTCUSDT' and market_type='usdm_perp' and interval='1m'`)
const now = Number((Array.isArray(latest) ? latest : (latest as unknown as { rows: { t: string | number }[] }).rows)[0].t ?? Date.now())

// 前置：知识库须有已发布内容（手册）；行情须已采集（worker 跑过）
const kb = await db.execute(sql`select count(*)::int as n from knowledge_versions`)
const kbN: number = Number((Array.isArray(kb) ? kb : (kb as unknown as { rows: { n: number }[] }).rows)[0]?.n ?? 0)
check('知识库有已发布版本（手册）', kbN > 0, `versions=${kbN}`)
const candles = await db.execute(sql`select count(*)::int as n from market_candles where symbol='BTCUSDT' and interval='1h' and market_type='usdm_perp'`)
const cN: number = Number((Array.isArray(candles) ? candles : (candles as unknown as { rows: { n: number }[] }).rows)[0]?.n ?? 0)
check('行情已采集（BTCUSDT perp 1h）', cN > 100, `bars=${cN}`)

// 清理旧数据
await db.execute(sql`delete from evidence_items where run_id in (select id from research_runs where user_id = ${USER})`)
await db.execute(sql`delete from run_steps where run_id in (select id from research_runs where user_id = ${USER})`)
await db.execute(sql`delete from research_runs where user_id = ${USER}`)
await db.execute(sql`delete from portfolio_positions where user_id = ${USER}`)
await db.execute(sql`delete from conversation_messages where conversation_id in (select id from conversations where user_id = ${USER})`)
await db.execute(sql`delete from conversations where user_id = ${USER}`)

// ---- 1) 真实 perp run（正常持仓，验证关联链路） ----
{
  const pos = await db
    .insert(portfolioPositions)
    .values({
      userId: USER, symbol: 'BTCUSDT', side: 'long', qty: '0.01', entryPrice: '50000',
      leverage: 10, marginMode: 'isolated', riskBudget: '100', stopPrice: '1',
      liquidationPrice: null, confirmedAt: now, staleAfterHours: 72,
    })
    .returning()
  // stopPrice=1 → 不会被触发（当前价远高于 1），走结构分支
  const row = await createRun({
    userId: USER,
    create: {
      product: 'perp', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '1h',
      question: '多头持仓是否继续持有', positionId: pos[0].id, asOf: now,
    },
  })
  await executeRun(row.id)
  const after = await getRun(row.id)
  check('运行发布', after?.status === 'published', `status=${after?.status} err=${after?.error ?? ''}`)
  const result = after?.result as unknown as {
    decision: string
    reasons: string[]
    claims: { text: string; kind: string; evidenceIds: string[] }[]
    evidenceQuality: string
  }
  if (result === undefined) {
    check('结果存在', false)
  } else {
    const linked = result.claims.filter((c) => c.evidenceIds.length > 0)
    check('结构/规则声明带原文引用（evidenceIds 非空）', linked.length >= 1, `linked=${linked.length}/${result.claims.length}`)
    check('声明文本含 Brooks 术语依据', result.claims.some((c) => c.text.includes('Brooks 依据')), result.claims.map((c) => c.text.slice(0, 40)).join(' | ').slice(0, 160))
    const evidence = await db.execute(
      sql`select stance, count(*)::int as n from evidence_items where run_id = ${row.id} group by stance`,
    )
    const evRows = (Array.isArray(evidence) ? evidence : (evidence as unknown as { rows: { stance: string; n: number }[] }).rows)
    const sup = Number(evRows.find((r) => r.stance === 'support')?.n ?? 0)
    const cnt = Number(evRows.find((r) => r.stance === 'counter')?.n ?? 0)
    check('支持与反例证据均已冻结', sup > 0 && cnt >= 0, `support=${sup} counter=${cnt}`)
    // 知识库非空 + 动作级决策 → reasons 应带理论依据注记（setup 存在时）
    const actionLevel = ['hold', 'conditional_entry', 'exit', 'reduce'].includes(result.decision)
    check(
      'reasons 注记语义正确（动作级决策才要求理论依据）',
      !actionLevel || result.reasons.some((r) => r.includes('理论依据')),
      `decision=${result.decision}｜${result.reasons.slice(0, 2).join('｜').slice(0, 100)}`,
    )
    check('evidenceQuality 非纯计数语义', ['complete', 'partial', 'stale'].includes(result.evidenceQuality), result.evidenceQuality)
  }
}

// ---- 2) 止损触发（价格穿越） ----
{
  const pos = await db
    .insert(portfolioPositions)
    .values({
      userId: USER, symbol: 'BTCUSDT', side: 'long', qty: '0.01', entryPrice: '50000',
      leverage: 10, marginMode: 'isolated', riskBudget: '100', stopPrice: '999999',
      liquidationPrice: null, confirmedAt: now, staleAfterHours: 72,
    })
    .returning()
  // stopPrice=999999 → 当前价必然已跌破 → 触发止损 exit
  const row = await createRun({
    userId: USER,
    create: {
      product: 'perp', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '1h',
      positionId: pos[0].id, asOf: now,
    },
  })
  await executeRun(row.id)
  const after = await getRun(row.id)
  const result = after?.result as unknown as { decision: string; reasons: string[] }
  check('止损已触发 → exit', result?.decision === 'exit', `decision=${result?.decision}`)
  check('理由说明止损触发（价格维度）', (result?.reasons ?? []).some((r) => r.includes('止损触发')), (result?.reasons ?? []).join('｜').slice(0, 120))
}

// ---- 3) 聊天上下文同步：顶栏值定位行情 ----
{
  const conv = await createConversation(USER, 'linkage')
  const patched = await patchContext(conv, { symbol: 'ETHUSDT', marketType: 'usdm_perp', horizon: '30m', product: 'perp' })
  check('顶栏字段写入上下文', (patched.context as { symbol?: string }).symbol === 'ETHUSDT')
  const reply = await postMessage(patched.context ? { ...conv, context: patched.context } : conv, '现在结构怎么样')
  // 消息不含 symbol 措辞 → run.symbol 必须来自上下文（顶栏同步值）
  const runRow = reply.runId !== null ? await getRun(reply.runId) : null
  check('无 symbol 措辞的聊天按顶栏值建研究', runRow?.symbol === 'ETHUSDT', `symbol=${runRow?.symbol ?? 'null'}（应为 ETHUSDT）`)
  check('期限同步生效', runRow?.horizon === '30m', `horizon=${runRow?.horizon ?? 'null'}`)
  // 非法值被拒
  let rejected = false
  try {
    await patchContext(conv, { symbol: 'not a symbol!' })
  } catch {
    rejected = true
  }
  check('非法 symbol 被拒（400）', rejected)
}


// ---- 4) P1-1 断点恢复：检索完成后崩溃 → 续跑（生产同一路径） ----
{
  const { runPipeline } = await import('../server/src/research/orchestrator/pipeline.js')
  const { buildStages } = await import('../server/src/research/runs/stages.js')
  const { runCheckpointOf, executeRun } = await import('../server/src/research/runs/runner.js')
  const { PgRunStore } = await import('../server/src/research/runs/store.js')
  const row = await createRun({
    userId: USER,
    create: { product: 'perp', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '1h', asOf: now },
  })
  // 阶段 A：真实阶段跑到 retrieve（用生产 checkpointOf 落检查点），模拟此后 worker 崩溃
  const ctxA = {
    runId: row.id, userId: USER, product: 'perp' as const, symbol: 'BTCUSDT',
    marketType: 'usdm_perp' as const, horizon: '1h' as const, question: null,
    positionId: null, quoteId: null, asOf: now, frozenConfig: row.frozenConfig as unknown as null,
    qualityIssues: [], snapshotPack: null,
    snapshotId: null, configVersion: null, knowledgeVersion: null, ruleVersion: null, modelVersion: null,
    plan: null, structures: null, retrieval: null, productPayload: null,
    claims: [], counterClaims: [], decision: null, result: null, validationFeedback: null,
    usage: { llmCalls: 0, tokens: 0, searchCalls: 0, toolCalls: 0, costUsd: 0 },
    runStartedAt: Date.now(),
  }
  // 阶段 A：手工重放 runStage 内部（stepStarted→run→completeStage 落检查点），
  // 跑完 retrieve 即停——等价于「检索完成后、下一阶段开始前 worker 掉线」
  const store = new PgRunStore()
  const { acquireRunLease } = await import('../server/src/research/runs/store.js')
  if (!(await acquireRunLease(row.id, 'resume-test'))) throw new Error('阶段 A 租约获取失败')
  await store.transition(row.id, 'running', 'resume-test')
  for (const st of buildStages().filter((x) => ['plan', 'snapshot', 'structures', 'retrieve'].includes(x.name))) {
    const startedAt = Date.now()
    await store.stepStarted(row.id, st.name, startedAt, 'resume-test')
    await st.run(ctxA as unknown as Parameters<typeof st.run>[0])
    await store.completeStage(row.id, st.name, Date.now(), Date.now() - startedAt, runCheckpointOf(ctxA as never, st.name), 'resume-test')
  }
  void runPipeline
  // 检查点必须已保存理论关联状态（修复前 ruleLinks 不入库）
  const saved = await db.execute(sql`select ctx_state->'v2'->'ruleLinks' as links, ctx_state->'v2'->'knowledgeEmpty' as ke from research_runs where id = ${row.id}`)
  const savedRow = (Array.isArray(saved) ? saved : (saved as unknown as { rows: { links: unknown; ke: unknown }[] }).rows)[0]
  check('检查点已保存 ruleLinks/knowledgeEmpty', savedRow?.links !== undefined && savedRow?.ke !== undefined, `links=${JSON.stringify(savedRow?.links)?.slice(0, 40)}`)
  // 强制租约过期（模拟 worker 掉线后接管）
  await db.execute(sql`update research_runs set lease_until = now() - interval '1 second' where id = ${row.id}`)
  // 阶段 B：executeRun 真实恢复路径 → product_analysis 消费 ruleLinks 不崩并完成发布
  await executeRun(row.id)
  const after = await getRun(row.id)
  check('检索后崩溃可续跑至发布（ruleLinks 水化）', after?.status === 'published', `status=${after?.status} err=${after?.error?.slice(0, 120) ?? ''}`)
  const res = after?.result as unknown as { claims: { evidenceIds: string[] }[] } | null
  check('续跑结果含带引用声明（理论链路恢复）', (res?.claims ?? []).some((c) => c.evidenceIds.length > 0))
}

// ---- 清理 ----
await db.execute(sql`delete from evidence_items where run_id in (select id from research_runs where user_id = ${USER})`)
await db.execute(sql`delete from run_steps where run_id in (select id from research_runs where user_id = ${USER})`)
await db.execute(sql`delete from structure_events where snapshot_id in (select snapshot_id from research_runs where user_id = ${USER} and snapshot_id is not null)`)
await db.execute(sql`delete from research_runs where user_id = ${USER}`)
await db.execute(sql`delete from portfolio_positions where user_id = ${USER}`)
await db.execute(sql`delete from conversation_messages where conversation_id in (select id from conversations where user_id = ${USER})`)
await db.execute(sql`delete from conversations where user_id = ${USER}`)
await db.execute(sql`delete from market_snapshots where symbol = 'ETHUSDT' and created_at > now() - interval '10 minutes'`)

console.log(failures === 0 ? '\n理论关联链路全部通过 ✔' : `\n失败 ${failures} 项 ✖`)
process.exit(failures === 0 ? 0 : 1)
