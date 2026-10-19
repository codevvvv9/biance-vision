/**
 * 固定流水线 v2（P1，improvement-plan §1.1 统一服务边界）：
 * 阶段只做编排；分析/概率/决策/校验全部走 services：
 * MarketSnapshotService（可复现输入包+质量码）→ 结构（从快照读，不重查行情）
 * → 检索（钉冻结知识版本）→ PerpetualAnalyzer / EventAnalyzer+PredictionService
 * → 反证 → ResearchValidator → DecisionPolicy + 结果契约 v2 装配。
 * 预算与配置全部读 run 行冻结值；publish 只保存已通过校验的结论。
 */
import { and, eq } from 'drizzle-orm'
import { analyzeBrooks } from 'biance-vision-brooks'
import type { BrooksAnalysis, StructureEvent } from 'biance-vision-brooks'
import { ResearchResultV2Schema, SearchCapabilityConfigSchema } from 'biance-vision-brooks'
import { getDb } from '../../db.js'
import { kv, log } from '../../logger.js'
import { eventQuotes, evidenceItems, portfolioPositions, predictions, structureEvents } from '../../models.js'
import type { EventQuoteRow, PortfolioPositionRow } from '../../models.js'
import { searchHybrid } from '../../knowledge/retrieval.js'
import { getCapabilities } from '../../admin/capabilities.js'
import { searchAndVerify } from '../search.js'
import { listFunding } from '../../market/funding.js'
import { resolveLlmClient, parseClaimLines, estimateLlmCostUsd, estimateMaxLlmCallCostUsd, DEFAULT_MAX_LLM_CALLS } from '../llm.js'
import { ValidationRejected } from '../orchestrator/pipeline.js'
import type { Stage } from '../orchestrator/types.js'
import type { RunContext } from '../orchestrator/types.js'
import { freezeEvidence, getRun, hashFrozenConfig, pinRunVersions } from './store.js'
import { bindCounterEvidence, stripCiteMarkers } from './countercaseParse.js'
import { frozenPrompt, DEFAULT_PROMPTS } from '../prompts.js'
import { MIN_BARS, baseIntervalFor } from '../features.js'
import { createFrozenSnapshot, EXEC_TF, BACKGROUND_TF } from '../../services/marketSnapshot.js'
import { predictForTarget } from '../../services/prediction.js'

/**
 * 缺事件报价时的结果卡补全引导（C 修）：不可用 ≠ 拒答，必须告诉用户
 * 缺什么/为什么需要/怎么补/结构结论不受影响——官方无报价接口，赔率只能抄录。
 */
const QUOTE_GUIDANCE = [
  '缺输入：未引用事件报价——EV 需要报价中的投入与返还得出赔率（盈亏平衡胜率 = 投入 ÷ 返还），官方无查询接口，助手不编造',
  '补全方式一：在研究会话中直接发送报价描述（如「BTC 高于 60000，投 10 返 17，10 分钟」），助手会代录为预览报价并研究',
  '补全方式二：在研究表单「事件研究」录入报价（已提交订单必须走表单，到期时刻需精确），再回来提问',
  '只要结构偏向：结构结论不依赖报价，可直接问「现在的结构如何」',
]
import { analyzeEvent, eventEntryGate } from '../../services/eventAnalyzer.js'
import type { EventQuoteInput, EventAnalysis } from '../../services/eventAnalyzer.js'
import { analyzePerp, DEFAULT_PERP_FEES } from '../../services/perpetualAnalyzer.js'
import type { PerpFeeAssumption } from '../../services/perpetualAnalyzer.js'
import { fundingFreshness, FUNDING_GRACE_MS, FUNDING_INTERVAL_MS } from '../perp/calc.js'
import { decidePerp, decideEventSubmitted, decideDirection, applyEventDirectionGate } from '../../services/decisionPolicy.js'
import type { StructureView, Direction } from '../../services/decisionPolicy.js'
import { linkageTargets } from '../../services/ruleLinkage.js'
import type { RuleLink } from '../../services/ruleLinkage.js'
import { validateResearch } from '../../services/validator.js'
import type { AgentCapabilities, ResearchResultV2, SearchCapabilityConfig, UnavailableCode } from 'biance-vision-brooks'

/** 新闻/消息面/归因类措辞（与 conversation.ts 的 news 意图路由同源） */
const NEWS_QUERY_RE = /新闻|消息面|为什么涨|为什么跌|归因/

/** 流水线工具域（评审 R4：plan 规划 + 阶段入口代码门控共用同一份定义） */
const TOOL_DOMAIN = ['market_snapshot', 'brooks_engine', 'knowledge_retrieval', 'web_search'] as const
type ToolDomain = (typeof TOOL_DOMAIN)[number]

/** 工具白名单代码门控：发布配置 roles[].tools 排除的工具域，对应阶段拒绝执行
 * （不再是只写提示的展示信息）；未配置角色时 plan 已置工程默认全集，门控通过 */
function assertToolAllowed(ctx: RunContext, tool: ToolDomain): void {
  const req = ctx.plan?.requiredTools
  if (req !== undefined && !req.includes(tool)) {
    throw new Error(`工具域 ${tool} 不在本 run 的工具白名单（agent 版本 roles 配置排除），阶段拒绝执行`)
  }
}

/** 持仓过期判定（P0-1 评测接缝：单一实现，对话/阶段/评测共用同一口径） */
export function isPositionStale(confirmedAt: number, staleAfterHours: number, now = Date.now()): boolean {
  return now - confirmedAt > staleAfterHours * 3600_000
}

/** 阻断性质量问题判定（评审 R1：门控看完整问题集合，与排序无关）——
 * insufficient_history 单独存在不阻断（特征门槛另行把关），过期/缺口/参考价异常一律阻断 */
export function hasBlockingQualityIssue(issues: { code: string }[]): boolean {
  return issues.some((i) => i.code !== 'insufficient_history')
}

/** search 能力配置解析：优先 run 冻结配置（raw.capabilities.search），缺失/非法时
 *  回退全局生效配置（与 resolveLlmClient 的 frozen→live 回退一致） */
function searchConfigFor(ctx: RunContext): SearchCapabilityConfig {
  const raw = (ctx.frozenConfig?.raw as { capabilities?: { search?: unknown } } | undefined)?.capabilities?.search
  if (raw !== undefined) {
    const parsed = SearchCapabilityConfigSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    log.warn('research', '冻结配置中的 search 能力解析失败（回退全局配置）', kv({ run: ctx.runId.slice(0, 8) }))
  }
  return getCapabilities().search
}

/** web 搜索查询拼装：symbol + 原问题关键词（1-2 条，去重去空） */
function buildWebQueries(symbol: string, question: string | null): string[] {
  const q = question?.trim() ?? ''
  const queries = [`${symbol} ${q}`.trim().slice(0, 120)]
  if (q !== '') queries.push(`${symbol} 最新消息 新闻`)
  return [...new Set(queries.filter((s) => s !== ''))].slice(0, 2)
}

/** 阶段间传递的 v2 装配上下文（不进 RunContext 契约） */
interface V2Ctx {
  v2Payload: Record<string, unknown>
  probabilityBlock: Record<string, unknown> | null
  eventAnalysis: EventAnalysis | null
  eventQuoteInput: EventQuoteInput | null
  structureView: StructureView
  /** 前置决策（product_analysis 生成、validate 校验、publish 只装配） */
  decision: { action: string; side: 'long' | 'short' | null; reasons: string[]; conditions: string[] } | null
  /** 持仓已过期：个性化数值（盈亏矩阵/减仓/增量）已降级为一般结构研究 */
  positionStale?: boolean
  /** 快照最后成交价（validate 阶段保护止损校验用：已有持仓结合当前价判断） */
  lastPrice?: number | null
  /** 理论关联链路（retrieve 填充）：结构/规则 → 适用条件与反例的证据引用 */
  ruleLinks: RuleLink[]
  /** 知识库为空（无发布版本）：理论关联不可用，判定回退计数语义并显式说明 */
  knowledgeEmpty: boolean
}
const v2of = (ctx: RunContext): V2Ctx => ctx as unknown as V2Ctx

