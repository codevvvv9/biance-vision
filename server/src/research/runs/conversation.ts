import { memberCalls } from '../../membership/context.js'
import { membershipError } from '../../membership/service.js'
/**
 * 会话与意图规划（P2，improvement-plan §4.1）：
 * conversations/conversation_messages 持久化；意图路由（concept/structure/perp/event/replay/news/system）
 * 确定性 classifyIntent 在先 + LLM 叠加纠偏（见 intent.ts，chat 能力未配置时纯确定性）；
 * 复合问题的附加概念子问题内联附答（RAG 直引，不另起 run）；
 * 追问继承结构化上下文（「换成 1 小时」「改成 20 倍」生成新研究不覆盖已确认持仓）；
 * 自然语言提取的持仓信息先出确认卡，未经确认不落 portfolio。
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { PositionInputSchema } from 'biance-vision-brooks'
import { getDb } from '../../db.js'
import { conversationMessages, conversations, eventQuotes, portfolioPositions } from '../../models.js'
import type { ConversationMessageRow, ConversationRow } from '../../models.js'
import { createRun } from './store.js'
import { enqueueResearchRun } from './jobs.js'
import { classifyIntentOrchestrated } from './intent.js'
import { assembleTrustedReply } from './replyAssembler.js'
import { resolveScene } from '../scenes.js'
import { kv, log } from '../../logger.js'

export type Intent = 'concept' | 'structure' | 'perp' | 'event' | 'replay' | 'news' | 'system' | 'translate'

const SYMBOL_RE = /\b([A-Z0-9]{2,10}(?:USDT|USDC))\b/

/** 一周方向研究措辞：「预测/涨跌/走势/方向」+ 明示一周——研究模式而非事件合约研究 */
const DIRECTION_RESEARCH_RE = /预测|涨跌|走势|方向/
const WEEK_HORIZON_RE = /一周|下周|1\s*周|7\s*天|\b1w\b/i

/** 翻译请求措辞（classifyIntent 最高优先级；与 translate.ts 的 parseTranslateRequest 同源语义） */
const TRANSLATE_RE = /翻译|译成|翻译成|翻成|译为|帮我译|translate|translation/i

