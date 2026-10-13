/**
 * 规则卡层与案例层（docs/specs/knowledge-rag.md 三资料层的第 2/3 层）：
 * - 规则卡：一概念一卡。草拟两种来源——chat 能力已配置时 LLM 草拟（基于检索到的
 *   原始资料片段），否则模板草拟（填入命中片段供人工补全）；一律管理员审核后才发布。
 *   已发布卡片不可改，改版=同概念新草稿（version+1）。仅 published 卡进入检索。
 * - 案例窗：从库内已收盘 K 线构建「决策时可见上下文」（引擎只喂 knownAt<=atTime 的
 *   前缀），未来结果标签单独计算入 outcome 列——检索只返回 visibleContext。
 */
import { and, desc, eq } from 'drizzle-orm'
import { analyzeBrooks } from 'biance-vision-brooks'
import { getDb } from '../db.js'
import { caseWindows, ruleCards } from '../models.js'
import type { CaseWindowRow, RuleCardRow } from '../models.js'
import { readCandles } from '../market/read.js'
import { searchHybrid } from './retrieval.js'
import { normalizeQueryTerms } from './terms.js'
import { resolveLlmClient, parseClaimLines } from '../research/llm.js'
import { kv, log } from '../logger.js'

// ---- 规则卡 ----

export interface RuleCardContent {
  definition: string
  conditions: string[]
  context: string
  invalidation: string
  confusable: string[]
  counterExamples: string[]
  /** 关联引擎规则 id（仅解释用途，规则代码变更走引擎注册表流程） */
  ruleId: string
  sourceNote: string
}

function templateCard(concept: string, evidenceTexts: string[]): RuleCardContent {
  const first = evidenceTexts[0]?.slice(0, 200) ?? ''
  return {
    definition: `【待人工补全】${concept}：（草拟自资料片段）${first}`,
    conditions: ['【待人工补全】成立条件 1'],
    context: '【待人工补全】适用语境',
    invalidation: '【待人工补全】失效条件',
    confusable: ['【待人工补全】易混淆概念'],
    counterExamples: ['【待人工补全】反例'],
    ruleId: '',
    sourceNote: '模板草拟（chat 能力未配置），必须人工补全后审核',
  }
}

async function llmDraftCard(concept: string, evidenceTexts: string[]): Promise<RuleCardContent | null> {
  const llm = resolveLlmClient()
  if (llm === null || evidenceTexts.length === 0) return null
  try {
    const out = await llm.complete({
      system:
        '你是 Brooks 价格行为知识编辑。根据给出的资料片段，为概念写一张规则卡，严格输出 JSON（不要 markdown 代码块）：' +
        '{"definition":"一句话定义","conditions":["成立条件",...],"context":"适用语境",' +
        '"invalidation":"失效条件","confusable":["易混淆概念",...],"counterExamples":["反例",...],"ruleId":"关联规则id或空"}。' +
        '只使用片段中的信息，不得编造；信息不足的字段留空字符串或空数组。',
      user: `概念：${concept}\n\n资料片段：\n${evidenceTexts.map((t, i) => `[${i + 1}] ${t.slice(0, 600)}`).join('\n')}`,
      maxTokens: 900,
    })
    const text = out.text.replace(/^```(?:json)?|```$/g, '').trim()
    const parsed = JSON.parse(text) as Partial<RuleCardContent>
    return {
      definition: typeof parsed.definition === 'string' ? parsed.definition : '',
      conditions: Array.isArray(parsed.conditions) ? parsed.conditions.map(String).slice(0, 6) : [],
      context: typeof parsed.context === 'string' ? parsed.context : '',
      invalidation: typeof parsed.invalidation === 'string' ? parsed.invalidation : '',
      confusable: Array.isArray(parsed.confusable) ? parsed.confusable.map(String).slice(0, 4) : [],
      counterExamples: Array.isArray(parsed.counterExamples) ? parsed.counterExamples.map(String).slice(0, 4) : [],
      ruleId: typeof parsed.ruleId === 'string' ? parsed.ruleId : '',
      sourceNote: 'LLM 草拟自原始资料片段，需管理员审核',
    }
  } catch {
    return null
  }
}

