/**
 * 混合检索流水线（docs/specs/knowledge-rag.md）：
 * 术语归一+同义词 → 版本过滤 → 向量召回（pgvector，可用时）+ 词项召回（terms[] GIN）
 * → RRF 融合 → 可配置精排（未配置 rerank 能力则显式跳过并记录）→ 邻接上下文扩展。
 * 支持（support）/反证（counter）双路：counter 模式向词项集注入反证意图词。
 * 分数仅作排序参考，不当事实正确率。
 */
import { sql } from 'drizzle-orm'
import type { AgentCapabilities, SearchDebugResult, SearchHit } from 'biance-vision-brooks'
import type { KnowledgeChunkRow, RuleCardRow } from '../models.js'
import { getDb } from '../db.js'
import { getCapabilities, resolveSecret } from '../admin/capabilities.js'
import { ADMIN_VIEWER, PUBLIC_VIEWER, isRestrictedAccess } from './access.js'
import type { KnowledgeAccessContext } from './access.js'
import { resolveEmbeddingClient } from './embeddings.js'
import { extractCjkBigrams, extractLatinTokens, normalizeQueryTerms } from './terms.js'
import { docAccessMap, getAdjacentChunks, getChunkById, getDocument, getKnowledgeVersion, publishedDocVersionIds } from './store.js'
import { vectorSupportSync } from './vector.js'

/** 规则卡/案例的伪 chunk 行（检索与引用统一形状；页码/图号不适用为 null） */
function pseudoChunk(id: string, docVersionId: string, text: string): KnowledgeChunkRow {
  return {
    id,
    docId: id.split(':')[0],
    docVersionId,
    chunkIndex: 0,
    kind: 'text',
    text,
    pageNo: null,
    figureId: null,
    headingPath: [],
    terms: [],
    contentHash: '',
    createdAt: new Date(),
  }
}

export type SearchMode = 'support' | 'counter'

/** 反证检索的意图词（进入词项召回，不影响向量召回语义） */
const COUNTER_INTENT_TERMS = ['failure', 'fail', 'invalidation', 'counter', 'caution', '失效', '反例', '失败', '风险']

export interface SearchOptions {
  mode?: SearchMode
  /** 指定知识版本（缺省 = 最新发布）；绑定 Agent 版本时传入 */
  knowledgeVersionId?: string
  /** 显式 as-of 时刻（P0-4）：规则卡/案例层只返回该时刻前发布的行。
   * 缺省时若指定了 knowledgeVersionId 则取该版本的发布时刻（复现性：
   * run 冻结知识版本后新发布的规则卡/案例不进入该 run 检索）；两者都未指定则不过滤。 */
  knowledgeAsOf?: Date
  /** 召回候选数（起始值 40，评测可调） */
  candidateLimit?: number
  /** 最终保留数（起始值 8） */
  finalLimit?: number
  /** 显式关闭精排（即使能力已配置） */
  skipRerank?: boolean
  /** 显式关闭邻接扩展 */
  skipAdjacency?: boolean
  /** LLM 改写变体数上限（0/缺省=不启用，仅确定性变体；需 chat 能力，失败自动降级） */
  llmVariants?: number
  /** 冻结配置的能力（研究 run 内检索必传——配置冻结贯穿 RAG 执行，评审 F4）；
   * 缺省读全局生效配置（会话概念问答等非 run 路径） */
  /** 权限上下文（W1-A）：缺省=普通用户（安全默认——受限内容不进结果；漏传只会更保守）。
   * 用户路径按发起者角色构造（accessCtxFromSession/accessCtxForUser），管理端/评测显式传超管。 */
  access?: KnowledgeAccessContext
  caps?: AgentCapabilities | null
  /** run 冻结的 query-rewrite 提示词全文（P0-6：run 内改写只读冻结文本；缺省走注册表指针解析） */
  frozenQueryRewritePrompt?: string
}

export interface RetrievedChunk {
  chunk: KnowledgeChunkRow
  docTitle: string
  docSourceTier: string
  /** 邻接扩展命中的相邻切块（上下文用，不作为独立引用） */
  adjacent: KnowledgeChunkRow[]
}

export interface SearchOutcome {
  debug: SearchDebugResult
  hits: RetrievedChunk[]
  /** 无可用知识版本时为 true（来源不足的前置态） */
  noKnowledgeVersion: boolean
}