export function classifyIntent(text: string): Intent {
  // 翻译请求最高优先：明确的「翻译/译成/translate」指令不得落入其他意图
  if (TRANSLATE_RE.test(text)) return 'translate'
  if (/什么是|解释|概念|术语|意思|怎么理解|定义/.test(text)) return 'concept'
  if (/复盘|历史|当时|回放|如果当时/.test(text)) return 'replay'
  if (/新闻|消息面|为什么涨|为什么跌|为什么大涨|为什么大跌|归因/.test(text)) return 'news'
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

/**
 * 事件报价草稿槽位（缺输入前置追问，对齐持仓草稿 F6 模式）：
 * 官方无报价查询接口，赔率只能来自用户从 App 抄录的投入/返还——
 * event 研究缺报价时先追问补全或降级结构研究，不再默默跑完输出「不可用」。
 */
interface QuoteDraft {
  direction?: 'above' | 'below'
  strikePrice?: number
  stake?: number
  totalPayout?: number
  horizon?: '10m' | '30m' | '1h' | '1d' | '1w'
}
const QUOTE_FIELD_LABEL: Record<keyof QuoteDraft, string> = {
  direction: '方向（高于/低于执行价）',
  strikePrice: '执行价（如 60000）',
  stake: '投入金额',
  totalPayout: '含本金总返还（App 展示的返还，不是净赚）',
  horizon: '期限（10 分钟/30 分钟/1 小时/1 天）',
}
const QUOTE_FIELDS = Object.keys(QUOTE_FIELD_LABEL) as (keyof QuoteDraft)[]
export function missingQuoteFields(d: QuoteDraft): (keyof QuoteDraft)[] {
  return QUOTE_FIELDS.filter((k) => d[k] === undefined || d[k] === null || (typeof d[k] === 'number' && !Number.isFinite(d[k])))
}

/**
 * 纯结构语义问句（A 修）：问「结构」且不含任何事件/赔率词。这类问题不依赖
 * 事件报价，不得被 LLM 纠偏或上下文残留路由进 event 产品线（缺报价时核心
 * 输出会被砍成「不可用」，晾住用户）。仅对确定性 structure 分类生效。
 */
const EVENT_SEMANTIC_RE = /事件|高于|低于|执行价|到期|报价|结算|胜率|概率|赔率|平价|EV/i
export function isStructureOnlyQuestion(text: string, deterministicIntent: Intent = classifyIntent(text)): boolean {
  return deterministicIntent === 'structure' && /结构/.test(text) && !EVENT_SEMANTIC_RE.test(text)
}
/** 口述报价提取：「BTC 高于 60000，投 10 返 17，10 分钟」→ direction/strike/stake/totalPayout/horizon */
export function extractQuoteDraft(text: string): QuoteDraft {
  const d: QuoteDraft = {}
  const dirAbove = /(?:高于|以上|大于|大于等于)/.test(text)
  const dirBelow = /(?:低于|以下|小于|小于等于)/.test(text)
  if (dirAbove !== dirBelow) d.direction = dirAbove ? 'above' : 'below'
  const strike = text.match(/(?:高于|以上|大于等于|大于|低于|以下|小于等于|小于)\s*([\d,]+(?:\.\d+)?)/)
  if (strike !== null) {
    const v = Number(strike[1].replace(/,/g, ''))
    if (Number.isFinite(v) && v > 0) d.strikePrice = v
  }
  const payout = text.match(/投(?:入)?\s*([\d,]+(?:\.\d+)?)\s*(?:U?SDT)?[,，。；、\s]*(?:返(?:还|还|回)?|得|赚|收)\s*(?:回?\s*)?([\d,]+(?:\.\d+)?)/)
  if (payout !== null) {
    const stake = Number(payout[1].replace(/,/g, ''))
    const total = Number(payout[2].replace(/,/g, ''))
    if (Number.isFinite(stake) && stake > 0) d.stake = stake
    if (Number.isFinite(total) && total > 0) d.totalPayout = total
  }
  const h = parseHorizon(text)
  if (h !== null) d.horizon = h
  return d
}

/** 时刻解析（UTC+8 本地钟点）：支持「10:00 / 10:30:25 / 10点30分 / 10时30分」与
 * 凌晨/早上/上午/中午/下午/晚上 限定词。有限定词但解析不出时刻 → 'invalid'
 *（显式时间不可解析必须请求补全，评审三轮-2，不得退回日末/当前时刻） */
function parseTimeOfDay(text: string): { h: number; m: number; s: number } | 'invalid' | null {
  const qualifier = text.match(/凌晨|早上|上午|中午|下午|晚上|晚间/)?.[0] ?? null
  const colon = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?/)
  // 「10点半 / 10点30分[25秒] / 10点30秒 / 10点30 / 10点」——半=30 分；N秒 不带分（评审四轮-1：
  // 「10点30秒」是 10:00:30 而非 10:30；秒位误读为分会多纳入请求时点之后的数据）
  const dian = text.match(/(\d{1,2})\s*[点时]\s*(?:(半)|(\d{1,2})\s*分\s*(?:(\d{1,2})\s*秒)?|(\d{1,2})\s*秒|(\d{1,2}))?/)
  let h: number
  let m: number
  let s = 0
  if (colon !== null) {
    h = Number(colon[1])
    m = Number(colon[2])
    s = colon[3] !== undefined ? Number(colon[3]) : 0
  } else if (dian !== null) {
    h = Number(dian[1])
    if (dian[2] !== undefined) {
      m = 30 // 半
    } else if (dian[3] !== undefined) {
      m = Number(dian[3])
      s = dian[4] !== undefined ? Number(dian[4]) : 0
    } else if (dian[5] !== undefined) {
      m = 0
      s = Number(dian[5])
    } else if (dian[6] !== undefined) {
      m = Number(dian[6])
    } else {
      m = 0
    }
  } else {
    return qualifier !== null ? 'invalid' : null
  }
  if (qualifier === '下午' || qualifier === '晚上' || qualifier === '晚间' || qualifier === '中午') {
    if (h < 12) h += 12
  } else if (qualifier !== null && h === 12) {
    h = 0 // 凌晨/早上/上午 12 点 → 00 点
  }
  if (h > 23 || m > 59 || s > 59) return 'invalid'
  return { h, m, s }
}

/** 复盘消息的历史时点解析（评审 F7/R3/三轮-2）：显式日期「2026-10-01 / 2026/10/1 /
 * 2026年10月1日 / 10月1日」可选时刻「10:00 / 10点30分 / 下午3点」；相对日「昨天/前天」
 * 也可带时刻（「昨天10:00」→ 昨日 10:00）。只给日期按约定取当日 23:59:59（UTC+8）；
 * 给了时刻必须按该时刻解析；裸时刻按今天该时刻（今天未到 → invalid）。
 * 非法/未来时间返回 'invalid'，无任何时间表达返回 undefined（调用方请求补全） */