export interface DraftCardResult {
  card: RuleCardRow
  draftedBy: 'llm' | 'template'
  evidenceCount: number
}

/** 草拟规则卡：检索概念相关片段 → LLM/模板草拟 → 落 draft（不自动发布） */
export async function draftRuleCard(concept: string, createdBy: string): Promise<DraftCardResult> {
  const db = getDb()
  if (!db) throw Object.assign(new Error('数据库不可用'), { statusCode: 503 })
  const { matchedTerms } = normalizeQueryTerms(concept)
  const query = matchedTerms.length > 0 ? `${concept} ${matchedTerms.join(' ')}` : concept
  const outcome = await searchHybrid(query, { finalLimit: 5 })
  const texts = outcome.hits.map((h) => h.chunk.text)
  const citations = outcome.hits.map((h) => ({
    docVersionId: h.chunk.docVersionId,
    chunkId: h.chunk.id,
    pageNo: h.chunk.pageNo,
  }))
  const content = (await llmDraftCard(concept, texts)) ?? templateCard(concept, texts)
  const draftedBy = content.sourceNote.startsWith('LLM') ? 'llm' : 'template'
  const rows = await db
    .insert(ruleCards)
    .values({ concept: concept.toLowerCase(), status: 'draft', content: content as unknown as Record<string, unknown>, citations, draftedBy, createdBy })
    .returning()
  log.ok('knowledge', '规则卡草拟', kv({ 概念: concept, 来源: draftedBy, 证据: citations.length }))
  return { card: rows[0], draftedBy, evidenceCount: citations.length }
}

export async function listRuleCards(status?: string): Promise<RuleCardRow[]> {
  const db = getDb()
  if (!db) return []
  const q = db.select().from(ruleCards)
  return status !== undefined && status !== ''
    ? q.where(eq(ruleCards.status, status)).orderBy(desc(ruleCards.updatedAt))
    : q.orderBy(desc(ruleCards.updatedAt))
}

export async function getRuleCard(id: string): Promise<RuleCardRow | null> {
  const rows = await getDb()!.select().from(ruleCards).where(eq(ruleCards.id, id)).limit(1)
  return rows[0] ?? null
}

export async function updateRuleCardDraft(id: string, content: RuleCardContent): Promise<RuleCardRow> {
  const db = getDb()!
  const rows = await db
    .update(ruleCards)
    .set({ content: content as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(ruleCards.id, id))
    .returning()
  if (rows.length === 0) throw Object.assign(new Error('规则卡不存在'), { statusCode: 404 })
  if (rows[0].status !== 'draft') throw Object.assign(new Error('已发布规则卡不可编辑（改版=同概念新草稿）'), { statusCode: 400 })
  return rows[0]
}

/** 发布：校验内容已人工补全（无「待人工补全」占位）→ 同概念旧 published 归档 → bump version */
export async function publishRuleCard(id: string): Promise<RuleCardRow> {
  const db = getDb()!
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(ruleCards).where(eq(ruleCards.id, id)).limit(1)
    const card = rows[0]
    if (!card) throw Object.assign(new Error('规则卡不存在'), { statusCode: 404 })
    if (card.status !== 'draft') throw Object.assign(new Error('仅草稿可发布'), { statusCode: 400 })
    const content = JSON.stringify(card.content)
    if (content.includes('待人工补全')) {
      throw Object.assign(new Error('卡片仍含「待人工补全」占位：补全后再发布'), { statusCode: 400 })
    }
    // 同概念旧版本归档
    await tx
      .update(ruleCards)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(eq(ruleCards.concept, card.concept), eq(ruleCards.status, 'published')))
    const prevVersions = await tx
      .select({ version: ruleCards.version })
      .from(ruleCards)
      .where(eq(ruleCards.concept, card.concept))
      .orderBy(desc(ruleCards.version))
      .limit(1)
    const nextVersion = (prevVersions[0]?.version ?? 0) + 1
    const updated = await tx
      .update(ruleCards)
      .set({ status: 'published', version: nextVersion, publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(ruleCards.id, id))
      .returning()
    log.ok('knowledge', '规则卡发布', kv({ 概念: card.concept, 版本: nextVersion }))
    return updated[0]
  })
}