/** RRF 融合：score = Σ 1/(k + rank)；纯函数（自测直接覆盖） */
export function fuseRRF(lists: SearchHit[][], k = 60): SearchHit[] {
  const acc = new Map<string, number>()
  for (const list of lists) {
    list.forEach((hit, idx) => {
      acc.set(hit.chunkId, (acc.get(hit.chunkId) ?? 0) + 1 / (k + idx + 1))
    })
  }
  return [...acc.entries()]
    .map(([chunkId, score]) => ({ chunkId, score: Number(score.toFixed(6)) }))
    .sort((a, b) => b.score - a.score)
}

/** 查询变体（确定性 v1：命中术语的规范名拼接；改写模型接入后由此扩展） */
function buildVariants(query: string, matchedTerms: string[]): string[] {
  if (matchedTerms.length === 0) return []
  return [`${query} ${matchedTerms.slice(0, 4).join(' ')}`]
}

interface ChunkRowWithDoc extends KnowledgeChunkRow {
  docTitle: string | null
  docSourceTier: string | null
}

/** PG 数组字面量参数（drizzle sql 模板会把 JS 数组拆成多个标量参数，必须用字面量字符串） */
function pgArray(items: string[]): string {
  return `{${items.map((t) => JSON.stringify(t)).join(',')}}`
}

/** 原生 SQL 行 → camelCase（drizzle 查询构造器自动映射，db.execute 不会） */
function mapRawChunk(r: Record<string, unknown>): ChunkRowWithDoc {
  return {
    id: String(r.id),
    docId: String(r.doc_id),
    docVersionId: String(r.doc_version_id),
    chunkIndex: Number(r.chunk_index),
    kind: String(r.kind),
    text: String(r.text ?? ''),
    pageNo: r.page_no === null || r.page_no === undefined ? null : Number(r.page_no),
    figureId: r.figure_id === null || r.figure_id === undefined ? null : String(r.figure_id),
    headingPath: Array.isArray(r.heading_path) ? (r.heading_path as string[]) : [],
    terms: Array.isArray(r.terms) ? (r.terms as string[]) : [],
    contentHash: String(r.content_hash),
    createdAt: new Date(r.created_at as string),
    docTitle: r.doc_title === null || r.doc_title === undefined ? null : String(r.doc_title),
    docSourceTier: r.doc_source_tier === null || r.doc_source_tier === undefined ? null : String(r.doc_source_tier),
  }
}

async function fetchChunksWithDoc(ids: string[]): Promise<ChunkRowWithDoc[]> {
  if (ids.length === 0) return []
  const d = getDb()
  if (!d) return []
  const res = (await d.execute(sql`
    select c.*, d.title as doc_title, d.source_tier as doc_source_tier
    from knowledge_chunks c join knowledge_documents d on d.id = c.doc_id
    where c.id = any(${pgArray(ids)}::text[])`)) as unknown as
    | Record<string, unknown>[]
    | { rows: Record<string, unknown>[] }
  const rows = Array.isArray(res) ? res : res.rows
  return rows.map(mapRawChunk)
}

/** 精排客户端（Cohere/Jina 兼容 /rerank）；未配置返回 null（显式跳过）；
 * cap 由调用方传入（run 内为冻结配置，评审 F4），缺省读全局 */
