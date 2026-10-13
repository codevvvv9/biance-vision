/**
 * 会话与意图规划（P2，improvement-plan §4.1）：
 * conversations/conversation_messages 持久化；意图路由（concept/structure/perp/event/replay/news/system）
 * 确定性 classifyIntent 在先 + LLM 叠加纠偏（见 intent.ts，chat 能力未配置时纯确定性）；
 * 复合问题的附加概念子问题内联附答（RAG 直引，不另起 run）；
 * 追问继承结构化上下文（「换成 1 小时」「改成 20 倍」生成新研究不覆盖已确认持仓）；
 * 自然语言提取的持仓信息先出确认卡，未经确认不落 portfolio。
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { PositionInputSchema } from 'biance-vision-brooks'
import { getDb } from '../../db.js'
import { conversationMessages, conversations, eventQuotes, portfolioPositions } from '../../models.js'
import type { ConversationMessageRow, ConversationRow } from '../../models.js'
import { createRun } from './store.js'
import { enqueueResearchRun } from './jobs.js'
import { classifyIntentOrchestrated } from './intent.js'
import { kv, log } from '../../logger.js'

export type Intent = 'concept' | 'structure' | 'perp' | 'event' | 'replay' | 'news' | 'system'

const SYMBOL_RE = /\b([A-Z0-9]{2,10}(?:USDT|USDC))\b/

/** 一周方向研究措辞：「预测/涨跌/走势/方向」+ 明示一周——研究模式而非事件合约研究 */
const DIRECTION_RESEARCH_RE = /预测|涨跌|走势|方向/
const WEEK_HORIZON_RE = /一周|下周|1\s*周|7\s*天|\b1w\b/i

export function classifyIntent(text: string): Intent {
  if (/什么是|解释|概念|术语|意思|怎么理解|定义/.test(text)) return 'concept'
  if (/复盘|历史|当时|回放|如果当时/.test(text)) return 'replay'
  if (/新闻|消息面|为什么涨|为什么跌|归因/.test(text)) return 'news'
  // 「预测 BTCUSDT 一周涨跌」→ 方向研究（return_positive 模型）：不得因「涨跌」
  // 关键字落入事件合约研究（1w 不是其产品期限，也没有可引用报价）
  if (DIRECTION_RESEARCH_RE.test(text) && WEEK_HORIZON_RE.test(text)) return 'structure'
  if (/事件|涨跌|高于|低于|执行价|到期|报价|结算/.test(text)) return 'event'
  if (/永续|持仓|仓位|做多|做空|加仓|减仓|杠杆|开仓|强平/.test(text)) return 'perp'
  return 'structure'
}

function parseHorizon(text: string): '10m' | '30m' | '1h' | '1d' | '1w' | null {
  if (/10\s*分钟/.test(text)) return '10m'
  if (/30\s*分钟|半小时/.test(text)) return '30m'
  if (/1\s*小时|一小时/.test(text)) return '1h'
  if (/1\s*天|一天/.test(text)) return '1d'
  if (/1\s*周|一周/.test(text)) return '1w'
  return null
}

/** 持仓草稿必填槽位（确认写入前必须齐全，与 PositionInputSchema 对齐，评审 F6） */
const POSITION_REQUIRED = ['symbol', 'side', 'qty', 'entryPrice', 'riskBudget'] as const
export function missingPositionFields(d: PositionDraft): string[] {
  return POSITION_REQUIRED.filter((k) => d[k] === undefined || d[k] === null)
}
const POSITION_FIELD_LABEL: Record<string, string> = {
  symbol: '交易对',
  side: '方向（做多/做空）',
  qty: '数量',
  entryPrice: '开仓价',
  riskBudget: '风险预算（最多可亏 USDT）',
}

/** 复盘消息的显式日期解析（评审 F7）：「2026-10-01 / 2026/10/1 / 2026年10月1日 / 10月1日」，
 * 按 UTC+8 当日 23:59:59 解析（复盘该日全天）；未来日期/非法日期返回 'invalid'，无日期返回 undefined */