export async function deleteRuleCardDraft(id: string): Promise<void> {
  const rows = await getDb()!.delete(ruleCards).where(and(eq(ruleCards.id, id), eq(ruleCards.status, 'draft'))).returning()
  if (rows.length === 0) throw Object.assign(new Error('仅草稿可删除'), { statusCode: 400 })
}

/** 已发布规则卡 → 检索伪 chunk（概念名 + 卡片文本做词项） */
export async function publishedRuleCards(): Promise<RuleCardRow[]> {
  const db = getDb()
  if (!db) return []
  return db.select().from(ruleCards).where(eq(ruleCards.status, 'published'))
}

export function ruleCardToRetrievable(card: RuleCardRow): {
  id: string
  docVersionId: string
  text: string
  concept: string
} {
  const c = card.content as Partial<RuleCardContent>
  const text = [
    c.definition ?? '',
    (c.conditions ?? []).join('；'),
    c.context ?? '',
    `失效：${c.invalidation ?? ''}`,
    (c.counterExamples ?? []).join('；'),
  ]
    .filter((s) => s !== '')
    .join('\n')
  return { id: `rulecard:${card.id}`, docVersionId: `rulecard:${card.id}#v${card.version}`, text, concept: card.concept }
}

// ---- 案例窗 ----

export interface CaseBuildInput {
  symbol: string
  marketType: 'spot' | 'usdm_perp'
  interval: string
  /** 决策时刻（窗口右端）；缺省 = 最新已收盘 */
  atTime?: number
  /** 可见窗口 K 线根数（决策前），默认 120 */
  lookback?: number
  /** 结果前瞻根数（决策后），默认 24 */
  forwardBars?: number
  annotation?: string
}

/**
 * 构建案例窗：可见上下文 = 决策时刻前的 K 线 + 引擎前缀分析（knownAt<=atTime）；
 * outcome = 前瞻窗口收益/方向（只写 outcome 列，检索不可见）。
 */