async function tryRerank(
  query: string,
  docs: { chunkId: string; text: string }[],
  cap: AgentCapabilities['rerank'] | undefined,
): Promise<{ hits: SearchHit[]; note: string }> {
  if (!cap?.enabled || !cap.baseUrl || !cap.model) {
    return { hits: [], note: 'rerank 能力未配置，跳过精排' }
  }
  const key = resolveSecret(cap.secretRef)
  try {
    const res = await fetch(`${cap.baseUrl.replace(/\/+$/, '')}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: cap.model,
        query,
        documents: docs.map((d) => d.text.slice(0, 2000)),
        top_n: docs.length,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { hits: [], note: `rerank 接口 → ${res.status}，保留融合排序` }
    const json = (await res.json()) as { results?: { index: number; relevance_score?: number }[] }
    if (!json.results) return { hits: [], note: 'rerank 返回结构异常，保留融合排序' }
    const hits = json.results
      .filter((r) => docs[r.index] !== undefined)
      .map((r) => ({ chunkId: docs[r.index].chunkId, score: r.relevance_score ?? 0 }))
    return { hits, note: `rerank 完成（${hits.length} 条）` }
  } catch (err) {
    return { hits: [], note: `rerank 调用失败（${(err as Error).message}），保留融合排序` }
  }
}

export async function searchHybrid(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
  const candidateLimit = options.candidateLimit ?? 40
  const finalLimit = options.finalLimit ?? 8
  const notes: string[] = []
  // 能力配置：run 内检索消费冻结配置（评审 F4），非 run 路径读全局生效配置
  const caps = options.caps ?? getCapabilities()

  let versionIds = await publishedDocVersionIds(options.knowledgeVersionId)
  if (versionIds.length === 0) {
    return {
      debug: {
        query,
        variants: [],
        vectorHits: [],
        termHits: [],
        fused: [],
        reranked: [],
        adjacencyNotes: [],
        notes: ['无已发布知识版本，来源不足'],
        hits: [],
      },
      hits: [],
      noKnowledgeVersion: true,
    }
  }

  // W1-A 权限过滤（方案甲）：普通用户上下文剔除 purchase/member 文档的全部版本——
  // 词项与向量两路召回共用 versionIds，此一处过滤即覆盖两条路径；邻接扩展同文档自然安全
  const viewer = options.access ?? PUBLIC_VIEWER
  const accessOf = await docAccessMap([...new Set(versionIds.map((v) => v.split('#')[0]))])
  if (viewer.viewerRole !== 'superadmin') {
    const before = versionIds.length
    versionIds = versionIds.filter((v) => !isRestrictedAccess(accessOf.get(v.split('#')[0])))
    if (before !== versionIds.length) {
      notes.push(`权限过滤：${before - versionIds.length} 个受限文档版本对普通用户不可见`)
    }
    if (versionIds.length === 0) {
      return {
        debug: {
          query,
          variants: [],
          vectorHits: [],
          termHits: [],
          fused: [],
          reranked: [],
          adjacencyNotes: [],
          notes: ['已发布资料均受限（purchase/member），当前上下文无可检索内容'],
          hits: [],
        },
        hits: [],
        noKnowledgeVersion: false,
      }
    }
  }

  const { terms, matchedTerms } = normalizeQueryTerms(query)
  const allTerms = [...terms]
  if (options.mode === 'counter') allTerms.push(...COUNTER_INTENT_TERMS)
  const uniqTerms = [...new Set(allTerms)]
  // LLM 改写变体（options.llmVariants>0 且 chat 能力已配置）：进入词项并集与向量召回；
  // 未开启时确定性变体仅出现在 debug（与历史行为一致，不影响既有召回结果）
  const variants = buildVariants(query, matchedTerms)
  const llmVariantQueries: string[] = []
  if ((options.llmVariants ?? 0) > 0) {
    const { proposeLlmVariants } = await import('./queryRewrite.js')
    const proposed = await proposeLlmVariants(query, matchedTerms, options.llmVariants ?? 0, caps, options.frozenQueryRewritePrompt)
    notes.push(proposed.note)
    for (const v of proposed.variants) {
      if (v !== query && !variants.includes(v) && !llmVariantQueries.includes(v)) {
        variants.push(v)
        llmVariantQueries.push(v)
      }
    }
  }
  // 词项召回并集：原查询词项（+反证意图词）∪ LLM 变体词项
  const recallTerms = [...uniqTerms]
  for (const v of llmVariantQueries) {
    for (const t of normalizeQueryTerms(v).terms) if (!recallTerms.includes(t)) recallTerms.push(t)
  }

  const d = getDb()
  if (!d) throw new Error('数据库不可用')

  // 词项召回：terms[] 与查询词项交集计数
  let termHits: SearchHit[] = []
  try {
    const res = (await d.execute(sql`
      select id as chunk_id, count(*)::int as score
      from knowledge_chunks
      where doc_version_id = any(${pgArray(versionIds)}::text[]) and terms && ${pgArray(recallTerms)}::text[]
      group by id
      order by score desc, chunk_id
      limit ${candidateLimit}`)) as unknown as { chunk_id: string; score: number }[] | { rows: { chunk_id: string; score: number }[] }
    const rows = Array.isArray(res) ? res : res.rows
    termHits = rows.map((r) => ({ chunkId: r.chunk_id, score: r.score }))
  } catch (err) {
    notes.push(`词项召回失败：${(err as Error).message}`)
  }

  // 规则卡层 + 案例层召回（published；与原始资料层并列进 RRF，证据不泄漏案例 outcome）。
  // P0-4 as-of 过滤：指定知识版本（或显式 asOf）时，只召回该时刻前发布的规则卡/案例——
  // 原始资料层已按 publishedDocVersionIds 过滤，此处补齐第二/三层（§3.2.7-C 复现性缺口）
  let knowledgeAsOf = options.knowledgeAsOf
  if (knowledgeAsOf === undefined && options.knowledgeVersionId !== undefined) {
    const kvRow = await getKnowledgeVersion(options.knowledgeVersionId)
    knowledgeAsOf = kvRow?.createdAt ?? undefined
  }
  notes.push(
    knowledgeAsOf !== undefined
      ? `规则卡/案例 as-of 过滤：仅发布于 ${knowledgeAsOf.toISOString()} 之前的行`
      : '规则卡/案例 as-of 过滤：未启用（未指定知识版本，最新语义）',
  )
  const extraLists: SearchHit[][] = []
  // 召回层的历史快照（as-of 语义下的卡片/案例投影）：必须直接传到最终组装——
  // 最终阶段回查当前行会按「当前 published」过滤，旧卡归档/案例下架后历史候选被丢弃
  // （2026-10-19 二轮审查 P1：as-of 召回 1 条 → 组装剩 0 条的复现）
  const cardSnapshots = new Map<string, RuleCardRow>()
  const caseSnapshots = new Map<string, { id: string; docVersionId: string; text: string; title: string; annotation: string }>()
  try {
    const { publishedRuleCards, ruleCardToRetrievable, publishedCasesForRetrieval } = await import('./ruleCards.js')
    // W1-A 派生联动：卡片草拟引用（citations）的源文档**当前**受限时，普通用户不召回该卡——
    // 读取时按源文档当前 access 判定（源资料后来改受限，已发布卡片随之受限），非仅发布时检查。
    // 案例窗是内部交易标注（不派生自资料文档），无联动面
    const publishedCardList = await publishedRuleCards(knowledgeAsOf)
    let restrictedCardIds: Set<string> | null = null
    if (viewer.viewerRole !== 'superadmin') {
      const citedDocIds = new Set<string>()
      for (const card of publishedCardList) {
        for (const cit of card.citations) citedDocIds.add(cit.docVersionId.split('#')[0])
      }
      if (citedDocIds.size > 0) {
        const cardAccessOf = await docAccessMap([...citedDocIds])
        for (const [docId, acc] of cardAccessOf) {
          if (!isRestrictedAccess(acc)) cardAccessOf.delete(docId)
        }
        if (cardAccessOf.size > 0) {
          const restricted = new Set(cardAccessOf.keys())
          restrictedCardIds = new Set(
            publishedCardList
              .filter((c) => c.citations.some((cit) => restricted.has(cit.docVersionId.split('#')[0])))
              .map((c) => c.id),
          )
          if (restrictedCardIds.size > 0) {
            notes.push(`权限联动：${restrictedCardIds.size} 张规则卡因源文档受限对普通用户隐藏`)
          }
        }
      }
    }
    const cardHits: SearchHit[] = []
    for (const card of publishedCardList) {
      if (restrictedCardIds?.has(card.id)) continue
      const r = ruleCardToRetrievable(card)
      cardSnapshots.set(r.id, card)
      const docTerms = new Set([...extractLatinTokens(r.text.toLowerCase()), ...extractCjkBigrams(r.text), card.concept])
      const overlap = uniqTerms.filter((t) => docTerms.has(t)).length + (uniqTerms.includes(card.concept) ? 2 : 0)
      if (overlap > 0) cardHits.push({ chunkId: r.id, score: overlap })
    }
    if (cardHits.length > 0) extraLists.push(cardHits.sort((a, b) => b.score - a.score))
    const caseHits: SearchHit[] = []
    for (const c of await publishedCasesForRetrieval(knowledgeAsOf)) {
      caseSnapshots.set(c.id, c)
      const docTerms = new Set([...extractLatinTokens(`${c.title} ${c.text}`.toLowerCase()), ...extractCjkBigrams(c.text)])
      const overlap = uniqTerms.filter((t) => docTerms.has(t)).length
      if (overlap > 0) caseHits.push({ chunkId: c.id, score: overlap })
    }
    if (caseHits.length > 0) extraLists.push(caseHits.sort((a, b) => b.score - a.score))
  } catch (err) {
    notes.push(`规则卡/案例召回失败：${(err as Error).message}`)
  }

  // 向量召回：pgvector 可用 + embedding 能力已配置时执行，否则显式跳过；
  // LLM 变体（≤2 条，控制 embedding 成本）批量 embed、各自成列表进 RRF
  let vectorHits: SearchHit[] = []
  const vectorLists: SearchHit[][] = []
  const embedder = resolveEmbeddingClient(caps.embedding)
  if (vectorSupportSync() !== 'enabled') {
    notes.push('pgvector 未启用，向量召回跳过')
  } else if (!embedder) {
    notes.push('embedding 能力未配置，向量召回跳过')
  } else {
    const embedQueries = [query, ...llmVariantQueries.slice(0, 2)]
    try {
      const vecs = await embedder.embed(embedQueries)
      for (let i = 0; i < vecs.length; i++) {
        const literal = `[${vecs[i].map((n) => Number(n.toFixed(6))).join(',')}]`
        const res = (await d.execute(sql`
        select id as chunk_id, 1 - (embedding <=> ${literal}::vector) as score
        from knowledge_chunks
        where doc_version_id = any(${pgArray(versionIds)}::text[]) and embedding is not null
        order by embedding <=> ${literal}::vector
        limit ${candidateLimit}`)) as unknown as { chunk_id: string; score: number }[] | { rows: { chunk_id: string; score: number }[] }
        const rows = Array.isArray(res) ? res : res.rows
        const list = rows.map((r) => ({ chunkId: r.chunk_id, score: Number(r.score) }))
        if (i === 0) vectorHits = list
        vectorLists.push(list)
      }
    } catch (err) {
      notes.push(`向量召回失败（跳过）：${(err as Error).message}`)
    }
  }

  const fused = fuseRRF([termHits, ...extraLists, ...vectorLists]).slice(0, candidateLimit)

  // 精排：能力已配置且未显式关闭
  let reranked: SearchHit[] = []
  if (options.skipRerank) {
    notes.push('精排已显式关闭')
  } else if (fused.length > 0) {
    const top = fused.slice(0, 40)
    const rows = await fetchChunksWithDoc(top.map((h) => h.chunkId))
    const byId = new Map(rows.map((r) => [r.id, r]))
    const docs = top
      .map((h) => ({ chunkId: h.chunkId, text: byId.get(h.chunkId)?.text ?? '' }))
      .filter((x) => x.text !== '')
    const r = await tryRerank(query, docs, caps.rerank)
    reranked = r.hits
    notes.push(r.note)
  } else {
    notes.push('无融合候选，跳过精排')
  }

  let finalIds = (reranked.length > 0 ? reranked : fused).slice(0, finalLimit).map((h) => h.chunkId)
  // 规则卡/案例是人工审核的精选层：融合名次并列时可能被挤出席位，为其各保留 1 席
  for (const prefix of ['rulecard:', 'case:']) {
    const pick = fused.find((h) => h.chunkId.startsWith(prefix))
    if (pick !== undefined && !finalIds.includes(pick.chunkId)) {
      finalIds = [...finalIds.slice(0, finalLimit - 1), pick.chunkId]
    }
  }
  const chunkIds = finalIds.filter((id) => !id.startsWith('rulecard:') && !id.startsWith('case:'))
  const rows = await fetchChunksWithDoc(chunkIds)
  const byId = new Map<string, ChunkRowWithDoc | RetrievedChunk>(rows.map((r) => [r.id, r]))
  // 规则卡/案例命中（伪 chunk）：直接消费召回层快照（as-of 历史语义在此终结）——
  // 不回查当前行状态：旧卡归档/案例下架后，历史时刻召回的候选仍完整进入最终结果
  {
    const { ruleCardToRetrievable } = await import('./ruleCards.js')
    for (const id of finalIds) {
      if (byId.has(id)) continue
      if (id.startsWith('rulecard:')) {
        const card = cardSnapshots.get(id)
        if (card === undefined) continue
        const r = ruleCardToRetrievable(card)
        byId.set(id, {
          chunk: pseudoChunk(id, r.docVersionId, r.text),
          docTitle: `规则卡：${card.concept}`,
          docSourceTier: 'official_derivative',
          adjacent: [],
        })
      } else if (id.startsWith('case:')) {
        const c = caseSnapshots.get(id)
        if (c === undefined) continue
        byId.set(id, {
          chunk: pseudoChunk(id, c.docVersionId, c.text),
          docTitle: c.title,
          docSourceTier: 'community',
          adjacent: [],
        })
      }
    }
  }

  // 邻接上下文扩展：相邻切块进 adjacent，不作为独立引用
  const adjacencyNotes: string[] = []
  const hits: RetrievedChunk[] = []
  for (const id of finalIds) {
    const row = byId.get(id)
    if (!row) continue
    if (id.startsWith('rulecard:') || id.startsWith('case:')) {
      const special = row as RetrievedChunk
      hits.push({ chunk: special.chunk, docTitle: special.docTitle, docSourceTier: special.docSourceTier, adjacent: [] })
      continue
    }
    const chunkRow = row as ChunkRowWithDoc
    let adjacent: KnowledgeChunkRow[] = []
    if (!options.skipAdjacency) {
      adjacent = await getAdjacentChunks(chunkRow)
      if (adjacent.length > 0) {
        adjacencyNotes.push(
          `chunk#${chunkRow.chunkIndex} 扩展邻接：${adjacent.map((a) => `#${a.chunkIndex}`).join('、')}`,
        )
      }
    }
    hits.push({
      chunk: chunkRow,
      docTitle: chunkRow.docTitle ?? '',
      docSourceTier: chunkRow.docSourceTier ?? 'community',
      adjacent,
    })
  }

  const debug: SearchDebugResult = {
    query,
    variants,
    vectorHits: vectorHits.slice(0, 20),
    termHits: termHits.slice(0, 20),
    fused: fused.slice(0, 20),
    reranked: reranked.slice(0, 20),
    adjacencyNotes,
    notes,
    hits: [],
  }
  return { debug, hits, noKnowledgeVersion: false }
}