export function parseReplayAsOf(text: string, now = Date.now()): number | 'invalid' | undefined {
  const time = parseTimeOfDay(text)
  if (time === 'invalid') return 'invalid'
  const rel = /前天/.test(text) ? -2 : /昨天/.test(text) ? -1 : null
  if (rel !== null) {
    if (time === null) return now + rel * 86400_000
    const dayUtc8 = new Date(now + rel * 86400_000 + 8 * 3600_000)
    return Date.UTC(dayUtc8.getUTCFullYear(), dayUtc8.getUTCMonth(), dayUtc8.getUTCDate(), time.h - 8, time.m, time.s)
  }
  const dm = text.match(/(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/)
  if (dm !== null) {
    const year = dm[1] !== undefined ? Number(dm[1]) : new Date(now).getUTCFullYear()
    const month = Number(dm[2])
    const day = Number(dm[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return 'invalid'
    // 日期合法性检查（2 月 30 日等进位）：对日期部分单独规范化验证，避免时区换算干扰
    const norm = new Date(Date.UTC(year, month - 1, day))
    if (norm.getUTCFullYear() !== year || norm.getUTCMonth() !== month - 1 || norm.getUTCDate() !== day) return 'invalid'
    const t = time === null ? Date.UTC(year, month - 1, day, 15, 59, 59) : Date.UTC(year, month - 1, day, time.h - 8, time.m, time.s)
    if (t > now) return 'invalid'
    return t
  }
  if (time !== null) {
    const todayUtc8 = new Date(now + 8 * 3600_000)
    const t = Date.UTC(todayUtc8.getUTCFullYear(), todayUtc8.getUTCMonth(), todayUtc8.getUTCDate(), time.h - 8, time.m, time.s)
    return t <= now ? t : 'invalid'
  }
  return undefined
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

/**
 * 管理端：会话列表 + 消息数统计（单查询聚合，避免逐会话 count 的 N+1）
 */
export async function listConversationsWithStats(
  userId: string,
  limit = 50,
): Promise<(ConversationRow & { messageCount: number })[]> {
  return getDb()!
    .select({
      id: conversations.id,
      userId: conversations.userId,
      title: conversations.title,
      context: conversations.context,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      // 注意：相关子查询里的外层引用必须显式写全限定表名——${conversations.id}
      // 在 select 字段位置会被 drizzle 渲染成不带表前缀的 "id"，在子查询内会错误解析成
      // conversation_messages.id 自比较（恒 0）。此处用 sql.raw 固定外层限定名。
      messageCount: sql<number>`(select count(*)::int from ${conversationMessages} where ${conversationMessages.conversationId} = ${sql.raw('"conversations"."id"')})`,
    })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)
}

/**
 * 管理端：不限归属读单会话（链路 B 研究会话）。
 * 与 aiMemory 侧链路 A 的 getConversationAny 命名区分——两条会话体系（ai_conversations
 * vs conversations）互不相同，管理端两个查看端点各取其一。
 */
export async function getConversationByIdAdmin(id: string): Promise<ConversationRow | null> {
  const rows = await getDb()!.select().from(conversations).where(eq(conversations.id, id)).limit(1)
  return rows[0] ?? null
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

/** 聊天引用角标结构（与 shared 契约 MessageCitationSchema 同构；0027 迁移落库） */
export interface MessageCitation {
  n: number
  kind: 'knowledge_chunk' | 'web_page'
  title: string
  pageNo?: number | null
  url?: string | null
  snippet: string
  [k: string]: unknown // jsonb 列的 index signature 兼容
}

async function appendMessage(input: {
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  intent?: Intent | null
  /** P1-1 任务场景（resolveScene 推导；system 等无场景消息为 null） */
  sceneCode?: string | null
  runId?: string | null
  card?: Record<string, unknown> | null
  /** P0-6 审计：本条回复使用的提示词版本（注册表解析结果） */
  promptRefs?: { name: string; scene: string; version: number | null; templateId: string | null }[]
  /** 聊天引用角标（只增字段，结构化数据驱动前端渲染；文本版来源行保留兼容旧客户端） */
  citations?: MessageCitation[]
}): Promise<ConversationMessageRow> {
  const rows = await getDb()!
    .insert(conversationMessages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      intent: input.intent ?? null,
      sceneCode: input.sceneCode ?? null,
      runId: input.runId ?? null,
      card: input.card ?? null,
      promptRefs: input.promptRefs ?? null,
      citations: input.citations ?? null,
    })
    .returning()
  await getDb()!.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, input.conversationId))
  return rows[0]
}

/** P1-5：无 run 的附答（concept/news）也计入记忆提取水位（fire-and-forget，失败不影响回复） */
function fireMemoryExtraction(userId: string, conversationId: string): void {
  void import('../memory.js').then(({ maybeExtractMemories }) => maybeExtractMemories(userId, conversationId))
}

/** P1-8 免责文案（按产品；app_settings 配置，读取失败回退内置基线） */
async function researchDisclaimer(product: 'perp' | 'event' | 'teaching' | string): Promise<string> {
  try {
    const { getDisclaimers } = await import('../../admin/settingsStore.js')
    const d = await getDisclaimers()
    return product === 'perp' ? d.perp : product === 'event' ? d.event : d.common
  } catch {
    return DEFAULT_DISCLAIMERS_FALLBACK
  }
}

const DEFAULT_DISCLAIMERS_FALLBACK = '研究结论基于历史结构与公开数据，不构成投资建议；合约交易有爆仓风险。'

/** PATCH /api/conversations/:id/context：保存用户确认的上下文（含确认卡落库持仓） */
async function patchContextInner(
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
      // onConflictDoNothing + 回读（评审三轮-4）；同一指纹已落库 = 复用记录并刷新确认时刻
      // （评审四轮-2：写操作即一次用户确认——重复提交/重试幂等返回同一持仓，
      // 间隔很久的重确认更新 confirmedAt、解除过期标记，不再被指纹当作旧重试跳过）
      const insertValues = {
        userId: conv.userId,
        symbol: parsed.data.symbol,
        side: parsed.data.side,
        qty: parsed.data.qty,
        entryPrice: parsed.data.entryPrice,
        leverage: parsed.data.leverage,
        marginMode: parsed.data.marginMode,
        riskBudget: parsed.data.riskBudget,
        confirmedAt: parsed.data.confirmedAt,
        confirmFp: fp,
      }
      const rows = await getDb()!
        .insert(portfolioPositions)
        .values(insertValues)
        .onConflictDoNothing()
        .returning()
      if (rows.length > 0) {
        confirmedPositionId = rows[0].id
      } else {
        // 评审五轮防御：刷新确认前核对指纹锚定记录的实际字段——
        // 记录被编辑成另一持仓后，指纹不得再锚定它（清除旧指纹，按草稿新建）
        const resolveConflict = async (): Promise<string> => {
          const findByFp = async () =>
            (
              await getDb()!
                .select()
                .from(portfolioPositions)
                .where(and(eq(portfolioPositions.userId, conv.userId), eq(portfolioPositions.confirmFp, fp)))
                .limit(1)
            )[0]
          let row = await findByFp()
          if (row === undefined) throw Object.assign(new Error('持仓确认冲突回读失败'), { statusCode: 500 })
          const match =
            row.symbol === parsed.data.symbol &&
            row.side === parsed.data.side &&
            Number(row.qty) === Number(parsed.data.qty) &&
            Number(row.entryPrice) === Number(parsed.data.entryPrice) &&
            row.leverage === parsed.data.leverage &&
            Number(row.riskBudget) === Number(parsed.data.riskBudget)
          if (!match) {
            await getDb()!
              .update(portfolioPositions)
              .set({ confirmFp: null, updatedAt: new Date() })
              .where(and(eq(portfolioPositions.id, row.id), eq(portfolioPositions.userId, conv.userId)))
            const retry = await getDb()!.insert(portfolioPositions).values(insertValues).onConflictDoNothing().returning()
            if (retry.length > 0) return retry[0].id
            row = await findByFp()
            if (row === undefined) throw Object.assign(new Error('持仓确认冲突回读失败'), { statusCode: 500 })
          }
          // 复用记录并刷新确认时刻（重确认解除过期；重试幂等返回同一持仓）
          await getDb()!
            .update(portfolioPositions)
            .set({ confirmedAt: Date.now(), updatedAt: new Date() })
            .where(and(eq(portfolioPositions.id, row.id), eq(portfolioPositions.userId, conv.userId)))
          return row.id
        }
        confirmedPositionId = await resolveConflict()
      }
      ctx.positionId = confirmedPositionId
      ctx.confirmedDraftFp = fp
      ctx.draft = null
    }
  }
  for (const k of ['positionId', 'quoteId']) {
    if (ctx[k] === '') ctx[k] = null
  }
  await getDb()!.update(conversations).set({ context: ctx, updatedAt: new Date() }).where(eq(conversations.id, conv.id))
  return { context: ctx, confirmedPositionId }
}

