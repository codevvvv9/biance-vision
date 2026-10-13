/**
 * 研究对话入口（docs/specs/agent-orchestration.md 查询规划的确定性 v1 + 上下文继承）：
 * 用户自然语言 → 意图槽位（产品/交易对/期限/方向/持仓/报价引用）→
 * 缺省从上一轮 run 与用户最新持仓/报价继承 → 创建研究运行并给出可读回复。
 * 多轮：客户端把上一轮 runId 带回，服务端据此继承 symbol/期限/产品等上下文；
 * chat 能力配置后可在此叠加 LLM 改写与澄清（当前确定性解析，不伪造理解）。
 */
import { and, desc, eq } from 'drizzle-orm'
import type { MarketType, ResearchHorizon } from 'biance-vision-brooks'
import { getDb } from '../../db.js'
import { eventQuotes, portfolioPositions } from '../../models.js'
import { kv, log } from '../../logger.js'
import { createRun, getRun } from './store.js'
import { enqueueResearchRun } from './jobs.js'

export interface ChatInput {
  message: string
  /** 上一轮研究运行（继承 symbol/期限/产品/持仓/报价上下文） */
  lastRunId?: string
}

export interface ChatOutcome {
  reply: string
  runId: string | null
  resolved: {
    product: 'perp' | 'event' | 'teaching'
    symbol: string
    marketType: MarketType
    horizon: ResearchHorizon
    positionId: string | null
    quoteId: string | null
    question: string
  }
}

const SYMBOL_RE = /\b([A-Z0-9]{2,10}(?:USDT|USDC))\b/

const HORIZON_PATTERNS: [RegExp, ResearchHorizon][] = [
  [/10\s*分钟|十分钟/, '10m'],
  [/30\s*分钟|半小时|三十分钟/, '30m'],
  [/1\s*小时|一小时|60\s*分钟|一个小时/, '1h'],
  [/1\s*天|一天|24\s*小时|一天内/, '1d'],
  [/1\s*周|一周|7\s*天|一周内/, '1w'],
]

function parseHorizon(text: string): ResearchHorizon | null {
  for (const [re, h] of HORIZON_PATTERNS) if (re.test(text)) return h
  return null
}

function parseProduct(text: string): 'perp' | 'event' | 'teaching' | null {
  if (/事件|涨跌|高于|低于|执行价|到期|报价/.test(text)) return 'event'
  if (/永续|合约|持仓|仓位|做多|做空|加仓|减仓|杠杆|开仓/.test(text)) return 'perp'
  if (/教学|什么是|解释|概念|术语|怎么理解/.test(text)) return 'teaching'
  return null
}

export async function handleResearchChat(userId: string, input: ChatInput): Promise<ChatOutcome> {
  const text = input.message.trim()
  if (text === '') throw Object.assign(new Error('消息为空'), { statusCode: 400 })

  // 上一轮上下文
  let last: Awaited<ReturnType<typeof getRun>> = null
  if (input.lastRunId !== undefined && input.lastRunId !== '') {
    last = await getRun(input.lastRunId)
    if (last !== null && last.userId !== userId) last = null
  }
  const lastInput = (last?.input ?? null) as {
    product?: 'perp' | 'event' | 'teaching'
    positionId?: string
    quoteId?: string
  } | null

  // 槽位解析（显式 > 上一轮 > 默认）
  const symbolMatch = text.match(SYMBOL_RE)
  const symbol = symbolMatch?.[1] ?? last?.symbol ?? 'BTCUSDT'
  const product = parseProduct(text) ?? lastInput?.product ?? (last?.product as ChatOutcome['resolved']['product']) ?? 'perp'
  const horizon = parseHorizon(text) ?? (last?.horizon as ResearchHorizon) ?? '1h'
  const marketType: MarketType = /现货/.test(text) ? 'spot' : last?.marketType === 'spot' && !/永续/.test(text) ? 'spot' : 'usdm_perp'

  // 持仓/报价引用：显式提到或沿用上一轮；否则取用户最新一条
  const db = getDb()!
  const wantPosition = product === 'perp' && (/持仓|仓位|我的仓|多头|空头|做多|做空/.test(text) || lastInput?.positionId !== undefined)
  let positionId: string | null = null
  if (wantPosition) {
    if (lastInput?.positionId !== undefined && !/最新|重新/.test(text)) {
      positionId = lastInput.positionId
    } else {
      const rows = await db
        .select()
        .from(portfolioPositions)
        .where(eq(portfolioPositions.userId, userId))
        .orderBy(desc(portfolioPositions.createdAt))
        .limit(1)
      positionId = rows[0]?.id ?? null
    }
  }
  const wantQuote = product === 'event' && (/报价|执行价|这份|这个合约/.test(text) || lastInput?.quoteId !== undefined)
  let quoteId: string | null = null
  if (wantQuote) {
    if (lastInput?.quoteId !== undefined && !/最新|重新/.test(text)) {
      quoteId = lastInput.quoteId
    } else {
      const rows = await db
        .select()
        .from(eventQuotes)
        .where(and(eq(eventQuotes.userId, userId)))
        .orderBy(desc(eventQuotes.createdAt))
        .limit(1)
      quoteId = rows[0]?.id ?? null
    }
  }

  const row = await createRun({
    userId,
    create: {
      product,
      symbol,
      marketType,
      horizon,
      question: text.slice(0, 2000),
      positionId: positionId ?? undefined,
      quoteId: quoteId ?? undefined,
    },
  })
  const queued = await enqueueResearchRun(row.id)
  if (!queued) {
    return {
      reply: `已理解你的问题并建档（${product}/${symbol}/${horizon}），但执行队列暂不可用；请稍后重试或用「发起研究」表单。`,
      runId: row.id,
      resolved: { product, symbol, marketType, horizon, positionId, quoteId, question: text },
    }
  }

  // 可读回复：说明理解 + 缺口引导
  const productLabel = product === 'perp' ? 'USDT 永续研究' : product === 'event' ? '到期涨跌事件合约' : '教学研究'
  const tips: string[] = []
  if (product === 'perp' && positionId === null && /持仓|仓位|做多|做空/.test(text)) {
    tips.push('未关联持仓：左侧「录入持仓」保存后对我说「用我的持仓分析」即可计算计划盈亏')
  }
  if (product === 'event' && quoteId === null) {
    tips.push('未关联报价：左侧「录入事件报价」（执行价/投入/总返还）后我可计算 EV 与参与门槛')
  }
  const reply =
    `好的，我按「${productLabel} · ${symbol} · ${horizon}」启动研究，` +
    `已冻结当前行情快照，结构计算、知识检索与风险校验完成后给你结论。` +
    (tips.length > 0 ? `提示：${tips.join('；')}。` : '') +
    `（运行 ${row.id.slice(0, 8)}，进度见下方步骤；可继续追问，例如「换成 ETHUSDT 再看」「换成 1 小时」）`
  log.ok('research', '对话入口创建研究', kv({ 用户: userId, 产品: product, 交易对: symbol, 期限: horizon, run: row.id.slice(0, 8) }))
  return {
    reply,
    runId: row.id,
    resolved: { product, symbol, marketType, horizon, positionId, quoteId, question: text },
  }
}