export function parseReplayAsOf(text: string, now = Date.now()): number | 'invalid' | undefined {
  if (/前天/.test(text)) return now - 48 * 3600_000
  if (/昨天/.test(text)) return now - 24 * 3600_000
  const dm = text.match(/(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/)
  if (dm === null) return undefined
  const year = dm[1] !== undefined ? Number(dm[1]) : new Date(now).getUTCFullYear()
  const month = Number(dm[2])
  const day = Number(dm[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return 'invalid'
  // UTC+8 当日 23:59:59 = UTC 15:59:59
  const t = Date.UTC(year, month - 1, day, 15, 59, 59)
  const d = new Date(t)
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return 'invalid'
  if (t > now) return 'invalid'
  return t
}
/** 持仓草稿提取（简单槽位；未经确认不落库） */
export interface PositionDraft {
  symbol?: string
  side?: 'long' | 'short'
  qty?: number
  entryPrice?: number
  leverage?: number
  riskBudget?: number
}
export function extractPositionDraft(text: string): PositionDraft {
  const draft: PositionDraft = {}
  const sym = text.match(SYMBOL_RE)
  if (sym !== null) draft.symbol = sym[1]
  if (/做多|多头|long/i.test(text)) draft.side = 'long'
  if (/做空|空头|short/i.test(text)) draft.side = 'short'
  const qty = text.match(/(\d+(?:\.\d+)?)\s*(?:个|枚)?(?:BTC|ETH|币)?(?:，|,|\s).*?(?:做多|做空|开多|开空|long|short)/i) ?? text.match(/(?:做多|做空|开多|开空)\s*(\d+(?:\.\d+)?)/i)
  if (qty !== null) draft.qty = Number(qty[1])
  const entry = text.match(/(?:开仓价|入场|成本|entry)[约为：:\s]*(\d+(?:\.\d+)?)/i)
  if (entry !== null) draft.entryPrice = Number(entry[1])
  const lev = text.match(/(\d+)\s*倍杠杆|杠杆\s*(\d+)\s*倍/i)
  if (lev !== null) draft.leverage = Number(lev[1] ?? lev[2])
  const rb = text.match(/(?:风险预算|最多亏|可承受)[约为：:\s]*(\d+(?:\.\d+)?)/i)
  if (rb !== null) draft.riskBudget = Number(rb[1])
  return draft
}

export async function createConversation(userId: string, title = ''): Promise<ConversationRow> {
  const rows = await getDb()!.insert(conversations).values({ userId, title }).returning()
  return rows[0]
}

export async function getConversationForUser(id: string, userId: string): Promise<ConversationRow | null> {
  const rows = await getDb()!.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, userId))).limit(1)
  return rows[0] ?? null
}

export async function listConversations(userId: string): Promise<ConversationRow[]> {
  return getDb()!.select().from(conversations).where(eq(conversations.userId, userId)).orderBy(desc(conversations.updatedAt)).limit(50)
}

export async function listMessages(conversationId: string, after?: string, limit = 50): Promise<ConversationMessageRow[]> {
  const all = await getDb()!
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(asc(conversationMessages.createdAt))
    .limit(500)
  if (after === undefined || after === '') return all.slice(-limit)
  const idx = all.findIndex((m) => m.id === after)
  return idx >= 0 ? all.slice(idx + 1) : all.slice(-limit)
}

async function appendMessage(input: {
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  intent?: Intent | null
  runId?: string | null
  card?: Record<string, unknown> | null
}): Promise<ConversationMessageRow> {
  const rows = await getDb()!
    .insert(conversationMessages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      intent: input.intent ?? null,
      runId: input.runId ?? null,
      card: input.card ?? null,
    })
    .returning()
  await getDb()!.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, input.conversationId))
  return rows[0]
}