/** PATCH /api/conversations/:id/context（评审三轮-1：串行临界区内重读会话行——
 * 排队前读到的 context 可能已被前一个请求改写，旧对象合并会覆盖字段/漏掉草稿） */
export async function patchContext(
  conv: ConversationRow,
  patch: Record<string, unknown>,
): Promise<{ context: Record<string, unknown>; confirmedPositionId: string | null }> {
  return serializeConversation(conv.id, async () => {
    const fresh = await getConversationForUser(conv.id, conv.userId)
    if (fresh === null) throw Object.assign(new Error('会话不存在'), { statusCode: 404 })
    return patchContextInner(fresh, patch)
  })
}

export interface ConversationReply {
  message: ConversationMessageRow
  runId: string | null
  needCompletion: string[]
}

// 同会话写操作串行化（评审 R2）：先查后写的幂等检查在并发下需要互斥；
// 会话写 API 只在 app 进程服务，进程内按会话串行即消除竞争（confirm_fp 唯一约束作 DB 兜底）
const convChains = new Map<string, Promise<unknown>>()

function serializeConversation<T>(convId: string, fn: () => Promise<T>): Promise<T> {
  const prev = convChains.get(convId) ?? Promise.resolve()
  const task = prev.then(fn)
  const tail: Promise<unknown> = task.then(
    () => undefined,
    () => undefined,
  )
  convChains.set(convId, tail)
  void tail.then(() => {
    if (convChains.get(convId) === tail) convChains.delete(convId)
  })
  return task
}

/** POST /api/conversations/:id/messages：意图路由 → 创建研究（继承上下文）或直接回复 */
export async function postMessage(conv: ConversationRow, content: string): Promise<ConversationReply> {
  // 评审三轮-1：串行临界区内重读会话行（草稿/上下文以最新提交为准）
  return serializeConversation(conv.id, async () => {
    const fresh = await getConversationForUser(conv.id, conv.userId)
    if (fresh === null) throw Object.assign(new Error('会话不存在'), { statusCode: 404 })
    return postMessageInner(fresh, content)
  })
}