function loadPosition(userId: string, positionId: string | null, symbol?: string): Promise<PortfolioPositionRow | null> {
  if (!positionId) return Promise.resolve(null)
  // 交易对一致性（九轮修复）：持仓必须属于本次研究 symbol——聊天切换币种后
  // 残留的旧 positionId（如 BTC 持仓配 ETH 行情）在此被拒，防止入场价/数量混用
  const conds = [eq(portfolioPositions.id, positionId), eq(portfolioPositions.userId, userId)]
  if (symbol !== undefined) conds.push(eq(portfolioPositions.symbol, symbol))
  return getDb()!
    .select()
    .from(portfolioPositions)
    .where(and(...conds))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

function loadQuote(userId: string, quoteId: string | null, symbol?: string): Promise<EventQuoteRow | null> {
  if (!quoteId) return Promise.resolve(null)
  const conds = [eq(eventQuotes.id, quoteId), eq(eventQuotes.userId, userId)]
  if (symbol !== undefined) conds.push(eq(eventQuotes.symbol, symbol))
  return getDb()!
    .select()
    .from(eventQuotes)
    .where(and(...conds))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

/**
 * 流水线预测落库（C1）：predictForTarget 产出可用预测时写入 predictions 表
 * （特征向量/分位数/模型版本随记录冻结可复现），返回 predictionId 供 probabilityBlock 引用。
 * snapshotId 缺失（snapshot 阶段未跑）时不落库，保持 probabilityBlock.predictionId=null。
 */
async function persistPipelinePrediction(
  ctx: RunContext,
  quoteId: string | null,
  outcome: { probabilityUp: number; quantiles: Record<string, number>; modelVersion: string; featureVersion: string; features: Record<string, number> },
): Promise<string | null> {
  const db = getDb()
  if (!db || ctx.snapshotId === null) return null
  const rows = await db
    .insert(predictions)
    .values({
      userId: ctx.userId,
      quoteId,
      symbol: ctx.symbol,
      marketType: ctx.marketType,
      horizon: ctx.horizon,
      modelVersion: outcome.modelVersion,
      featureVersion: outcome.featureVersion,
      probabilityUp: outcome.probabilityUp,
      quantiles: Object.fromEntries(Object.entries(outcome.quantiles).map(([k, v]) => [k, String(v)])),
      snapshotId: ctx.snapshotId,
      status: 'active',
      features: outcome.features,
    })
    .returning({ id: predictions.id })
  return rows[0]?.id ?? null
}

/** 从快照输入包分析一个周期（结构只吃冻结数据，不重查当前行情） */
function analyzeFromPack(pack: RunContext['snapshotPack'], interval: string): BrooksAnalysis | null {
  const series = pack?.candles.find((c) => c.interval === interval && c.priceType === 'trade')
  if (series === undefined) return null
  const bars = series.rows.map((r) => ({
    time: r.t,
    open: Number(r.o),
    high: Number(r.h),
    low: Number(r.l),
    close: Number(r.c),
    volume: r.v === null ? undefined : Number(r.v),
    closed: true,
    closeTime: r.t,
  }))
  if (bars.length < 30) return null
  return analyzeBrooks(bars, { swingK: 3, asOf: bars[bars.length - 1].closeTime })
}

function directionOf(a: BrooksAnalysis | null): Direction {
  const d = a?.alwaysIn.direction
  return d === 'bull' || d === 'bear' ? d : 'neutral'
}

/** 持仓假设覆盖（「改成 20 倍」）：只影响本次研究计算，不写回已确认持仓 */
function applyOverride(pos: PortfolioPositionRow, override: { leverage?: number } | null): PortfolioPositionRow {
  if (override === null || override.leverage === undefined) return pos
  return { ...pos, leverage: Math.max(1, Math.min(125, Math.round(override.leverage))) }
}

/** 角色模板解析：promptRef 支持 inline:<文本>（配置内联）或 server/data/prompts/<ref>.txt；
 * 文件名/路径穿越拒绝，不存在或为空 → null（调用方回退工程默认模板） */
export async function resolveRolePrompt(promptRef: string): Promise<string | null> {
  if (promptRef.startsWith('inline:')) {
    const text = promptRef.slice('inline:'.length).trim()
    return text.length > 0 ? text : null
  }
  if (!/^[\w.-]{1,64}$/.test(promptRef)) return null
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const file = fileURLToPath(new URL(`../../../data/prompts/${promptRef}.txt`, import.meta.url))
  try {
    const text = (await readFile(file, 'utf8')).trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

export function buildStages(positionOverride: { leverage?: number } | null = null): Stage[] {
  const plan: Stage = {
    name: 'plan',
    async run(ctx: RunContext): Promise<void> {
      const timeframes = [...new Set([EXEC_TF[ctx.horizon] ?? '15m', BACKGROUND_TF[ctx.horizon] ?? '1h'])]
      const missingFields: string[] = []
      if (ctx.product === 'perp' && ctx.positionId === null) missingFields.push('未录入/未引用已确认持仓：按一般结构研究处理')
      if (ctx.product === 'event' && ctx.quoteId === null) missingFields.push('未录入/未引用事件报价：EV 不可计算')
      if (ctx.horizon === '1w') missingFields.push('1w 为方向研究期限（非币安事件合约产品期限）')
      // 工具白名单（九轮修复；评审 R4 升级为代码门控）：发布配置 roles[].tools 并集与流水线
      // 工具域取交集；未配置角色时保留工程默认（三件套）。search 能力关闭时 web_search 不可用。
      // 被排除的工具域在对应阶段入口由 assertToolAllowed 拒绝执行（不再是仅提示）
      const roles = ((ctx.frozenConfig?.raw as { roles?: { tools?: string[] }[] } | undefined)?.roles ?? [])
      const roleTools = new Set(roles.flatMap((r) => r.tools ?? []))
      const searchEnabled = searchConfigFor(ctx).enabled === true
      const requiredTools = (roleTools.size > 0
        ? TOOL_DOMAIN.filter((t) => roleTools.has(t))
        : TOOL_DOMAIN.filter((t) => t !== 'web_search')
      ).filter((t) => (t === 'web_search' ? searchEnabled : true))
      for (const t of ['market_snapshot', 'brooks_engine', 'knowledge_retrieval'] as const) {
        if (!requiredTools.includes(t)) missingFields.push(`工具白名单未启用 ${t}：对应阶段将被代码门控拒绝执行`)
      }
      // 新闻/消息面/归因类问题需要 web 搜索证据：能力未启用时显式降级说明（不伪造）；
      // 已启用时 searchNeeded=true，retrieve 阶段执行「搜索 → 原页核验 → 冻结证据」
      const newsy = NEWS_QUERY_RE.test(ctx.question ?? '')
      if (newsy && !searchEnabled) {
        missingFields.push('search 能力未配置：web 搜索不可用，消息面/归因证据缺失（待配置，不伪造新闻）')
      }
      const baseQuery = ctx.question ?? `${ctx.symbol} ${ctx.horizon} 结构与业务评估`
      ctx.plan = {
        intent: `${ctx.product} 研究：${ctx.symbol}（${ctx.marketType}，期限 ${ctx.horizon}）`,
        timeframes,
        requiredTools,
        retrievalQueries: [baseQuery, `${ctx.symbol} pullback H2 L2 second entry`],
        searchNeeded: searchEnabled && newsy,
        missingFields,
      }
    },
  }

  const snapshot: Stage = {
    name: 'snapshot',
    async run(ctx: RunContext): Promise<void> {
      assertToolAllowed(ctx, 'market_snapshot')
      const frozen = await createFrozenSnapshot({
        symbol: ctx.symbol,
        marketType: ctx.marketType,
        horizon: ctx.horizon,
        asOf: ctx.asOf,
        persist: true,
        // 实时指数参考价只有事件研究需要（strike_relative）；永续/方向/教学用
        // 已收盘窗口价，不被 5s 实时价时效门阻断（参考价质量门不再误伤 perp 动作）
        needReferencePrice: ctx.product === 'event',
      })
      ctx.snapshotId = frozen.snapshotId
      ctx.qualityIssues = frozen.issues
      ctx.snapshotPack = { candles: frozen.inputPack.candles, funding: frozen.inputPack.funding, indexRef: frozen.inputPack.indexRef }
      ctx.knowledgeVersion = ctx.frozenConfig?.knowledgeVersionId ?? null
      ctx.ruleVersion = 'engine-2.0.0'
      ctx.configVersion = ctx.frozenConfig?.label ?? 'default-v1'
      await pinRunVersions(ctx.runId, {
        snapshotId: ctx.snapshotId,
        knowledgeVersion: ctx.knowledgeVersion,
        ruleVersion: ctx.ruleVersion,
        configVersion: ctx.configVersion,
      })
      ctx.usage.toolCalls += 1 // market_snapshot
      if (frozen.issues.length > 0) {
        log.warn('research', '快照质量问题（阻止动作与概率输出）', kv({ run: ctx.runId.slice(0, 8), 问题: frozen.issues.map((i) => i.code).join(',') }))
      }
    },
  }

  const structures: Stage = {
    name: 'structures',
    async run(ctx: RunContext): Promise<void> {
      assertToolAllowed(ctx, 'brooks_engine')
      const execTf = EXEC_TF[ctx.horizon] ?? '15m'
      const bgTf = BACKGROUND_TF[ctx.horizon] ?? '1h'
      const exec = analyzeFromPack(ctx.snapshotPack, execTf)
      const bg = analyzeFromPack(ctx.snapshotPack, bgTf)
      const perTimeframe: Record<string, { regime: string; alwaysIn: string; signalCount: number; topSignals: string[] }> = {}
      const structureView: StructureView = {
        execDirection: directionOf(exec),
        backgroundDirection: directionOf(bg),
        conflict: false,
        conflictDetail: null,
        confirmedSetup: null,
        recentInvalidations: [],
      }
      const all: [string, BrooksAnalysis | null][] = [[execTf, exec], [bgTf, bg]]
      for (const [tf, a] of all) {
        perTimeframe[tf] = {
          regime: a?.summary.regime ?? '数据不足',
          alwaysIn: a?.alwaysIn.direction ?? 'unknown',
          signalCount: a?.signals.length ?? 0,
          topSignals: (a?.signals ?? []).slice(-6).map((s) => `${s.kind}@${s.direction ?? ''}`),
        }
      }
      if (
        structureView.execDirection !== 'neutral' &&
        structureView.backgroundDirection !== 'neutral' &&
        structureView.execDirection !== structureView.backgroundDirection
      ) {
        structureView.conflict = true
        structureView.conflictDetail = `执行周期 ${execTf}=${structureView.execDirection} 与背景周期 ${bgTf}=${structureView.backgroundDirection} 方向冲突`
      }
      // 结构事件保留周期来源（评审 F9）：合并时标记每条事件的周期与该周期序列长度；
      // 「最新 setup」只从执行周期选取（入场决策基于执行周期结构），按事件实际时间排序；
      // 失效距今根数用事件所属周期的序列长度计算
      const tagged: { tf: string; barsTotal: number; e: StructureEvent }[] = []
      for (const [tf, a] of all) {
        if (a === null) continue
        const total = a.bars.length
        for (const e of a.events) {
          if (e.knownAtTime === null || e.knownAtTime <= ctx.asOf) tagged.push({ tf, barsTotal: total, e })
        }
      }
      const execSetups = tagged
        .filter((x) => x.tf === execTf && (x.e.kind === 'trigger' || x.e.kind === 'setup'))
        .sort((a, b) => a.e.atTime - b.e.atTime)
      const last = execSetups[execSetups.length - 1]
      if (last !== undefined) {
        structureView.confirmedSetup = {
          ruleId: last.e.ruleId,
          direction: last.e.direction === 'bull' ? 'bull' : last.e.direction === 'bear' ? 'bear' : 'neutral',
        }
      }
      structureView.recentInvalidations = tagged
        .filter((x) => x.e.kind === 'invalidation' || x.e.kind === 'expiry')
        .map((x) => ({
          direction: (x.e.direction === 'bull' ? 'bull' : x.e.direction === 'bear' ? 'bear' : 'neutral') as StructureView['recentInvalidations'][number]['direction'],
          barsAgo: x.barsTotal - x.e.atIndex,
        }))
      const db = getDb()
      if (db) {
        const rows = tagged.slice(-400).map((x) => ({
          snapshotId: ctx.snapshotId!,
          symbol: ctx.symbol,
          marketType: ctx.marketType,
          interval: x.tf,
          ruleId: x.e.ruleId,
          ruleVersion: x.e.ruleVersion,
          kind: x.e.kind,
          direction: x.e.direction ?? null,
          atIndex: x.e.atIndex,
          atTime: x.e.atTime,
          knownAtIndex: x.e.knownAtIndex,
          knownAtTime: x.e.knownAtTime,
          barIndices: x.e.barIndices,
          provisional: x.e.provisional === true,
          note: x.e.note ?? '',
          payload: { ...x.e, tf: x.tf } as unknown as Record<string, unknown>,
        }))
        if (rows.length > 0) await db.insert(structureEvents).values(rows)
      }
      ctx.usage.toolCalls += 1 // brooks_engine
      v2of(ctx).structureView = structureView
      ctx.structures = { perTimeframe, eventIds: [] }
    },
  }

  const retrieve: Stage = {
    name: 'retrieve',
    async run(ctx: RunContext): Promise<void> {
      assertToolAllowed(ctx, 'knowledge_retrieval')
      const queries = ctx.plan?.retrievalQueries ?? [ctx.question ?? ctx.symbol]
      const primary = queries[0] ?? ctx.symbol
      const kvId = ctx.frozenConfig?.knowledgeVersionId ?? ctx.knowledgeVersion
      // 检索策略（九轮修复）：数量不再固定 6/4，读创建时冻结的发布配置 retrieval
      const strat = (ctx.frozenConfig?.raw as { retrieval?: { finalLimit?: number; counterFinalLimit?: number; variants?: number } } | undefined)?.retrieval
      const supportLimit = typeof strat?.finalLimit === 'number' && strat.finalLimit > 0 ? Math.min(20, Math.round(strat.finalLimit)) : 6
      const counterLimit = typeof strat?.counterFinalLimit === 'number' && strat.counterFinalLimit > 0 ? Math.min(20, Math.round(strat.counterFinalLimit)) : Math.max(2, Math.round((supportLimit * 2) / 3))
      // LLM 改写变体（retrieval.variants，feat/chat-first-advisor）：仅主检索两路开启
      // （规则关联的逐目标检索不开启，避免 LLM 调用随目标数膨胀）；
      // 预算护栏：chat 能力可用且 LLM 预算剩余 ≥2 次才启用，用量按最坏情况 +2 记账
      const variantCap = typeof strat?.variants === 'number' && strat.variants > 0 ? Math.min(2, Math.round(strat.variants)) : 0
      // 评审 F4：检索全部消费冻结能力配置（embedding/rerank/查询改写严格用冻结值，不回退全局）
      const frozenCaps = (ctx.frozenConfig?.raw as { capabilities?: AgentCapabilities } | undefined)?.capabilities
      const chatCapOn = frozenCaps !== undefined
        ? frozenCaps.chat?.enabled === true && !!frozenCaps.chat.baseUrl && !!frozenCaps.chat.model
        : resolveLlmClient() !== null
      const llmBudgetLeft = (ctx.frozenConfig?.budgets.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS) - ctx.usage.llmCalls
      const variantsOn = variantCap > 0 && chatCapOn && llmBudgetLeft >= 2
      // P0-6：run 内改写提示词只读冻结全文（红线 #2：执行阶段不再解析发布指针）
      const frozenRewritePrompt = frozenPrompt(ctx.frozenConfig?.raw as Parameters<typeof frozenPrompt>[0], 'query-rewrite')?.content
      const support = await searchHybrid(primary, { finalLimit: supportLimit, knowledgeVersionId: kvId ?? undefined, llmVariants: variantsOn ? variantCap : 0, caps: frozenCaps, frozenQueryRewritePrompt: frozenRewritePrompt ?? undefined })
      const counter = await searchHybrid(`${primary} failure invalidation risk`, { mode: 'counter', finalLimit: counterLimit, knowledgeVersionId: kvId ?? undefined, llmVariants: variantsOn ? 1 : 0, caps: frozenCaps, frozenQueryRewritePrompt: frozenRewritePrompt ?? undefined })
      if (variantsOn) ctx.usage.llmCalls += 2
      const freeze = async (stance: 'support' | 'counter', hits: typeof support.hits): Promise<string[]> =>
        freezeEvidence(
          ctx.runId,
          hits.map((h) => ({
            stance,
            kind: h.chunk.id.startsWith('rulecard:') || h.chunk.id.startsWith('case:') ? ('rule_card' as const) : ('knowledge_chunk' as const),
            refId: h.chunk.id,
            docVersionId: h.chunk.docVersionId,
            pageNo: h.chunk.pageNo,
            figureId: h.chunk.figureId,
            contentHash: h.chunk.contentHash,
            sourceTier: h.docSourceTier,
            text: h.chunk.text.slice(0, 2000),
          })),
        )
      const supportIds = await freeze('support', support.hits)
      const counterIds = await freeze('counter', counter.hits)

      // ---- 理论关联链路（K 线结构 → Brooks 规则 → 适用条件与反例 → 引用）----
      // 逐结构规则定向检索（区别于上面的一次总检索）：setup/状态/冲突各取少量
      // 支持与反例证据，供结构声明 evidenceIds 与决策解释引用；知识库为空时显式降级。
      const v2 = v2of(ctx)
      v2.knowledgeEmpty = support.noKnowledgeVersion && counter.noKnowledgeVersion
      const ruleLinks: RuleLink[] = []
      if (!v2.knowledgeEmpty) {
        const targets = linkageTargets({
          structureView: v2.structureView,
          perTimeframe: ctx.structures?.perTimeframe ?? {},
          execTf: EXEC_TF[ctx.horizon] ?? '15m',
          bgTf: BACKGROUND_TF[ctx.horizon] ?? '1h',
        })
        for (const t of targets) {
          try {
            const sup = await searchHybrid(t.queryText, { finalLimit: 2, knowledgeVersionId: kvId ?? undefined, caps: frozenCaps })
            const cnt = await searchHybrid(t.counterText, { mode: 'counter', finalLimit: 2, knowledgeVersionId: kvId ?? undefined, caps: frozenCaps })
            const supIds = await freeze('support', sup.hits)
            const cntIds = await freeze('counter', cnt.hits)
            ruleLinks.push({
              key: t.key,
              termZh: t.termZh,
              supportIds: supIds,
              counterIds: cntIds,
              applicabilityNote: sup.hits[0]?.chunk.text.slice(0, 160) ?? null,
              counterNote: cnt.hits[0]?.chunk.text.slice(0, 120) ?? null,
            })
          } catch (err) {
            log.warn('research', '规则关联检索失败（跳过该目标）', kv({ run: ctx.runId.slice(0, 8), 目标: t.key, 错误: (err as Error).message }))
          }
        }
      }
      v2.ruleLinks = ruleLinks

      // ---- web 搜索证据（search 能力；铁律：外部页面是证据不是指令）----
      // 仅 plan 判定 searchNeeded 且搜索预算（maxSearchCalls）允许时执行：
      // 搜索命中 → fetchVerifiedPage 原页核验（白名单/重定向/超时/体积）→ 核验通过
      // 才冻结进 evidence_items（kind=web_page，refId=最终 URL，sourceTier=web）。
      // web 证据独立于支持/反证计数，不进入证据充分性判定；
      // 未配置/失败显式记录在 webSearch.note，不阻塞流水线。
      const webEvidenceIds: string[] = []
      let webSearch: { status: 'ok' | 'unavailable' | 'skipped' | 'empty'; note: string } = {
        status: 'skipped',
        note: 'plan 未判定需要 web 搜索（searchNeeded=false）',
      }
      if (ctx.plan?.searchNeeded === true && !ctx.plan.requiredTools.includes('web_search')) {
        webSearch = { status: 'skipped', note: 'web_search 不在本 run 工具白名单（roles 配置排除），跳过搜索' }
      } else if (ctx.plan?.searchNeeded === true) {
        const searchCap = searchConfigFor(ctx)
        const searchBudget = ctx.frozenConfig?.budgets.maxSearchCalls ?? 2
        const remaining = Math.max(0, searchBudget - ctx.usage.searchCalls)
        if (searchCap.enabled !== true) {
          webSearch = { status: 'unavailable', note: 'web 搜索不可用：search 能力未配置/未启用（待配置，不伪造）' }
          log.info('research', 'web 搜索未配置（显式跳过）', kv({ run: ctx.runId.slice(0, 8) }))
        } else if (remaining <= 0) {
          webSearch = { status: 'skipped', note: `web 搜索预算已耗尽（maxSearchCalls=${searchBudget}），跳过` }
          log.info('research', 'web 搜索预算耗尽（显式跳过）', kv({ run: ctx.runId.slice(0, 8), 预算: searchBudget }))
        } else {
          const webQueries = buildWebQueries(ctx.symbol, ctx.question).slice(0, Math.min(2, remaining))
          ctx.usage.searchCalls += webQueries.length
          const webItems = await searchAndVerify(webQueries, { config: searchCap })
          if (webItems.length === 0) {
            webSearch = { status: 'empty', note: 'web 搜索无可用证据：搜索失败或原页核验全部未通过（不伪造）' }
            log.warn('research', 'web 搜索无核验通过的证据', kv({ run: ctx.runId.slice(0, 8), 查询: webQueries.join(' / ') }))
          } else {
            webEvidenceIds.push(
              ...(await freezeEvidence(
                ctx.runId,
                webItems.map((w) => ({
                  stance: 'support' as const,
                  kind: 'web_page' as const,
                  refId: w.url,
                  sourceTier: 'web',
                  text: `${w.title}（${w.url}）\n${w.pageText}`.slice(0, 2000),
                })),
              )),
            )
            webSearch = { status: 'ok', note: `web 证据 ${webEvidenceIds.length} 条（${webQueries.length} 次搜索，原页核验通过）` }
            log.ok('research', 'web 证据已冻结', kv({ run: ctx.runId.slice(0, 8), 证据数: webEvidenceIds.length, 搜索次数: webQueries.length }))
          }
        }
      }

      ctx.usage.toolCalls += 1 // knowledge_retrieval
      ctx.retrieval = {
        supportEvidenceIds: [...supportIds, ...ruleLinks.flatMap((l) => l.supportIds)],
        counterEvidenceIds: [...counterIds, ...ruleLinks.flatMap((l) => l.counterIds)],
        citations: support.debug.hits,
        webEvidenceIds,
        webSearch,
      }
    },
  }

  const productAnalysis: Stage = {
    name: 'product_analysis',
    async run(ctx: RunContext): Promise<void> {
      const v2 = v2of(ctx)
      // 防御性缺省：旧检查点（补字段前落库）或异常路径恢复时 ruleLinks 可能缺失
      if (v2.ruleLinks === undefined) v2.ruleLinks = []
      if (v2.knowledgeEmpty === undefined) v2.knowledgeEmpty = false
      v2.v2Payload = {}
      v2.probabilityBlock = null
      v2.eventAnalysis = null
      v2.eventQuoteInput = null
      v2.decision = null
      const claims: RunContext['claims'] = []
      // 结构声明挂理论引用（关联链路）：每条状态声明匹配 `regime:<tf>` 链路，
      // 冲突声明匹配 `conflict` 链路；已确认 setup 单独成声明并挂 `setup:<ruleId>` 链路。
      // 知识库为空时链路为空、声明保持无引用并显式说明（不伪造理论依据）。
      const linkOf = (key: string): RuleLink | undefined => v2.ruleLinks.find((l) => l.key === key)
      for (const [tf, info] of Object.entries(ctx.structures?.perTimeframe ?? {})) {
        const link = linkOf(`regime:${tf}`)
        claims.push({
          text: `${ctx.symbol} ${tf}：状态 ${info.regime}，always-in ${info.alwaysIn}，近期信号 ${info.signalCount} 个${link !== undefined && link.supportIds.length > 0 ? `；Brooks 依据：${link.termZh}（适用条件见引用）` : ''}`,
          kind: 'fact',
          evidenceIds: link?.supportIds ?? [],
        })
      }
      if (v2.structureView.conflict) {
        const link = linkOf('conflict')
        claims.push({
          text: `周期冲突：${v2.structureView.conflictDetail}${link !== undefined && link.supportIds.length > 0 ? `；Brooks 依据：${link.termZh}（冲突期建议见引用）` : ''}`,
          kind: 'fact',
          evidenceIds: link?.supportIds ?? [],
        })
      }
      if (v2.structureView.confirmedSetup !== null) {
        const ruleId = v2.structureView.confirmedSetup.ruleId
        const link = linkOf(`setup:${ruleId}`)
        claims.push({
          text: `已确认 setup：${ruleId}@${v2.structureView.confirmedSetup.direction}${link !== undefined && (link.supportIds.length > 0 || link.counterIds.length > 0) ? `；Brooks 依据：${link.termZh}——${link.applicabilityNote !== null ? `适用：${link.applicabilityNote}` : '适用条件见引用'}${link.counterNote !== null ? `；反例：${link.counterNote}` : ''}` : ''}`,
          kind: 'fact',
          evidenceIds: [...(link?.supportIds ?? []), ...(link?.counterIds ?? [])],
        })
      }
      if (v2.knowledgeEmpty) {
        claims.push({ text: '知识库为空：结构声明无法附 Brooks 理论引用（关联链路不可用，判定回退计数语义）', kind: 'fact', evidenceIds: [] })
      }
      const qualityCode = ctx.qualityIssues[0]?.code as UnavailableCode | undefined
      // 质量门控看完整问题集合（评审 R1：与问题排序无关）——insufficient_history 之外的
      // 任何质量问题（行情过期/窗口缺口/参考价异常）都必须阻断概率与参与动作
      const qualityBlocked = hasBlockingQualityIssue(ctx.qualityIssues)
      const execTf = EXEC_TF[ctx.horizon] ?? '15m'
      const execSeries = ctx.snapshotPack?.candles.find((c) => c.interval === execTf && c.priceType === 'trade')
      const closes = (execSeries?.rows ?? []).map((r) => Number(r.c))
      v2.lastPrice = closes.length > 0 ? closes[closes.length - 1] : null

      if (ctx.product === 'perp') {
        // 交易对一致性：loadPosition 按 ctx.symbol 过滤，聊天切换币种后残留的
        // 旧持仓引用在此按「无持仓」处理（不混用 BTC 入场价与 ETH 行情）
        const position0 = (await loadPosition(ctx.userId, ctx.positionId, ctx.symbol))
        const position = position0 === null ? null : applyOverride(position0, positionOverride)
        const highs = (execSeries?.rows ?? []).map((r) => Number(r.h))
        const lows = (execSeries?.rows ?? []).map((r) => Number(r.l))
        const last = closes[closes.length - 1] ?? 0
        const w = Math.min(14, highs.length)
        const atr = w > 0 ? Math.max(...highs.slice(-w).map((h, i) => h - lows.slice(-w)[i])) : Math.abs(last) * 0.01
        // 费率/步进/名义下限/funding 时效窗口全部读冻结配置（八轮修复；旧 run 缺省回退工程默认）
        const frozenFees: PerpFeeAssumption = ctx.frozenConfig?.fees ?? DEFAULT_PERP_FEES
        const frozenStep = ctx.frozenConfig?.stepSize ?? 0.001
        const frozenMinNotional = ctx.frozenConfig?.minNotional ?? 100
        const fundingWindow = ctx.frozenConfig?.fundingWindow ?? { intervalMs: FUNDING_INTERVAL_MS, graceMs: FUNDING_GRACE_MS }
        if (position === null) {
          v2.v2Payload = {
            kind: 'perp', position: null, marginUsed: null, pnlPoints: [], fundingScenarios: [],
            fundingNote: '无持仓：仅提供新仓风险计划基准（见 conditions/riskCap）',
            fundingStale: false,
            riskCap: { ok: false, maxQty: null, reason: '无风险预算输入：新仓计划需用户确认风险预算与止损', bindingConstraint: null },
            reducePlan: { needed: false, keepQty: null, reduceQty: null, reason: '无持仓' },
            liquidation: { price: null, note: '强平价仅展示用户从 App 确认的数据' },
            feeLegs: null,
            incremental: null,
          }
        } else {
          const isStale = isPositionStale(position.confirmedAt, position.staleAfterHours)
          v2.positionStale = isStale
          if (isStale) {
            // 持仓过期：降级为一般结构研究——不发布盈亏矩阵/减仓/增量等个性化数值，
            // decision 由 decidePerp 保持 request_reconfirm，missingInputs 在 publish 阶段追加
            v2.v2Payload = {
              kind: 'perp',
              position: {
                side: position.side as 'long' | 'short', qty: position.qty, entryPrice: position.entryPrice,
                leverage: position.leverage, marginMode: position.marginMode as 'cross' | 'isolated',
                stopPrice: position.stopPrice, liquidationPrice: position.liquidationPrice, isStale,
              },
              marginUsed: null, pnlPoints: [], fundingScenarios: [],
              fundingNote: '持仓已过期需重新确认：资金费率情景与个性化数值已降级',
              fundingStale: false,
              riskCap: { ok: false, maxQty: null, reason: '持仓已过期需重新确认：个性化仓位上限已降级', bindingConstraint: null },
              reducePlan: { needed: false, keepQty: null, reduceQty: null, reason: '持仓已过期需重新确认：减仓数值已降级' },
              liquidation:
                position.liquidationPrice !== null && Number(position.liquidationPrice) > 0
                  ? { price: Number(position.liquidationPrice), note: '用户从 App 录入的强平价' }
                  : { price: null, note: '缺少账户与保证金档位信息，不提供强平价估算（简化估算不等于真实强平价）' },
              feeLegs: null,
              incremental: null,
            }
            claims.push({ text: `持仓：${position.side === 'long' ? '多' : '空'} ×${position.qty} @ ${position.entryPrice}（${position.leverage}x），已超确认时效——个性化盈亏/减仓/增量数值已降级为一般结构研究`, kind: 'fact', evidenceIds: [] })
          } else {
          // 资金费率统一消费快照冻结值（评审 F3：分析/恢复/快照口径一致，不读 asOf 之后的费率）；
          // 仅旧快照缺 funding 字段时按 asOf 过滤补读
          const packFunding = ctx.snapshotPack?.funding
          const fr: { fundingTime: number; fundingRate: string }[] = packFunding != null
            ? packFunding.map((f) => ({ fundingTime: f.t, fundingRate: f.rate }))
            : await listFunding(ctx.symbol, 12, ctx.asOf)
          // funding 时效（A2）：最新一条距 asOf 超「结算间隔+宽限」→ funding_stale，不静默用旧数据
          const freshness = fundingFreshness(
            fr.length > 0 ? fr[fr.length - 1].fundingTime : null,
            ctx.asOf,
            fundingWindow.intervalMs,
            fundingWindow.graceMs,
          )
          const prices = [last - atr * 2, last - atr, last, last + atr, last + atr * 2]
          const analysis = analyzePerp(
            {
              side: position.side as 'long' | 'short',
              qty: Number(position.qty),
              entryPrice: Number(position.entryPrice),
              leverage: position.leverage,
              marginMode: position.marginMode as 'cross' | 'isolated',
              stopPrice: position.stopPrice === null ? null : Number(position.stopPrice),
              riskBudget: Number(position.riskBudget),
              liquidationPrice: position.liquidationPrice === null ? null : Number(position.liquidationPrice),
            },
            prices, last, atr, fr.map((f) => Number(f.fundingRate)), frozenFees, frozenStep,
            { minNotional: frozenMinNotional, fundingStale: freshness.stale, fundingStaleNote: freshness.reason ?? undefined },
          )
          v2.v2Payload = {
            kind: 'perp',
            position: {
              side: position.side as 'long' | 'short', qty: position.qty, entryPrice: position.entryPrice,
              leverage: position.leverage, marginMode: position.marginMode as 'cross' | 'isolated',
              stopPrice: position.stopPrice, liquidationPrice: position.liquidationPrice, isStale,
            },
            marginUsed: analysis.marginUsed, pnlPoints: analysis.pnlPoints,
            fundingScenarios: analysis.fundingScenarios, fundingNote: analysis.fundingNote,
            fundingStale: analysis.fundingStale,
            riskCap: analysis.riskCap.ok
              ? { ok: true, maxQty: analysis.riskCap.maxQty, reason: analysis.riskCap.reason ?? null, bindingConstraint: analysis.riskCap.bindingConstraint ?? null }
              : { ok: false, maxQty: null, reason: analysis.riskCap.reason ?? null, bindingConstraint: analysis.riskCap.bindingConstraint ?? null },
            reducePlan: analysis.reducePlan, liquidation: analysis.liquidation,
            feeLegs: analysis.feeLegs,
            incremental: analysis.incremental,
          }
          claims.push({ text: `持仓：${position.side === 'long' ? '多' : '空'} ×${position.qty} @ ${position.entryPrice}（${position.leverage}x）`, kind: 'fact', evidenceIds: [] })
          if (position.stopPrice === null) {
            claims.push({ text: '持仓未设置止损：仓位上限为假设止损（入场价±2×ATR）演示值，不作为风险已通过依据；结论要求先补全止损', kind: 'fact', evidenceIds: [] })
          }
          claims.push({ text: `费率档：${analysis.feeLegs.note}（随配置版本冻结）`, kind: 'fact', evidenceIds: [] })
          if (freshness.stale) {
            claims.push({ text: `资金费率情景不可用（funding_stale）：${freshness.reason}`, kind: 'fact', evidenceIds: [] })
          }
          if (analysis.reducePlan.needed) {
            claims.push({ text: `风险：${analysis.reducePlan.reason}；保留 ≤${analysis.reducePlan.keepQty}（减 ${analysis.reducePlan.reduceQty}）`, kind: 'fact', evidenceIds: [] })
          }
          if (analysis.incremental !== null) {
            claims.push({ text: `增量风险：持有到止损增量盈亏 ${analysis.incremental.toStopPnl}（${analysis.incremental.toStopPct}%）；整笔净盈亏见矩阵`, kind: 'fact', evidenceIds: [] })
          }
          }
        }
        if (qualityCode !== undefined) {
          claims.push({ text: `行情质量：${ctx.qualityIssues.map((q) => `${q.code}(${q.detail})`).join('；')}——动作与概率输出受阻`, kind: 'fact', evidenceIds: [] })
        }
      } else if (ctx.product === 'event') {
        // 报价同样按 symbol 过滤：切换币种后残留的旧 quoteId 不进入 EV 计算
        const quote = await loadQuote(ctx.userId, ctx.quoteId, ctx.symbol)
        if (quote === null) {
          v2.v2Payload = { kind: 'event', quote: null, pWin: null, pTie: null, expectedNet: null, breakevenWinRate: 0, breakevenLabel: '', winAmount: 0, loseAmount: 0, unavailableCode: 'missing_quote', unavailableDetail: '未引用报价', unavailableGuidance: QUOTE_GUIDANCE }
        } else {
          const remainingMs = Math.max(0, quote.expiryAt - ctx.asOf)
          const quoteInput: EventQuoteInput = {
            stake: Number(quote.stake),
            totalPayout: Number(quote.totalPayout),
            direction: quote.direction as 'above' | 'below',
            orderState: quote.orderState === 'submitted' ? 'submitted' : 'preview',
            strikeStatus: quote.strikeStatus === 'locked' ? 'locked' : 'preview',
            previewAsOf: quote.previewAsOf ?? quote.asOf,
            eventRiskBudget: quote.eventRiskBudget === null ? null : Number(quote.eventRiskBudget),
          }
          v2.eventQuoteInput = quoteInput
          let prob: { probabilityUp: number; probabilityTie: number | null; modelVersion: string } | null = null
          let probUnavailable: { code: string; detail: string } | null = null
          // 事件特征周期与训练同源（1d/1w 期限的指数特征在 1h 上，不是 1m）：
          // 同名 ret_60 在不同基础周期上语义不同，周期错配会被 featureVersion 门控拒绝
          const evtBaseInterval = baseIntervalFor(ctx.horizon)
          const idxSeries = ctx.snapshotPack?.candles.find((c) => c.interval === evtBaseInterval && c.priceType === 'index')
          const idxCloses = (idxSeries?.rows ?? []).map((r) => Number(r.c))
          const blocked = qualityBlocked
          if (blocked) {
            probUnavailable = { code: 'stale_market', detail: `快照质量问题：${ctx.qualityIssues.map((q) => q.code).join(',')}` }
          } else if (idxCloses.length < MIN_BARS) {
            probUnavailable = { code: 'feature_missing', detail: `指数 ${evtBaseInterval} 特征窗口不足（${idxCloses.length} < ${MIN_BARS}）` }
          } else {
            // 参考价与预测起点一致（评审 F2）：优先消费快照冻结的实时指数参考价
            // （snapshot 阶段已做 ≤5s 时效门控）；历史复盘无实时参考价——
            // 落回输入包内 asOf 前最后一根指数收盘（与 asOf 起点一致）
            const frozenRef = ctx.snapshotPack?.indexRef
            const indexRefPrice = frozenRef != null ? Number(frozenRef.price) : idxCloses[idxCloses.length - 1]
            const outcome = await predictForTarget({
              symbol: ctx.symbol, marketType: ctx.marketType, horizon: ctx.horizon, asOf: ctx.asOf,
              targetType: 'strike_relative', strikePrice: Number(quote.strikePrice),
              indexRefPrice,
              remainingSeconds: Math.round(remainingMs / 1000), closes: idxCloses,
            })
            if (outcome.available) {
              prob = { probabilityUp: outcome.probabilityUp, probabilityTie: outcome.probabilityTie, modelVersion: outcome.modelVersion }
              // 流水线预测落库（C1）：特征/分位/模型版本随 predictions 记录冻结，predictionId 回填概率块
              const predictionId = await persistPipelinePrediction(ctx, quote.id, outcome)
              v2.probabilityBlock = {
                predictionId, modelVersion: outcome.modelVersion, targetType: 'strike_relative', referenceType: 'index',
                probabilityUp: outcome.probabilityUp, probabilityTie: outcome.probabilityTie,
                calibrationId: `policy-v1:${outcome.featureVersion}`,
              }
              ctx.modelVersion = outcome.modelVersion
              await pinRunVersions(ctx.runId, { modelVersion: outcome.modelVersion })
            } else {
              probUnavailable = { code: outcome.code, detail: outcome.detail }
            }
          }
          const analysis = analyzeEvent(quoteInput, prob, probUnavailable, ctx.asOf)
          v2.eventAnalysis = analysis
          v2.v2Payload = {
            kind: 'event',
            quote: {
              orderState: quoteInput.orderState, strikeStatus: quoteInput.strikeStatus, strikePrice: quote.strikePrice,
              expiryAt: quote.expiryAt, stake: quote.stake, totalPayout: quote.totalPayout,
              direction: quote.direction as 'above' | 'below', previewExpired: analysis.previewExpired, remainingMs,
            },
            pWin: analysis.pWin, pTie: analysis.pTie, expectedNet: analysis.expectedNet,
            breakevenWinRate: analysis.breakevenWinRate, breakevenLabel: analysis.breakevenLabel,
            winAmount: analysis.winAmount, loseAmount: analysis.loseAmount,
            unavailableCode: analysis.unavailableCode, unavailableDetail: analysis.unavailableDetail,
          }
          claims.push({
            text: `报价：${quoteInput.orderState === 'submitted' ? '已提交订单（固定值）' : '参与前预览'}；${analysis.breakevenLabel} = ${analysis.breakevenWinRate.toFixed(4)}`,
            kind: 'fact', evidenceIds: [],
          })
          if (analysis.pWin !== null) {
            claims.push({ text: `模型（${prob?.modelVersion}）：${quote.direction === 'above' ? 'P(高于平价区间上界)' : 'P(低于平价区间下界)'}=${analysis.pWin.toFixed(4)}${analysis.pTie !== null ? `，平价区间=${analysis.pTie.toFixed(4)}（互斥三分支，pDown=1−pWin−pTie）` : '，平价精度未知（EV 不可用）'}`, kind: 'fact', evidenceIds: [] })
          }
        }
      } else if (ctx.horizon === '1w') {
        // 方向研究（研究模式）：return_positive 模型的分布输出，不给参与动作；
        // 特征周期与训练同源（1w 基础周期 1h），周期错配由 featureVersion 门控拦截
        const dirBaseInterval = baseIntervalFor('1w')
        const dirSeries = ctx.snapshotPack?.candles.find((c) => c.interval === dirBaseInterval && c.priceType === 'trade')
        const dirCloses = (dirSeries?.rows ?? []).map((r) => Number(r.c))
        let directionPayload: Record<string, unknown> = {
          kind: 'direction', horizon: '1w', researchMode: true, quantiles: null, probabilityUp: null,
          unavailableCode: 'model_not_published', unavailableDetail: '',
        }
        const dirBlocked = qualityBlocked
        if (dirBlocked) {
          directionPayload = { ...directionPayload, unavailableCode: 'stale_market', unavailableDetail: `快照质量问题：${ctx.qualityIssues.map((q) => q.code).join(',')}` }
        } else if (dirCloses.length < MIN_BARS) {
          directionPayload = { ...directionPayload, unavailableCode: 'feature_missing', unavailableDetail: `${dirBaseInterval} 特征窗口不足（${dirCloses.length} < ${MIN_BARS}）` }
        } else {
          const outcome = await predictForTarget({
            symbol: ctx.symbol, marketType: ctx.marketType, horizon: '1w', asOf: ctx.asOf,
            targetType: 'return_positive', closes: dirCloses,
          })
          if (outcome.available) {
            directionPayload = {
              kind: 'direction', horizon: '1w', researchMode: true,
              quantiles: outcome.quantiles, probabilityUp: outcome.probabilityUp,
              modelVersion: outcome.modelVersion, unavailableCode: null, unavailableDetail: null,
            }
            // 方向研究预测同样落库（quoteId=null；研究模式不关联报价）
            const dirPredictionId = await persistPipelinePrediction(ctx, null, outcome)
            v2.probabilityBlock = {
              predictionId: dirPredictionId, modelVersion: outcome.modelVersion, targetType: 'return_positive', referenceType: 'trade',
              probabilityUp: outcome.probabilityUp, probabilityTie: null,
              calibrationId: `policy-v1:${outcome.featureVersion}`,
            }
            ctx.modelVersion = outcome.modelVersion
            await pinRunVersions(ctx.runId, { modelVersion: outcome.modelVersion })
            claims.push({ text: `1w 方向研究（${outcome.modelVersion}）：P(周对数收益>0)=${outcome.probabilityUp.toFixed(4)}（研究模式，非币安事件合约产品）`, kind: 'fact', evidenceIds: [] })
          } else {
            directionPayload = { ...directionPayload, unavailableCode: outcome.code, unavailableDetail: outcome.detail }
          }
        }
        v2.v2Payload = directionPayload
      } else {
        const support = ctx.retrieval?.supportEvidenceIds ?? []
        v2.v2Payload = { kind: 'teaching', citations: support.slice(0, 5).map((id) => ({ evidenceId: id, docTitle: '', pageNo: null })) }
      }
      // 决策前置（P1 修复 #5）：在校验之前生成——publish 不再决定动作；
      // 行情质量硬阻断：质量问题存在时 perp 动作一律 wait（事件链路已由概率阻断）。
      // 证据充分性（关联链路语义）：优先看「有引用的结构声明」是否存在
      // （linkedSupport>0）；知识库为空时回退总计数语义（不因无库而阻断研究）。
      const linkedSupport = v2.ruleLinks.reduce((acc, l) => acc + l.supportIds.length, 0)
      const evidenceCount0 = (ctx.retrieval?.supportEvidenceIds.length ?? 0) + (ctx.retrieval?.counterEvidenceIds.length ?? 0)
      const evidenceSufficient = v2.knowledgeEmpty ? evidenceCount0 > 0 : linkedSupport > 0
      const marketQualityOk = ctx.qualityIssues.length === 0
      if (ctx.product === 'perp') {
        const position0raw = await loadPosition(ctx.userId, ctx.positionId, ctx.symbol)
        const position0 = position0raw === null ? null : applyOverride(position0raw, positionOverride)
        const d = decidePerp({
          structure: v2.structureView,
          position:
            position0 === null
              ? null
              : {
                  side: position0.side as 'long' | 'short',
                  isStale: isPositionStale(position0.confirmedAt, position0.staleAfterHours),
                  stopPrice: position0.stopPrice === null ? null : Number(position0.stopPrice),
                  // 快照最后价：止损触发判断（当前价已穿越用户确认的止损价 → exit）
                  lastPrice: v2.lastPrice ?? null,
                },
          reducePlan: (v2.v2Payload as { reducePlan?: { needed: boolean } }).reducePlan ?? null,
          riskCap: (v2.v2Payload as { riskCap?: { ok: boolean; maxQty: number | null } }).riskCap ?? null,
          evidenceSufficient,
          marketQualityOk,
        })
        v2.decision = { action: d.action as ResearchResultV2['decision'], side: d.side, reasons: d.reasons, conditions: d.conditions }
      } else if (ctx.product === 'event') {
        const a = v2.eventAnalysis
        if (a === null) {
          v2.decision = { action: 'insufficient_evidence', side: null, reasons: ['未引用事件报价：EV 无法计算（结构结论不受影响；补全方式见下方引导）'], conditions: [] }
        } else if (a.orderState === 'submitted') {
          v2.decision = {
            action: decideEventSubmitted({ expired: (v2.v2Payload.quote as { remainingMs?: number } | undefined)?.remainingMs === 0, settled: false }),
            side: null,
            reasons: ['已提交订单：执行价/到期/返还固定，只研究剩余期限与到期结果（不建议提前平仓）'],
            conditions: [],
          }
        } else {
          const gate = eventEntryGate(a, v2.eventQuoteInput!, !v2.structureView.conflict)
          v2.decision = gate.pass
            ? { action: 'conditional_entry', side: null, reasons: [`EV=${a.expectedNet} > 0 且五门槛通过（预算已确认）`], conditions: ['失效：剩余期限出界/报价过期刷新/结构或反证转向'] }
            : { action: 'wait', side: null, reasons: [gate.detail || '参与门槛未通过'], conditions: [] }
        }
      } else if (ctx.horizon === '1w') {
        v2.decision = { action: decideDirection(), side: null, reasons: ['方向研究模式：只输出分布与研究标识，不给参与动作'], conditions: [] }
      } else {
        v2.decision = { action: evidenceSufficient ? 'wait' : 'insufficient_evidence', side: null, reasons: [], conditions: [] }
      }
      ctx.claims = claims
    },
  }

  const countercase: Stage = {
    name: 'countercase',
    async run(ctx: RunContext): Promise<void> {
      const v2 = v2of(ctx)
      if (v2.ruleLinks === undefined) v2.ruleLinks = []
      if (v2.knowledgeEmpty === undefined) v2.knowledgeEmpty = false
      const ids = ctx.retrieval?.counterEvidenceIds ?? []
      const counterClaims: RunContext['counterClaims'] = []
      if (v2.structureView.conflict) {
        const link = v2.ruleLinks.find((l) => l.key === 'conflict')
        counterClaims.push({
          text: `${v2.structureView.conflictDetail}：冲突期间方向结论都应视为低质量，优先等待`,
          evidenceIds: link?.counterIds ?? [],
          origin: 'template',
        })
      }
      // 逐规则反例声明（关联链路的反证侧）：每个有反例证据的规则出一条，
      // 文本取自反例片段摘要——「这条理论为什么不总适用」直接可见
      for (const link of v2.ruleLinks) {
        if (link.counterIds.length === 0 || link.counterNote === null) continue
        counterClaims.push({
          text: `「${link.termZh}」反例：${link.counterNote}`,
          evidenceIds: link.counterIds,
          origin: 'template',
        })
      }
      if (ids.length === 0) {
        counterClaims.push({ text: '知识库未命中明确反证资料：不构成支持证据，仅表示反证检索为空', evidenceIds: [], origin: 'template' })
      }
      // 角色模板（九轮修复 + P0-6 冻结语义）：优先只读冻结集（创建时已终解析，
      // 含 counterRole.promptRef 显式引用——inline:/registry:/旧文件名兼容链在冻结时完成）；
      // 旧检查点恢复（frozen 无 prompts 字段）时回退执行期解析：counterRole.promptRef
      // （resolveRolePrompt 兼容）→ 注册表指针 → 工程默认；角色级 budget 优先于全局预算
      const roles = ((ctx.frozenConfig?.raw as { roles?: { name?: string; promptRef?: string; budget?: { maxLlmCalls?: number; maxRuntimeMs?: number } }[] } | undefined)?.roles ?? [])
      const counterRole = roles.find((r) => /counter|反证/i.test(r.name ?? '')) ?? null
      let counterSystem: string
      const frozenCounter = frozenPrompt(ctx.frozenConfig?.raw as Parameters<typeof frozenPrompt>[0], 'counter-reviewer')
      if (frozenCounter !== null) {
        counterSystem = frozenCounter.content
      } else if (counterRole?.promptRef !== undefined && (await resolveRolePrompt(counterRole.promptRef)) !== null) {
        counterSystem = (await resolveRolePrompt(counterRole.promptRef))!
        log.warn('research', '旧检查点无冻结提示词，回退角色 promptRef 解析', kv({ run: ctx.runId.slice(0, 8), promptRef: counterRole.promptRef }))
      } else {
        counterSystem = DEFAULT_PROMPTS['counter-reviewer']
        log.warn('research', '反证提示词回退工程默认（无冻结集且无 promptRef）', kv({ run: ctx.runId.slice(0, 8) }))
      }
      const roleLlmBudget = counterRole?.budget?.maxLlmCalls
      const llm = resolveLlmClient((ctx.frozenConfig?.raw as { capabilities?: Parameters<typeof resolveLlmClient>[0] } | undefined)?.capabilities)
      const budget = roleLlmBudget ?? ctx.frozenConfig?.budgets.maxLlmCalls ?? 6
      if (llm !== null && ids.length > 0 && ctx.usage.llmCalls < budget) {
        // 调用前预算检查（不是事后）：时间剩余不足或费用预留超限 → 不发起调用，降级保留规则反证
        const roleRuntimeBudget = counterRole?.budget?.maxRuntimeMs
        const runtimeBudget = roleRuntimeBudget ?? ctx.frozenConfig?.budgets.maxRuntimeMs
        const remainingMs = runtimeBudget !== undefined ? runtimeBudget - (Date.now() - ctx.runStartedAt) : undefined
        if (remainingMs !== undefined && remainingMs < 10_000) {
          counterClaims.push({ text: `运行时间预算剩余 ${Math.max(0, remainingMs)}ms，不足以发起 LLM 反证归纳：保留规则反证`, evidenceIds: [], origin: 'template' })
        } else {
          const promptDraft = `结构：${JSON.stringify(ctx.structures?.perTimeframe ?? {})}`
          const maxTokens = 500
          const estCost = estimateMaxLlmCallCostUsd(promptDraft.length + 300, maxTokens)
          const costCap = ctx.frozenConfig?.budgets.maxCostUsd
          if (costCap !== undefined && estCost !== null && ctx.usage.costUsd + estCost > costCap) {
            counterClaims.push({ text: `LLM 调用费用预估 $${estCost.toFixed(4)} 将超出预算上限 $${costCap}（已用 $${ctx.usage.costUsd.toFixed(4)}）：保留规则反证`, evidenceIds: [], origin: 'template' })
          } else {
        try {
          const rows = await getDb()!
            .select()
            .from(evidenceItems)
            .where(and(eq(evidenceItems.runId, ctx.runId), eq(evidenceItems.stance, 'counter')))
            .limit(6)
          const out = await llm.complete({
            system: counterSystem,
            user: `${promptDraft}\n\n反证：\n${rows.map((e, i) => `[${i + 1}] ${e.text.slice(0, 500)}`).join('\n')}`,
            maxTokens,
            timeoutMs: remainingMs,
          })
          ctx.usage.llmCalls += 1
          ctx.usage.tokens += out.usage.promptTokens + out.usage.completionTokens
          // 费用上限执行来源：单价已配置时累计估算费用（未配置保持 0，不假装执行）
          const callCost = estimateLlmCostUsd(out.usage)
          if (callCost !== null) ctx.usage.costUsd += callCost
          for (const line of parseClaimLines(out.text, 5)) {
            // 「无 / 无可用反证输出：无。」等空输出形态不是声明（e2e 实测 LLM 会带修饰词）
            if (line === '无' || /^无可用反证输出|^：?无[。．.]?$/.test(line.trim())) continue
            // P0-3 逐条证据绑定：行尾 [k] 标记精确绑定；无标记/越界回退锚定词项重叠；
            // 剥离标记后的净文本入库（前端不渲染引用编号语法）。仍无重叠 → 空绑定+标注（不误绑）
            const { text: cleanLine } = stripCiteMarkers(line)
            const bound = bindCounterEvidence(line, rows.map((e) => ({ id: e.id, text: e.text })))
            if (bound.mode === 'anchored' && bound.evidenceIds.length === 0) {
              log.warn('research', '反证声明未能绑定任何证据（锚定词项无重叠，保持空绑定）', kv({ run: ctx.runId.slice(0, 8), 声明: cleanLine.slice(0, 60) }))
            }
            counterClaims.push({ text: cleanLine, evidenceIds: bound.evidenceIds, origin: 'llm' })
          }
        } catch (err) {
          counterClaims.push({ text: `（LLM 反证归纳失败，保留规则反证：${(err as Error).message.slice(0, 120)}）`, evidenceIds: [], origin: 'template' })
        }
          }
        }
      }
      // ---- 事件参与的最终建议门控（反证完成后）：方向适用性 + 反证结论进入决策 ----
      // 此前 eventEntryGate 只看「无周期冲突」，结构方向与报价方向相反也能通过——
      // 现在在反证生成后执行 gateEventDirection：否决/证据不足降为 wait（原因明确），
      // 通过则把理论与反证审查结论附进建议理由。
      if (ctx.product === 'event' && v2.decision !== null && v2.decision.action === 'conditional_entry' && v2.eventQuoteInput !== null) {
        const linkedCounter = counterClaims.filter((c) => c.evidenceIds.length > 0)
        v2.decision = applyEventDirectionGate(v2.decision, {
          quoteDirection: v2.eventQuoteInput.direction,
          execDirection: v2.structureView.execDirection,
          backgroundDirection: v2.structureView.backgroundDirection,
          linkedCounterClaims: linkedCounter.length,
          counterSummaries: linkedCounter.slice(0, 2).map((c) => c.text.slice(0, 80)),
        }) as typeof v2.decision
      }
      ctx.counterClaims = counterClaims
    },
  }

  const validate: Stage = {
    name: 'validate',
    async run(ctx: RunContext): Promise<void> {
      const v2 = v2of(ctx)
      const known = new Set([
        ...(ctx.retrieval?.supportEvidenceIds ?? []),
        ...(ctx.retrieval?.counterEvidenceIds ?? []),
        // web 证据（search 能力，retrieve 阶段冻结）同样可被判引用存在
        ...(ctx.retrieval?.webEvidenceIds ?? []),
      ])
      // 关联链路检查：知识库非空时，持仓/开仓级动作必须有「带引用的结构声明」支撑，
      // 否则视为理论依据缺失（unlinked_decision）——只看总数不再视为充分。
      const decisionAction = v2.decision?.action ?? ''
      const actionNeedsTheory = ['hold', 'reduce', 'exit', 'conditional_entry'].includes(decisionAction)
      const linkedClaims = ctx.claims.filter((c) => c.evidenceIds.length > 0).length
      const unlinkedIssues: string[] = []
      if (!v2.knowledgeEmpty && actionNeedsTheory && linkedClaims === 0) {
        unlinkedIssues.push(`unlinked_decision: 动作 ${decisionAction} 没有任何带理论引用的结构声明支撑（知识库非空时要求至少一条）`)
      }
      // perp 数值复算与方向逻辑接线（八轮修复 B1）：保证金按 qty×entry/leverage 复算，
      // 方向逻辑（long: stop<entry / short: stop>entry）由代码校验，不一致即拒绝
      let perpCheck: Parameters<typeof validateResearch>[0]['perp']
      if (ctx.product === 'perp' && (v2.v2Payload as { kind?: string }).kind === 'perp') {
        const p = v2.v2Payload as {
          position: { side: 'long' | 'short'; qty: string; entryPrice: string; leverage: number; stopPrice: string | null } | null
          marginUsed: number | null
        }
        if (p.position !== null && !v2.positionStale) {
          const entryPrice = Number(p.position.entryPrice)
          const qty = Number(p.position.qty)
          perpCheck = {
            breakevenOrPnl:
              p.marginUsed !== null
                ? { computed: (qty * entryPrice) / Math.max(1, p.position.leverage), reported: p.marginUsed, label: '保证金', tolerance: 1e-3 }
                : undefined,
            positionLogic: {
              side: p.position.side,
              entryPrice,
              stopPrice: p.position.stopPrice === null ? null : Number(p.position.stopPrice),
              // 已有持仓：止损可能是浮盈后上移的保护止损（多头 stop>入场合法），
              // 有效性结合当前价判断；新仓计划才要求止损在入场亏损侧
              isExistingPosition: true,
              lastPrice: v2.lastPrice ?? null,
            },
          }
        }
      }
      // 版本一致性真校验（九轮修复）：与 run 行持久化的冻结配置重新算哈希比较——
      // 本次实际使用的配置（ctx.frozenConfig，各阶段全部读它）与创建时冻结值一致；
      // Admin 运行中发布新版本只影响新 run，不再使旧冻结任务 version_mismatch
      const persistedRun = await getRun(ctx.runId)
      const runtimeHash =
        ctx.frozenConfig !== null && persistedRun !== null && persistedRun.frozenConfig !== null
          ? hashFrozenConfig(persistedRun.frozenConfig as NonNullable<RunContext['frozenConfig']>)
          : null
      // 质量硬条件的独立校验（评审 R1）：存在阻断性质量问题（过期/缺口/参考价异常，与排序无关）
      // 时不得产出概率块——阶段门控之外的第二道防线
      if (hasBlockingQualityIssue(ctx.qualityIssues) && v2.probabilityBlock !== null) {
        throw new ValidationRejected(['quality_gate: 存在阻断性质量问题但已产出概率块'])
      }
      const result = validateResearch({
        claims: ctx.claims,
        counterClaims: ctx.counterClaims,
        knownEvidenceIds: known,
        modelVersion: v2.probabilityBlock !== null ? (v2.probabilityBlock.modelVersion as string) : null,
        event:
          v2.eventAnalysis !== null && ctx.product === 'event'
            ? { analysis: v2.eventAnalysis, decision: v2.decision?.action ?? v2.eventAnalysis.suggestedAction }
            : undefined,
        perp: perpCheck,
        frozenConfigHash: ctx.frozenConfig?.configHash ?? null,
        runtimeConfigHash: runtimeHash,
      })
      if (!result.ok || unlinkedIssues.length > 0) {
        throw new ValidationRejected([
          ...unlinkedIssues,
          ...(result.ok ? [] : result.issues.map((i) => `${i.code}: ${i.detail}`)),
        ])
      }
    },
  }

  const publish: Stage = {
    name: 'publish',
    async run(ctx: RunContext): Promise<void> {
      const v2 = v2of(ctx)
      // P0-5 降级门控：修复耗尽降级发布时剔除 LLM 归纳的反证内容（不可信——未通过校验），
      // 只保留代码计算的结构结论、事实行与规则/证据拼装的反证；结果标注 degraded 与原因
      if (ctx.degradedPublish !== undefined) {
        ctx.counterClaims = ctx.counterClaims.filter((c) => c.origin !== 'llm')
      }
      const evidenceCount = (ctx.retrieval?.supportEvidenceIds.length ?? 0) + (ctx.retrieval?.counterEvidenceIds.length ?? 0)
      // 证据质量（关联链路语义）：带引用的结构声明数优先——complete 需要理论链接的
      // 声明与反例同时存在；知识库为空时回退计数语义并显式说明。
      const linkedClaims = ctx.claims.filter((c) => c.evidenceIds.length > 0).length
      const linkedCounter = ctx.counterClaims.filter((c) => c.evidenceIds.length > 0).length
      const evidenceQuality: 'complete' | 'partial' | 'stale' = v2.knowledgeEmpty
        ? evidenceCount >= 4 ? 'complete' : evidenceCount > 0 ? 'partial' : 'stale'
        : linkedClaims >= 2 && linkedCounter > 0
          ? 'complete'
          : linkedClaims > 0
            ? 'partial'
            : 'stale'
      const d = v2.decision ?? { action: 'insufficient_evidence' as const, side: null, reasons: ['决策缺失（异常）'], conditions: [] }
      const decision = d.action as ResearchResultV2['decision']
      const side = d.side
      const reasons = [...d.reasons]
      // 动作级理论依据注记：把决策相关规则的术语与引用要求附在 reasons
      // （「为什么这条理论支持这条建议」在结果里可直接看到）
      const decisionLink =
        v2.structureView.confirmedSetup !== null
          ? v2.ruleLinks.find((l) => l.key === `setup:${v2.structureView.confirmedSetup!.ruleId}`)
          : null
      if (decisionLink !== null && decisionLink !== undefined && ['hold', 'conditional_entry', 'exit', 'reduce'].includes(decision)) {
        reasons.push(
          `理论依据：${decisionLink.termZh}${decisionLink.applicabilityNote !== null ? `——${decisionLink.applicabilityNote.slice(0, 120)}` : ''}（适用条件/反例原文见引用 ${decisionLink.supportIds.length + decisionLink.counterIds.length} 条）`,
        )
      }
      const conditions = [...d.conditions]
      let unavailableCode: UnavailableCode | null = ctx.qualityIssues.length > 0 ? ((ctx.qualityIssues[0].code as UnavailableCode) ?? null) : null
      if (ctx.product === 'event' && v2.eventAnalysis !== null && v2.eventAnalysis.unavailableCode !== null && unavailableCode === null) {
        unavailableCode = v2.eventAnalysis.unavailableCode as UnavailableCode
      }
      const missingInputs = [...(ctx.plan?.missingFields ?? [])]
      if (v2.positionStale === true && !missingInputs.some((m) => m.includes('持仓已过期'))) {
        missingInputs.push('持仓已过期需重新确认：个性化盈亏/减仓/增量数值已降级为一般结构研究')
      }
      const result: ResearchResultV2 = {
        schemaVersion: 2,
        decision,
        side,
        reasons,
        conditions,
        claims: ctx.claims,
        scenarios:
          ctx.product === 'perp'
            ? [
                { condition: '结构支持持仓方向', response: '按计划持有；加仓需重算风险预算', invalidation: '执行周期方向翻转或已确认反转结构' },
                { condition: '周期冲突', response: '不调整持仓，等待冲突解除', invalidation: '单一周期重新主导' },
              ]
            : ctx.product === 'event'
              ? [{ condition: 'EV>0 且五门槛通过', response: '可按事件风险预算参与', invalidation: '报价过期/剩余期限出界/EV 转负' }]
              : [],
        evidenceQuality,
        probability: (v2.probabilityBlock as ResearchResultV2['probability']) ?? null,
        unavailableCode,
        missingInputs,
        ...(ctx.degradedPublish !== undefined
          ? { degraded: true as const, degradedReasons: ctx.degradedPublish.reasons.slice(0, 10) }
          : {}),
        payload: v2.v2Payload as ResearchResultV2['payload'],
      }
      // 结果契约运行时校验（八轮修复 B3）：装配后必须通过 ResearchResultV2Schema，
      // 结构非法的结果不得发布（抛 ValidationRejected → 运行失败，不落库）
      const parsed = ResearchResultV2Schema.safeParse(result)
      if (!parsed.success) {
        throw new ValidationRejected(parsed.error.issues.map((i) => `contract: ${i.path.join('.') || '(root)'}: ${i.message}`))
      }
      ctx.result = parsed.data as unknown as RunContext['result']
    },
  }

  return [plan, snapshot, structures, retrieve, productAnalysis, countercase, validate, publish]
}