/** PATCH /api/conversations/:id/context：保存用户确认的上下文（含确认卡落库持仓） */
export async function patchContext(
  conv: ConversationRow,
  patch: Record<string, unknown>,
): Promise<{ context: Record<string, unknown>; confirmedPositionId: string | null }> {
  // 顶栏字段校验（聊天上下文同步修复）：symbol/marketType/horizon/product 由前端
  // 顶栏同步进来——聊天里不带交易对措辞的研究必须按顶栏当前值定位行情，
  // 否则会打到旧 symbol 的行情上。非法值整体 400，不静默丢弃也不部分合并。
  const CTX_SYMBOL_RE = /^[A-Z0-9]{4,20}$/
  const HORIZONS = ['10m', '30m', '1h', '1d', '1w']
  if (patch.symbol !== undefined && (typeof patch.symbol !== 'string' || !CTX_SYMBOL_RE.test(patch.symbol))) {
    throw Object.assign(new Error('symbol 不合法'), { statusCode: 400 })
  }
  if (patch.marketType !== undefined && patch.marketType !== 'spot' && patch.marketType !== 'usdm_perp') {
    throw Object.assign(new Error('marketType 不合法'), { statusCode: 400 })
  }
  if (patch.horizon !== undefined && !HORIZONS.includes(String(patch.horizon))) {
    throw Object.assign(new Error('horizon 不合法'), { statusCode: 400 })
  }
  if (patch.product !== undefined && patch.product !== 'perp' && patch.product !== 'event' && patch.product !== 'teaching') {
    throw Object.assign(new Error('product 不合法'), { statusCode: 400 })
  }
  const ctx = { ...(conv.context as Record<string, unknown>), ...patch }
  let confirmedPositionId: string | null = null
  // 确认卡落库：draft + confirm → 共享 PositionInputSchema 校验通过才写 portfolio（评审 F6）；
  // 幂等：同一草稿指纹重复确认不重复建仓（双击/重试安全），返回已落库持仓；
  // 确认成功后清除待补齐草稿，完成闭环
  const draftRaw = patch.positionDraft
  if (typeof draftRaw === 'object' && draftRaw !== null && patch.confirm === true) {
    const d = draftRaw as { symbol?: string; side?: string; qty?: number; entryPrice?: number; leverage?: number; riskBudget?: number }
    const fp = JSON.stringify([d.symbol ?? null, d.side ?? null, d.qty ?? null, d.entryPrice ?? null, d.riskBudget ?? null, d.leverage ?? null])
    const prevCtx = conv.context as { confirmedDraftFp?: string; positionId?: string | null }
    if (prevCtx.confirmedDraftFp === fp && typeof prevCtx.positionId === 'string' && prevCtx.positionId !== '') {
      confirmedPositionId = prevCtx.positionId
    } else {
      const parsed = PositionInputSchema.safeParse({
        symbol: d.symbol,
        side: d.side,
        qty: d.qty === undefined ? undefined : String(d.qty),
        entryPrice: d.entryPrice === undefined ? undefined : String(d.entryPrice),
        leverage: d.leverage ?? 10,
        marginMode: 'isolated',
        riskBudget: d.riskBudget === undefined ? undefined : String(d.riskBudget),
        confirmedAt: Date.now(),
      })
      if (parsed.success) {
        const rows = await getDb()!
          .insert(portfolioPositions)
          .values({
            userId: conv.userId,
            symbol: parsed.data.symbol,
            side: parsed.data.side,
            qty: parsed.data.qty,
            entryPrice: parsed.data.entryPrice,
            leverage: parsed.data.leverage,
            marginMode: parsed.data.marginMode,
            riskBudget: parsed.data.riskBudget,
            confirmedAt: parsed.data.confirmedAt,
          })
          .returning()
        confirmedPositionId = rows[0].id
        ctx.positionId = confirmedPositionId
        ctx.confirmedDraftFp = fp
        ctx.draft = null
      }
    }
  }
  for (const k of ['positionId', 'quoteId']) {
    if (ctx[k] === '') ctx[k] = null
  }
  await getDb()!.update(conversations).set({ context: ctx, updatedAt: new Date() }).where(eq(conversations.id, conv.id))
  return { context: ctx, confirmedPositionId }
}

export interface ConversationReply {
  message: ConversationMessageRow
  runId: string | null
  needCompletion: string[]
}