async function postMessageInner(conv: ConversationRow, content: string): Promise<ConversationReply> {
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
  // 纯结构语义问句（问「结构」且无任何事件/赔率词）：结构结论不依赖报价，
  // 不得因 LLM 对「10 分钟」等短期限的事件合约联想被纠偏进 event——
  // 那样缺报价时核心输出被砍成「不可用」，结构答案明明已算出却晾住用户
  const structureOnlyQuestion = isStructureOnlyQuestion(text)
  // LLM 叠加层：chat 能力已配置时纠偏确定性误分（如「我的多单要止损吗」被确定性漏判）；
  // 未配置/失败一律降级确定性，不伪造理解。结构问句上确定性正则比 LLM 的期限联想可信
  const orch = await classifyIntentOrchestrated(text, detIntent)
  const intent = structureOnlyQuestion && orch.intent === 'event' ? 'structure' : orch.intent
  const ctx = conv.context as {
    product?: 'perp' | 'event' | 'teaching'
    symbol?: string
    marketType?: 'spot' | 'usdm_perp'
    horizon?: '10m' | '30m' | '1h' | '1d' | '1w'
    positionId?: string | null
    quoteId?: string | null
    quoteDraft?: QuoteDraft | null
  }

  // 翻译：LLM 主翻（术语表提示词）+ Argos 离线包兜底（translate.ts 三级降级链）。
  // 不建研究 run、不写持仓/报价，与草稿流程完全隔离；配额已由端点
  // assertChatAllowed/recordChatMessage 覆盖。
  if (intent === 'translate') {
    if (memberCalls.getStore()?.features?.translate === false) throw membershipError('套餐未包含翻译功能', 403, 'membership_feature_unavailable')
    const { translateWithFallback, parseTranslateRequest } = await import('../translate.js')
    const parsed = parseTranslateRequest(text)
    const out = await translateWithFallback(text, parsed)
    const reply =
      parsed.text === ''
        ? assembleTrustedReply({ key: 'translate_empty' })
        : out.text !== null
          ? assembleTrustedReply({
              key: 'translate_body',
              // 译文走 sections 证据豁免通道：数字/价格来自待译原文本身，非 LLM 编造行情
              sections: [
                out.text +
                  (out.engine === 'argos' ? '\n\n> 由离线翻译引擎（Argos）产出，金融术语译法可能与主引擎有人工差距。' : ''),
              ],
            })
          : assembleTrustedReply({ key: 'translate_unavailable' })
    const msg = await appendMessage({
      conversationId: conv.id, role: 'assistant', intent, content: reply.content,
      promptRefs: out.promptRefs ?? undefined,
      sceneCode: 'translate',
    })
    return { message: msg, runId: null, needCompletion: [] }
  }

  // 寒暄/能力询问（LLM 分类为 system；确定性分类无此能力）：直接回复引导，不启动研究
  if (intent === 'system') {
    // P0-2 统一可信入口：全部意图回复经组装器（内容只来自 {事实, 证据, 配置文案}）
    const reply = assembleTrustedReply({ key: 'system_intro' })
    const msg = await appendMessage({
      conversationId: conv.id, role: 'assistant', intent,
      content: reply.content,
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
        content: assembleTrustedReply({ key: 'news_unconfigured' }).content,
      })
      return { message: msg, runId: null, needCompletion: [] }
    }
    const newsSymbol = text.match(SYMBOL_RE)?.[1] ?? ctx.symbol ?? 'BTCUSDT'
    const items = await searchAndVerify([`${newsSymbol} 最新消息 涨跌 原因`, text.slice(0, 80)])
    let content: string
    if (items.length === 0) {
      const msg = await appendMessage({ conversationId: conv.id, role: 'assistant', intent, content: assembleTrustedReply({ key: 'news_empty' }).content })
      return { message: msg, runId: null, needCompletion: [] }
    }
    {
      const block = items.map((w, i) => `[${i + 1}] ${w.title}（${w.url}）\n${w.pageText.slice(0, 500)}`).join('\n\n')
      const { resolveLlmClient } = await import('../llm.js')
      const { resolvePromptTemplate } = await import('../prompts.js')
      const newsPrompt = await resolvePromptTemplate('news-attribution')
      const llm = resolveLlmClient()
      let summarized = ''
      if (llm !== null) {
        try {
          const out = await llm.complete({
            system: newsPrompt.content,
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
      const excerptFallback =
        `核验通过的消息来源（chat 能力未配置或调用失败，给出原文摘录）：\n` +
        items.map((w, i) => `[${i + 1}] ${w.title} — ${w.url}\n${w.snippet !== '' ? w.snippet : w.pageText.slice(0, 150)}`).join('\n\n')
      // P0-2：LLM 摘要经组装器校验（[k] 引用 ∈ 来源数；概率红线；句级数字白名单——
      // 证据=发送给模型的同一份正文（block 同构：标题+URL+pageText 前 500 字），
      // 白名单外数字的句子剔除；摘录模式走 sections 证据豁免通道
      const reply = assembleTrustedReply({
        key: 'news_body',
        llmText: summarized !== '' ? summarized : null,
        llmFallback: excerptFallback,
        sourceCount: items.length,
        sections: summarized !== '' ? [sources] : [sources, excerptFallback],
        evidenceTexts: items.map((w, i) => `[${i + 1}] ${w.title}（${w.url}）\n${w.pageText.slice(0, 500)}`),
      })
      if (reply.degraded) log.warn('conversation', '回复组装降级（校验失败回退安全形态）', kv({ 会话: conv.id.slice(0, 8), 检查: reply.checkNotes.join(';').slice(0, 120) }))
      content = reply.content
      const msg = await appendMessage({
        conversationId: conv.id, role: 'assistant', intent, content,
        promptRefs: [{ name: newsPrompt.name, scene: newsPrompt.scene, version: newsPrompt.version, templateId: newsPrompt.templateId }],
        sceneCode: 'news-attribution',
        citations: items.map((w, i): MessageCitation => ({
          n: i + 1,
          kind: 'web_page',
          title: w.title,
          url: w.url,
          snippet: (w.snippet !== '' ? w.snippet : w.pageText).slice(0, 240),
        })),
      })
      fireMemoryExtraction(conv.userId, conv.id)
      return { message: msg, runId: null, needCompletion: [] }
    }
  }

  // 概念问答（#6 修复）：直接 RAG + 反证作答（可选用 LLM 组织解释），不启动行情八步流程
  if (intent === 'concept') {
    const { searchHybrid } = await import('../../knowledge/retrieval.js')
    const { accessCtxForUser } = await import('../../knowledge/access.js')
    // W1-A：会话问答按会话归属用户当前角色过滤（受限资料不进普通用户引用与 LLM 上下文）
    const accessCtx = accessCtxForUser(conv.userId)
    const support = await searchHybrid(text, { finalLimit: 4, llmVariants: 2, access: accessCtx })
    const counter = await searchHybrid(`${text} failure risk counter`, { mode: 'counter', finalLimit: 2, llmVariants: 1, access: accessCtx })
    const evidenceBlock = support.hits.map((h) => `【${h.docTitle}${h.chunk.pageNo !== null ? ` 第${h.chunk.pageNo}页` : ''}】${h.chunk.text.slice(0, 300)}`).join('\n')
    let answer = ''
    const { resolveLlmClient, parseClaimLines } = await import('../llm.js')
    const { resolvePromptTemplate } = await import('../prompts.js')
    const conceptPrompt = await resolvePromptTemplate('concept-teaching')
    const llm = resolveLlmClient()
    if (llm !== null) {
      try {
        const out = await llm.complete({
          system: conceptPrompt.content,
          user: `问题：${text}\n\n资料：\n${evidenceBlock || '（知识库无命中）'}\n\n反证片段：\n${counter.hits.map((h) => h.chunk.text.slice(0, 150)).join('\n')}`,
          maxTokens: 500,
        })
        answer = out.text
      } catch (err) {
        answer = `（LLM 解释失败，退回资料原文：${(err as Error).message.slice(0, 80)}）`
      }
    }
    // P0-2：解释正文经组装器（句级数字白名单：证据=支持+反证知识块正文，白名单外
    // 数字的句子剔除；未命中知识库走安全模板，不编造）
    const reply =
      support.hits.length === 0
        ? assembleTrustedReply({ key: 'concept_no_hit' })
        : assembleTrustedReply({
            key: 'concept_body',
            // LLM 解释作为 llmText（可被概率红线/数字白名单拒绝）；资料原文走 sections
            // 证据豁免通道（书摘常含「概率/小数」等知识性表述，不属于伪造概率）
            llmText: answer !== '' ? answer : null,
            llmFallback: `资料依据：\n${evidenceBlock}`,
            sections: answer !== '' ? [] : [`资料依据：\n${evidenceBlock}`],
            evidenceTexts: [...support.hits.map((h) => h.chunk.text), ...counter.hits.map((h) => h.chunk.text)],
          })
    if (reply.degraded) log.warn('conversation', '回复组装降级（概念问答回退）', kv({ 会话: conv.id.slice(0, 8), 检查: reply.checkNotes.join(';').slice(0, 120) }))
    const msg = await appendMessage({
      conversationId: conv.id, role: 'assistant', intent, content: reply.content,
      promptRefs: [{ name: conceptPrompt.name, scene: conceptPrompt.scene, version: conceptPrompt.version, templateId: conceptPrompt.templateId }],
      sceneCode: 'concept-teach',
      citations: [...support.hits, ...counter.hits].map((h, i): MessageCitation => ({
        n: i + 1,
        kind: 'knowledge_chunk',
        title: h.docTitle,
        pageNo: h.chunk.pageNo ?? null,
        snippet: h.chunk.text.slice(0, 240),
      })),
    })
    fireMemoryExtraction(conv.userId, conv.id)
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
          : structureOnlyQuestion && ctx.product === 'event'
            ? 'teaching'
            : ctx.product ?? 'teaching'
  // 交易对一致性（九轮修复）：消息切换 symbol 后，上下文里旧交易对的持仓/报价
  // 引用不再带入新研究（BTC 入场价不得混入 ETH 行情）；切回原交易对自动恢复引用
  const contextNotes: string[] = []
  // 纯结构问句在 event 上下文中的降级说明（结构照常输出；如需 EV 再给报价）；
  // 同时丢弃待补全的报价草稿（用户已选择不要 EV 路径，不留悬挂状态）
  if (structureOnlyQuestion && ctx.product === 'event' && intent !== 'event') {
    contextNotes.push('已按结构研究处理（结构结论不依赖报价）；如需事件合约 EV 评估，请提供一条报价（如「高于 60000，投 10 返 17，10 分钟」）')
    ctx.quoteDraft = null
  }
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
  }  if (
    (pendingDraft !== undefined && (fillsGap || (intent === 'perp' && touched.length > 0))) ||
    (intent === 'perp' && pendingDraft === undefined && draft.side !== undefined && draft.qty !== undefined)
  ) {
    const merged = { ...(pendingDraft ?? {}), ...Object.fromEntries(touched.map((k) => [k, draft[k]])) } as PositionDraft
    if (merged.symbol === undefined) merged.symbol = symbol
    const missing = missingPositionFields(merged)
    await getDb()!.update(conversations).set({ context: { ...ctx, draft: merged }, updatedAt: new Date() }).where(eq(conversations.id, conv.id))
    const draftReply =
      missing.length === 0
        ? assembleTrustedReply({ key: 'draft_complete' })
        : assembleTrustedReply({
            key: 'draft_pending',
            facts: { missingLabels: missing.map((k) => POSITION_FIELD_LABEL[k] ?? k).join('、') },
          })
    const msg = await appendMessage({
      conversationId: conv.id, role: 'assistant', intent,
      content: draftReply.content,
      card: { kind: 'confirm_position', draft: merged as Record<string, unknown>, missingFields: missing, complete: missing.length === 0 },
    })
    return { message: msg, runId: null, needCompletion: missing.length === 0 ? ['confirm_position'] : missing.map((k) => `position_${k}`) }
  }

  // 杠杆假设（#6 修复）：「改成 20 倍」→ 假设研究（新 run 带 override，不写回持仓）
  const levMatch = text.match(/(?:改成|换成|调整到|用)\s*(\d{1,3})\s*倍/)
  const positionOverride = levMatch !== null ? { leverage: Math.max(1, Math.min(125, Number(levMatch[1]))) } : undefined

  // ---- 事件报价缺输入闭环（B 修）：event 产品且未引用报价时不再默默跑管线 ----
  // 报价是 EV 的赔率来源（盈亏平衡胜率=投入÷返还），官方无查询接口只能由用户抄录。
  // 「作废报价」：清掉刚代录的 preview 引用（行删除；submitted 订单行只清引用不动行）
  if (intent !== 'replay' && product === 'event' && ctx.quoteId != null && /作废报价|删掉报价|不要这个报价/.test(text)) {
    await getDb()!
      .delete(eventQuotes)
      .where(and(eq(eventQuotes.id, ctx.quoteId), eq(eventQuotes.userId, conv.userId), eq(eventQuotes.orderState, 'preview')))
    await getDb()!.update(conversations).set({ context: { ...ctx, quoteId: null, quoteDraft: null }, updatedAt: new Date() }).where(eq(conversations.id, conv.id))
    const msg = await appendMessage({ conversationId: conv.id, role: 'assistant', intent, content: assembleTrustedReply({ key: 'quote_discarded' }).content })
    return { message: msg, runId: null, needCompletion: [] }
  }
  if (intent !== 'replay' && product === 'event' && quoteId === null) {
    // 槽位合并（F6 同款）：上下文里的待补草稿 + 本轮提取合并；「取消」丢弃
    const quoteTouched = extractQuoteDraft(text)
    const pendingQuoteDraft = ctx.quoteDraft != null ? ctx.quoteDraft : null
    if (pendingQuoteDraft !== null && /取消|放弃|不要了/.test(text)) {
      await getDb()!.update(conversations).set({ context: { ...ctx, quoteDraft: null }, updatedAt: new Date() }).where(eq(conversations.id, conv.id))
      const msg = await appendMessage({ conversationId: conv.id, role: 'assistant', intent, content: assembleTrustedReply({ key: 'quote_discarded' }).content })
      return { message: msg, runId: null, needCompletion: [] }
    }
    const mergedQuote: QuoteDraft = {
      ...(pendingQuoteDraft ?? {}),
      ...Object.fromEntries(QUOTE_FIELDS.filter((k) => quoteTouched[k] !== undefined).map((k) => [k, quoteTouched[k]])),
    } as QuoteDraft
    const missingQuote = missingQuoteFields(mergedQuote)
    if (missingQuote.length === 0) {
      // 数值校验与 POST /api/event-quotes 同构：返还≥投入；违例不建行，请求更正
      if (mergedQuote.totalPayout! < mergedQuote.stake!) {
        const msg = await appendMessage({
          conversationId: conv.id, role: 'assistant', intent,
          content: assembleTrustedReply({ key: 'quote_invalid', facts: { reason: '含本金总返还小于投入金额（App 展示的返还包含本金，应大于等于投入）' } }).content,
        })
        return { message: msg, runId: null, needCompletion: ['quote_totalPayout'] }
      }
      // 建 preview 报价（duration 模式，expiryAt−asOf 恰为桶时长，必落入已验证桶）
      const BUCKET_MS = { '10m': 10 * 60_000, '30m': 30 * 60_000, '1h': 60 * 60_000, '1d': 24 * 60 * 60_000, '1w': 7 * 24 * 60 * 60_000 } as const
      const nowQ = Date.now()
      const inserted = await getDb()!
        .insert(eventQuotes)
        .values({
          userId: conv.userId,
          symbol,
          strikePrice: String(mergedQuote.strikePrice!),
          expiryAt: nowQ + BUCKET_MS[mergedQuote.horizon!],
          asOf: nowQ,
          stake: String(mergedQuote.stake!),
          totalPayout: String(mergedQuote.totalPayout!),
          direction: mergedQuote.direction!,
          refPrice: null,
          note: `会话代录（${text.slice(0, 80)}）`,
          orderState: 'preview',
          strikeStatus: 'preview',
          previewAsOf: nowQ,
        })
        .returning({ id: eventQuotes.id })
      quoteId = inserted[0].id
      ctx.quoteDraft = null
      ctx.quoteId = quoteId
      const HORIZON_LABEL: Record<string, string> = { '10m': '10 分钟', '30m': '30 分钟', '1h': '1 小时', '1d': '1 天', '1w': '1 周' }
      contextNotes.push(
        assembleTrustedReply({
          key: 'quote_recorded',
          facts: {
            quoteSummary:
              `${mergedQuote.direction === 'above' ? '高于' : '低于'} ${mergedQuote.strikePrice} / 投入 ${mergedQuote.stake} / 返还 ${mergedQuote.totalPayout} / ${HORIZON_LABEL[mergedQuote.horizon!]} 到期`,
          },
        }).content,
      )
    } else {
      // 缺输入 → 启动前追问（不再跑完八阶段才甩「不可用」）；草稿入库等下一条消息补槽位
      await getDb()!.update(conversations).set({ context: { ...ctx, product, symbol, marketType, horizon, quoteDraft: mergedQuote }, updatedAt: new Date() }).where(eq(conversations.id, conv.id))
      const msg = await appendMessage({
        conversationId: conv.id, role: 'assistant', intent,
        content: assembleTrustedReply({
          key: 'quote_missing',
          facts: { missingLabels: missingQuote.map((k) => QUOTE_FIELD_LABEL[k] ?? k).join('、') },
          notes: contextNotes,
        }).content,
      })
      return { message: msg, runId: null, needCompletion: missingQuote.map((k) => `quote_${k}`) }
    }
  }

  // 复盘（评审 F7）：解析历史 asOf（「昨天/前天」或显式日期）；无法解析必须请求补全，
  // 不得静默用当前时间冒充历史研究
  let asOf: number | undefined
  if (intent === 'replay') {
    const parsed = parseReplayAsOf(text)
    if (parsed === 'invalid' || parsed === undefined) {
      const msg = await appendMessage({
        conversationId: conv.id, role: 'assistant', intent,
        content: assembleTrustedReply({ key: parsed === 'invalid' ? 'replay_invalid' : 'replay_missing' }).content,
      })
      return { message: msg, runId: null, needCompletion: ['replay_asOf'] }
    }
    asOf = parsed
  }

  // 「现在呢」→ 新快照（asOf 缺省即当前）；「改成 20 倍」→ 假设研究（不覆盖持仓）
  // P1-1 任务场景：resolveScene 按意图+产品+持仓推导，随 run 创建落 research_runs.scene_code
  const sceneCode = resolveScene(intent, { product, hasPosition: positionId !== null, replay: intent === 'replay' })
  const run = await createRun({
    userId: conv.userId,
    conversationId: conv.id,
    create: {
      product,
      symbol,
      marketType,
      horizon,
      question: text,
      sceneCode,
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
    replay: '历史复盘', news: '新闻归因', system: '系统', translate: '翻译',
  }
  const asOfNote = asOf !== undefined ? `（历史复盘 asOf=${new Date(asOf).toLocaleString()}，只用当时可见数据）` : ''
  const directionNote = directionResearch ? '（一周方向研究：研究模式输出分布，非事件合约参与建议）' : ''
  // 子问题拆分：复合问题中主意图覆盖不了的附加概念问题（≤1）内联附答（RAG 直引，不另起 run）
  let subAnswer = ''
  for (const sub of orch.subQuestions.slice(0, 1)) {
    if (classifyIntent(sub) !== 'concept') continue
    try {
      const { searchHybrid } = await import('../../knowledge/retrieval.js')
      const { accessCtxForUser } = await import('../../knowledge/access.js')
      const r = await searchHybrid(sub, { finalLimit: 2, llmVariants: 1, skipRerank: true, access: accessCtxForUser(conv.userId) })
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
  const startedReply = assembleTrustedReply({
    key: 'run_started',
    facts: {
      intentLabel: intentLabel[intent],
      symbol,
      horizon,
      asOfNote,
      directionNote,
      queueNote: queued ? '' : '（执行队列暂不可用，运行已建档待重投）',
      // 附加问题附答为证据摘录（数字来自冻结知识片段，随槽位进入可信来源）
      subAnswer,
    },
    notes: contextNotes,
    // P1-8 免责（服务端配置，按产品下发；读取失败回退内置基线文案）
    disclaimer: await researchDisclaimer(product),
  })
  if (startedReply.degraded) log.warn('conversation', '回复组装降级（启动研究）', kv({ 会话: conv.id.slice(0, 8), 检查: startedReply.checkNotes.join(';').slice(0, 120) }))
  const msg = await appendMessage({
    conversationId: conv.id,
    role: 'assistant',
    intent,
    sceneCode,
    runId: run.id,
    promptRefs:
      orch.promptRef !== null
        ? [{ name: orch.promptRef.name, scene: '', version: orch.promptRef.version, templateId: orch.promptRef.templateId }]
        : undefined,
    content: startedReply.content,
  })
  log.ok('conversation', '消息路由', kv({ 会话: conv.id.slice(0, 8), 意图: intent, 产品: product, run: run.id.slice(0, 8) }))
  return { message: msg, runId: run.id, needCompletion: [] }
}