export async function buildCaseWindow(input: CaseBuildInput, createdBy: string): Promise<CaseWindowRow> {
  const db = getDb()
  if (!db) throw Object.assign(new Error('数据库不可用'), { statusCode: 503 })
  const lookback = input.lookback ?? 120
  const forward = input.forwardBars ?? 24
  const candles = await readCandles({
    marketType: input.marketType,
    priceType: 'trade',
    symbol: input.symbol,
    interval: input.interval as '1m',
    asOf: input.atTime,
    limit: lookback + forward + 10,
  })
  if (candles.length < lookback / 2) throw Object.assign(new Error(`行情不足（${candles.length} 根）`), { statusCode: 400 })
  // 决策点 = atTime（缺省取最后一根已收盘）；前瞻必须完整存在于库内
  let decisionIdx = candles.length - 1 - forward
  if (input.atTime !== undefined) {
    decisionIdx = candles.findIndex((c) => c.closeTime > input.atTime!) - 1
    if (decisionIdx < lookback / 2) throw Object.assign(new Error('atTime 前可见K线不足'), { statusCode: 400 })
  }
  const decisionBar = candles[decisionIdx]
  const atTime = decisionBar.closeTime

  const visibleBars = candles.slice(Math.max(0, decisionIdx - lookback + 1), decisionIdx + 1)
  const bars = visibleBars.map((c) => ({
    time: c.openTime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: c.volume === null ? undefined : Number(c.volume),
    closed: c.isClosed,
    closeTime: c.closeTime,
  }))
  const analysis = analyzeBrooks(bars, { swingK: 3, asOf: atTime })
  const visibleContext = {
    barCount: bars.length,
    fromTime: bars[0]?.time ?? null,
    toTime: atTime,
    lastClose: decisionBar.close,
    regime: analysis?.summary.regime ?? null,
    alwaysIn: analysis?.alwaysIn.direction ?? null,
    swingCount: analysis?.swings.length ?? 0,
    signalKinds: [...new Set((analysis?.signals ?? []).map((s) => s.kind))],
    structureEventsKnown: (analysis?.events ?? []).filter((e) => e.knownAtTime !== null && e.knownAtTime <= atTime).length,
  }

  // 前瞻结果（决策后才可知）：区间收益与方向
  const forwardBarsList = candles.slice(decisionIdx + 1, decisionIdx + 1 + forward)
  const entry = Number(decisionBar.close)
  const exitBar = forwardBarsList[forwardBarsList.length - 1] ?? decisionBar
  const exit = Number(exitBar.close)
  const fwdReturn = entry !== 0 ? (exit - entry) / entry : 0
  const outcome = {
    forwardBars: forwardBarsList.length,
    exitClose: exitBar.close,
    returnPct: Number((fwdReturn * 100).toFixed(4)),
    direction: exit > entry ? 'up' : exit < entry ? 'down' : 'flat',
  }

  const rows = await db
    .insert(caseWindows)
    .values({
      symbol: input.symbol,
      marketType: input.marketType,
      interval: input.interval,
      atTime,
      visibleContext: visibleContext as unknown as Record<string, unknown>,
      outcome: outcome as unknown as Record<string, unknown>,
      annotation: input.annotation ?? '',
      createdBy,
      published: false,
    })
    .returning()
  log.ok('knowledge', '案例窗构建', kv({ 序列: `${input.symbol}/${input.interval}`, atTime, 状态: analysis?.summary.regime ?? 'n/a', 前瞻: `${outcome.direction} ${outcome.returnPct}%` }))
  return rows[0]
}

export async function listCaseWindows(publishedOnly = true): Promise<CaseWindowRow[]> {
  const db = getDb()
  if (!db) return []
  const q = db.select().from(caseWindows).orderBy(desc(caseWindows.atTime)).limit(200)
  return publishedOnly ? q.where(eq(caseWindows.published, true)) : q
}

export async function setCasePublished(id: string, published: boolean): Promise<CaseWindowRow> {
  const rows = await getDb()!
    .update(caseWindows)
    .set({ published })
    .where(eq(caseWindows.id, id))
    .returning()
  if (rows.length === 0) throw Object.assign(new Error('案例不存在'), { statusCode: 404 })
  return rows[0]
}

export async function getCaseWindow(id: string): Promise<CaseWindowRow | null> {
  const rows = await getDb()!.select().from(caseWindows).where(eq(caseWindows.id, id)).limit(1)
  return rows[0] ?? null
}

/** 案例检索视图：只含可见字段（outcome 由 admin 详情按需读取，绝不进检索结果） */
export async function publishedCasesForRetrieval(): Promise<
  { id: string; docVersionId: string; text: string; title: string; annotation: string }[]
> {
  const db = getDb()
  if (!db) return []
  const rows = await db
    .select()
    .from(caseWindows)
    .where(eq(caseWindows.published, true))
    .orderBy(desc(caseWindows.atTime))
    .limit(200)
  return rows.map((r) => {
    const vc = r.visibleContext as Record<string, unknown>
    const text = `${r.symbol} ${r.interval} 案例：决策时状态 ${vc.regime ?? ''}，always-in ${vc.alwaysIn ?? ''}，信号 ${Array.isArray(vc.signalKinds) ? (vc.signalKinds as string[]).join('、') : ''}。标注：${r.annotation}`
    return {
      id: `case:${r.id}`,
      docVersionId: `case:${r.id}#v1`,
      text,
      title: `案例：${r.symbol} ${r.interval}`,
      annotation: r.annotation,
    }
  })
}