/** POST /api/conversations/:id/messages：意图路由 → 创建研究（继承上下文）或直接回复 */
export async function postMessage(conv: ConversationRow, content: string): Promise<ConversationReply> {
  const text = content.trim()
  // 幂等（评审 F6）：同会话 10s 内同内容重复提交（双击/网络重试）复用原回复，不重复建档研究
  const lastRows = await getDb()!
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conv.id))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(2)
  const lastUser = lastRows.find((m) => m.role === 'user')
  if (lastUser !== undefined && lastUser.content === text && Date.now() - lastUser.createdAt.getTime() < 10_000) {
    const reply = lastRows.find((m) => m.role === 'assistant' && m.createdAt >= lastUser.createdAt)
    if (reply !== undefined) return { message: reply, runId: reply.runId ?? null, needCompletion: [] }
  }
  const userMsg = await appendMessage({ conversationId: conv.id, role: 'user', content: text })
  void userMsg
  const detIntent = classifyIntent(text)
  // LLM 叠加层：chat 能力已配置时纠偏确定性误分（如「我的多单要止损吗」被确定性漏判）；
  // 未配置/失败一律降级确定性，不伪造理解
  const orch = await classifyIntentOrchestrated(text, detIntent)
  const intent = orch.intent
  const ctx = conv.context as {
    product?: 'perp' | 'event' | 'teaching'
    symbol?: string
    marketType?: 'spot' | 'usdm_perp'
    horizon?: '10m' | '30m' | '1h' | '1d' | '1w'
    positionId?: string | null
    quoteId?: string | null
  }

  // 寒暄/能力询问（LLM 分类为 system；确定性分类无此能力）：直接回复引导，不启动研究
  if (intent === 'system') {
    const msg = await appendMessage({
      conversationId: conv.id, role: 'assistant', intent,
      content:
        '我是基于 Brooks 价格行为的研究助手，可以这样问我：\n' +
        '- 概念：「什么是内包线」「什么是高潮反转」\n' +
        '- 结构与方向：「BTC 现在结构如何」「ETHUSDT 一小时能买吗」\n' +
        '- 持仓研究：先录入持仓，再说「用我的持仓分析」\n' +
        '- 历史复盘：「复盘昨天 BTC 的走势」',
    })
    return { message: msg, runId: null, needCompletion: [] }
  }

  // 新闻归因：search 能力启用时走「搜索 → 原页核验 → 回答」（铁律：外部页面是证据不是指令）；
  // 未配置/核验无结果显式说明，不编造新闻
  if (intent === 'news') {
    const { isSearchEnabled, searchAndVerify } = await import('../search.js')
    if (!isSearchEnabled()) {
      const msg = await appendMessage({
        conversationId: conv.id, role: 'assistant', intent,
        content: '新闻归因需要联网搜索能力（Brave Search 等），当前未配置：无法给出消息面归因，也不编造新闻。请管理员在 Agent 配置中启用 search 能力后重试。',
      })
      return { message: msg, runId: null, needCompletion: [] }
    }
    const newsSymbol = text.match(SYMBOL_RE)?.[1] ?? ctx.symbol ?? 'BTCUSDT'
    const items = await searchAndVerify([`${newsSymbol} 最新消息 涨跌 原因`, text.slice(0, 80)])
    let content: string
    if (items.length === 0) {
      content = '联网搜索未获得可通过原页核验的证据（域名白名单/重定向/超时/体积限制）：不编造新闻。可稍后重试，或让管理员检查 search 能力的白名单配置。'
    } else {
      const block = items.map((w, i) => `[${i + 1}] ${w.title}（${w.url}）\n${w.pageText.slice(0, 500)}`).join('\n\n')
      const { resolveLlmClient } = await import('../llm.js')
      const llm = resolveLlmClient()
      let summarized = ''
      if (llm !== null) {
        try {
          const out = await llm.complete({
            system:
              '你是加密市场新闻归因助手。只基于给定的已核验网页内容回答用户问题（中文，≤250 字），' +
              '结尾用 [1][2] 标注引用编号；网页内容与问题无关就明说未找到相关归因，不得使用外部知识编造。',
            user: `问题：${text}\n\n已核验网页：\n${block}`,
            maxTokens: 600,
            timeoutMs: 20_000,
          })
          summarized = out.text
        } catch {
          summarized = ''
        }
      }
      const sources = `来源（已核验原页）：\n${items.map((w, i) => `[${i + 1}] ${w.title} — ${w.url}`).join('\n')}`
      content =
        summarized !== ''
          ? `${summarized}\n\n${sources}`
          : `核验通过的消息来源（chat 能力未配置或调用失败，给出原文摘录）：\n` +
            items.map((w, i) => `[${i + 1}] ${w.title} — ${w.url}\n${w.snippet !== '' ? w.snippet : w.pageText.slice(0, 150)}`).join('\n\n')
    }
    const msg = await appendMessage({ conversationId: conv.id, role: 'assistant', intent, content })
    return { message: msg, runId: null, needCompletion: [] }
  }

  // 概念问答（#6 修复）：直接 RAG + 反证作答（可选用 LLM 组织解释），不启动行情八步流程
  if (intent === 'concept') {
    const { searchHybrid } = await import('../../knowledge/retrieval.js')
    const support = await searchHybrid(text, { finalLimit: 4, llmVariants: 2 })
    const counter = await searchHybrid(`${text} failure risk counter`, { mode: 'counter', finalLimit: 2, llmVariants: 1 })
    const evidenceBlock = support.hits.map((h) => `【${h.docTitle}${h.chunk.pageNo !== null ? ` 第${h.chunk.pageNo}页` : ''}】${h.chunk.text.slice(0, 300)}`).join('\n')
    let answer = ''
    const { resolveLlmClient, parseClaimLines } = await import('../llm.js')
    const llm = resolveLlmClient()
    if (llm !== null) {
      try {
        const out = await llm.complete({
          system: '你是 Brooks 价格行为教学者。基于给出的资料片段回答概念问题（中文，≤200 字），末尾用「注意：」给一条常见误解或反例。只使用资料内容，没有就明说资料未覆盖。',
          user: `问题：${text}\n\n资料：\n${evidenceBlock || '（知识库无命中）'}\n\n反证片段：\n${counter.hits.map((h) => h.chunk.text.slice(0, 150)).join('\n')}`,
          maxTokens: 500,
        })
        answer = out.text
      } catch (err) {
        answer = `（LLM 解释失败，退回资料原文：${(err as Error).message.slice(0, 80)}）`
      }
    }
    if (answer === '' && support.hits.length > 0) {
      answer = `资料依据：\n${evidenceBlock}`
    }
    if (support.hits.length === 0) {
      answer = '知识库未命中相关资料：不编造解释。可在知识库导入 Brooks 官方术语表/手册后重试。'
    }
    const msg = await appendMessage({ conversationId: conv.id, role: 'assistant', intent, content: answer })
    return { message: msg, runId: null, needCompletion: [] }
  }

  const symbolMatch = text.match(SYMBOL_RE)?.[1] ?? null
  const symbol = symbolMatch ?? ctx.symbol ?? 'BTCUSDT'
  const horizon = parseHorizon(text) ?? ctx.horizon ?? '1h'
  const marketType = /现货/.test(text) ? 'spot' : ctx.marketType ?? 'usdm_perp'
  // 方向研究（「预测 X 一周涨跌」）：研究模式（teaching + 1w → 方向研究分支），
  // 不继承 perp/event 产品；event 意图但明示一周同样降级（1w 非事件合约期限）
  const directionResearch = DIRECTION_RESEARCH_RE.test(text) && horizon === '1w'
  const product =
    directionResearch || (horizon === '1w' && (intent === 'event' || ctx.product === 'event'))
      ? 'teaching'
      : intent === 'perp'
        ? 'perp'
        : intent === 'event'
          ? 'event'
          : ctx.product ?? 'teaching'

  // 交易对一致性（九轮修复）：消息切换 symbol 后，上下文里旧交易对的持仓/报价
  // 引用不再带入新研究（BTC 入场价不得混入 ETH 行情）；切回原交易对自动恢复引用
  const contextNotes: string[] = []
  let positionId: string | null = product === 'perp' ? (ctx.positionId ?? null) : null
  if (positionId !== null) {
    const posRows = await getDb()!
      .select({ symbol: portfolioPositions.symbol })
      .from(portfolioPositions)
      .where(and(eq(portfolioPositions.id, positionId), eq(portfolioPositions.userId, conv.userId)))
      .limit(1)
    if (posRows[0] !== undefined && posRows[0].symbol !== symbol) {
      contextNotes.push(`已切换到 ${symbol}：原 ${posRows[0].symbol} 持仓不适用于该交易对，本次按无持仓研究（切回 ${posRows[0].symbol} 时自动恢复引用）`)
      positionId = null
    }
  }
  let quoteId: string | null = product === 'event' ? (ctx.quoteId ?? null) : null
  if (quoteId !== null) {
    const quoteRows = await getDb()!
      .select({ symbol: eventQuotes.symbol })
      .from(eventQuotes)
      .where(and(eq(eventQuotes.id, quoteId), eq(eventQuotes.userId, conv.userId)))
      .limit(1)
    if (quoteRows[0] !== undefined && quoteRows[0].symbol !== symbol) {
      contextNotes.push(`已切换到 ${symbol}：原 ${quoteRows[0].symbol} 报价不适用于该交易对，本次未引用报价（EV 不可计算）`)
      quoteId = null
    }
  }
  // event 意图被降级为方向研究时的显式提示（classifyIntent 已把「预测+一周」
  // 路由到 structure；走到这里的是「高于 X」等执行价语义但明示一周的消息）
  if (product === 'teaching' && horizon === '1w' && intent === 'event') {
    contextNotes.push('一周预测按方向研究模式处理（1w 非币安事件合约产品期限，输出周收益分布而非相对执行价的到期结算概率）')
  }

  // 持仓草稿 → 确认卡（评审 F6：槽位合并补齐闭环——待确认草稿持久化在会话上下文，
  // 后续消息提取的槽位合并进草稿；字段齐全后才可确认，确认写入走共享 schema）
  const draft = extractPositionDraft(text)
  const touched = (['symbol', 'side', 'qty', 'entryPrice', 'leverage', 'riskBudget'] as const).filter((k) => draft[k] !== undefined)
  const pendingDraftRaw = (ctx as { draft?: PositionDraft | null }).draft
  const pendingDraft = pendingDraftRaw != null ? pendingDraftRaw : undefined
  const pendingMissing = pendingDraft !== undefined ? missingPositionFields(pendingDraft) : []
  const fillsGap = touched.some((k) => pendingMissing.includes(k))
  if (pendingDraft !== undefined && /取消|放弃|不要了/.test(text)) {
    await getDb()!.update(conversations).set({ context: { ...ctx, draft: null }, updatedAt: new Date() }).where(eq(conversations.id, conv.id))
    const msg = await appendMessage({ conversationId: conv.id, role: 'assistant', intent, content: '已丢弃待确认的持仓草稿，未写入持仓。' })
    return { message: msg, runId: null, needCompletion: [] }
  }
  if (
    (pendingDraft !== undefined && (fillsGap || (intent === 'perp' && touched.length > 0))) ||
    (intent === 'perp' && pendingDraft === undefined && draft.side !== undefined && draft.qty !== undefined)
  ) {
    const merged = { ...(pendingDraft ?? {}), ...Object.fromEntries(touched.map((k) => [k, draft[k]])) } as PositionDraft
    if (merged.symbol === undefined) merged.symbol = symbol
    const missing = missingPositionFields(merged)
    await getDb()!.update(conversations).set({ context: { ...ctx, draft: merged }, updatedAt: new Date() }).where(eq(conversations.id, conv.id))
    const msg = await appendMessage({
      conversationId: conv.id, role: 'assistant', intent,
      content:
        missing.length === 0
          ? '持仓信息已齐，请核对确认卡（确认后才会计入你的持仓；重复确认不会重复建仓）。'
          : `已记录持仓草稿，还缺：${missing.map((k) => POSITION_FIELD_LABEL[k] ?? k).join('、')}。请补充（例如「入场 60000，最多亏 200」），或回复「取消」丢弃草稿。`,
      card: { kind: 'confirm_position', draft: merged as Record<string, unknown>, missingFields: missing, complete: missing.length === 0 },
    })
    return { message: msg, runId: null, needCompletion: missing.length === 0 ? ['confirm_position'] : missing.map((k) => `position_${k}`) }
  }

  // 杠杆假设（#6 修复）：「改成 20 倍」→ 假设研究（新 run 带 override，不写回持仓）
  const levMatch = text.match(/(?:改成|换成|调整到|用)\s*(\d{1,3})\s*倍/)
  const positionOverride = levMatch !== null ? { leverage: Math.max(1, Math.min(125, Number(levMatch[1]))) } : undefined

  // 复盘（评审 F7）：解析历史 asOf（「昨天/前天」或显式日期）；无法解析必须请求补全，
  // 不得静默用当前时间冒充历史研究
  let asOf: number | undefined
  if (intent === 'replay') {
    const parsed = parseReplayAsOf(text)
    if (parsed === 'invalid' || parsed === undefined) {
      const msg = await appendMessage({
        conversationId: conv.id, role: 'assistant', intent,
        content:
          parsed === 'invalid'
            ? '复盘日期无法解析（或指向未来）：请给出有效日期（如「复盘 2026-10-01 的 BTC」）或相对时间（「昨天」「前天」）。不使用当前行情冒充历史复盘。'
            : '复盘需要明确的历史时点：请给出日期（如「复盘 2026-10-01 的 BTC」）或相对时间（「昨天」「前天」）。不使用当前行情冒充历史复盘。',
      })
      return { message: msg, runId: null, needCompletion: ['replay_asOf'] }
    }
    asOf = parsed
  }

  // 「现在呢」→ 新快照（asOf 缺省即当前）；「改成 20 倍」→ 假设研究（不覆盖持仓）
  const run = await createRun({
    userId: conv.userId,
    conversationId: conv.id,
    create: {
      product,
      symbol,
      marketType,
      horizon,
      question: text,
      positionId: positionId ?? undefined,
      quoteId: quoteId ?? undefined,
      positionOverride,
      asOf,
    },
  })
  const queued = await enqueueResearchRun(run.id)
  // 上下文回写（继承）
  await getDb()!
    .update(conversations)
    .set({
      context: { ...ctx, product, symbol, marketType, horizon },
      title: conv.title === '' ? text.slice(0, 40) : conv.title,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conv.id))

  const intentLabel: Record<Intent, string> = {
    concept: '概念问答', structure: '当前结构', perp: '永续持仓', event: '事件研究',
    replay: '历史复盘', news: '新闻归因', system: '系统',
  }
  const asOfNote = asOf !== undefined ? `（历史复盘 asOf=${new Date(asOf).toLocaleString()}，只用当时可见数据）` : ''
  const directionNote = directionResearch ? '（一周方向研究：研究模式输出分布，非事件合约参与建议）' : ''
  // 子问题拆分：复合问题中主意图覆盖不了的附加概念问题（≤1）内联附答（RAG 直引，不另起 run）
  let subAnswer = ''
  for (const sub of orch.subQuestions.slice(0, 1)) {
    if (classifyIntent(sub) !== 'concept') continue
    try {
      const { searchHybrid } = await import('../../knowledge/retrieval.js')
      const r = await searchHybrid(sub, { finalLimit: 2, llmVariants: 1, skipRerank: true })
      const top = r.hits[0]
      if (top !== undefined) {
        subAnswer =
          `\n\n附加问题「${sub}」：${top.chunk.text.slice(0, 200)}……` +
          `（来源：${top.docTitle}${top.chunk.pageNo !== null ? ` 第${top.chunk.pageNo}页` : ''}）`
      }
    } catch {
      /* 附答失败不影响主研究流程 */
    }
  }
  const msg = await appendMessage({
    conversationId: conv.id,
    role: 'assistant',
    intent,
    runId: run.id,
    content:
      `按「${intentLabel[intent]} · ${symbol} · ${horizon}」${asOfNote}${directionNote}启动研究：` +
      `已冻结行情输入包与配置版本，结构、检索、计算与校验完成后给出结论与证据。` +
      (contextNotes.length > 0 ? `${contextNotes.join('；')}。` : '') +
      (queued ? '' : '（执行队列暂不可用，运行已建档待重投）') +
      subAnswer +
      `可继续追问（如「换成 ETHUSDT」「改成 1 小时」「现在呢」）。`,
  })
  log.ok('conversation', '消息路由', kv({ 会话: conv.id.slice(0, 8), 意图: intent, 产品: product, run: run.id.slice(0, 8) }))
  return { message: msg, runId: run.id, needCompletion: [] }
}