/**
 * 引用定位：取切块原文 + 邻接 + 所属文档信息（供 GET /chunks/:id）；规则卡/案例走各自存储。
 * W1-A：默认按普通用户上下文判权（安全默认）——受限文档的 chunk 与「源文档受限的规则卡」
 * 返回 null；管理端调用显式传超管。用户侧证据渲染走冻结快照不经过此处；
 * W2 用户侧原文预览将复用本判权。
 */
export async function fetchCitation(
  chunkId: string,
  options: { access?: KnowledgeAccessContext } = {},
): Promise<{ chunk: KnowledgeChunkRow; adjacent: KnowledgeChunkRow[]; docTitle: string; docSourceTier: string } | null> {
  const viewer = options.access ?? PUBLIC_VIEWER
  if (chunkId.startsWith('rulecard:') || chunkId.startsWith('case:')) {
    const { getRuleCard, ruleCardToRetrievable, getCaseWindow } = await import('./ruleCards.js')
    if (chunkId.startsWith('rulecard:')) {
      const card = await getRuleCard(chunkId.slice('rulecard:'.length))
      if (card === null) return null
      // 派生联动（与 searchHybrid 同语义）：源文档当前受限 → 普通用户不可定位
      if (viewer.viewerRole !== 'superadmin' && card.citations.length > 0) {
        const am = await docAccessMap([...new Set(card.citations.map((c) => c.docVersionId.split('#')[0]))])
        if (card.citations.some((c) => isRestrictedAccess(am.get(c.docVersionId.split('#')[0])))) return null
      }
      const r = ruleCardToRetrievable(card)
      return {
        chunk: pseudoChunk(r.id, r.docVersionId, r.text),
        adjacent: [],
        docTitle: `规则卡：${card.concept}（v${card.version}，${card.status}）`,
        docSourceTier: 'official_derivative',
      }
    }
    const cw = await getCaseWindow(chunkId.slice('case:'.length))
    if (cw === null) return null
    const vc = cw.visibleContext as Record<string, unknown>
    return {
      chunk: pseudoChunk(`case:${cw.id}`, `case:${cw.id}#v1`, `案例 ${cw.symbol}/${cw.interval}：${cw.annotation}（决策时 ${vc.regime ?? ''}）`),
      adjacent: [],
      docTitle: `案例：${cw.symbol} ${cw.interval}`,
      docSourceTier: 'community',
    }
  }
  const chunk = await getChunkById(chunkId)
  if (!chunk) return null
  const doc = await getDocument(chunk.docId)
  // W1-A：受限文档按当前 access 判权（原文读取按当前权限——历史快照三阶段语义的第三阶段）
  if (viewer.viewerRole !== 'superadmin' && isRestrictedAccess(doc?.access)) return null
  return {
    chunk,
    adjacent: await getAdjacentChunks(chunk),
    docTitle: doc?.title ?? '',
    docSourceTier: doc?.sourceTier ?? 'community',
  }
}
