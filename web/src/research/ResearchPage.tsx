/**
 * /research 研究工作台（docs/specs/ui.md 对话优先布局）：
 * 顶部：场景（现货/USDT 永续/事件合约）· 交易对 · 期限 · 行情状态与 asOf；
 * 左：持仓 / 报价 / 历史研究；中：Brooks 结构 K 线（klinecharts）+ 多周期结论条 + 快照行；
 * 右：研究对话为主操作面——消息流内嵌 SSE 运行气泡（步骤/取消）、结果卡与持仓确认卡；
 * 「发起研究 / 录入」高级表单收进弹层（默认收起，不抢占布局）。
 * 移动端折叠为 图表 / 对话 / 证据 三标签。数据全部来自真实接口，异常状态显式呈现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { analyzeBrooks } from 'biance-vision-brooks'
import type { BrooksDisplay, EventQuote, FollowUpAction, Position, ResearchRun } from 'biance-vision-brooks'
import { useMarket } from '../market/MarketContext'
import BrooksChart from '../brooks/BrooksChart'
import type { BrooksChartLevel } from '../brooks/BrooksChart'
import { PositionForm, QuoteForm } from './ResearchForms'
import { EvidenceDrawer } from './ResearchResult'
import { useResearchRun, sseConnLabel } from './useResearchRun'
import { useResearchConversation } from './useResearchConversation'
import { useResearchCandles } from './useResearchCandles'
import { currentLocale } from '../i18n'
import { PositionConfirmCard } from './PositionConfirmCard'
import { RunBubble } from './RunBubble'
import MiniMarkdown from '../components/MiniMarkdown'
import CitationBadges from './CitationBadges'
import { MessageTranslate } from './MessageTranslate'
import { UiModeSwitch } from './UiModeSwitch'
import { Dropdown } from './Dropdown'
import { Combobox } from './Combobox'

type Product = 'perp' | 'event' | 'teaching'
type MarketType = 'spot' | 'usdm_perp'
type Scenario = 'spot' | 'perp' | 'event'
type Horizon = '10m' | '30m' | '1h' | '1d' | '1w'

/**
 * 顶栏「场景」单一下拉（现货 / USDT 永续 / 事件合约，对齐 spec 决策行）：
 * 现货 = 纯结构研究（teaching 产品 + spot 行情，无持仓/费用/强平）；
 * 永续/事件固定取 USDT 永续市场行情（事件合约结算参考永续标记价）。
 */
const SCENARIO_PRODUCT: Record<Scenario, Product> = { spot: 'teaching', perp: 'perp', event: 'event' }
const SCENARIO_MARKET: Record<Scenario, MarketType> = { spot: 'spot', perp: 'usdm_perp', event: 'usdm_perp' }

const HORIZON_TF: Record<Horizon, string> = { '10m': '1m', '30m': '5m', '1h': '15m', '1d': '1h', '1w': '4h' }

/** 图表周期毫秒数（新鲜度判定：最后一根收盘距今超过 周期+一个周期宽限 视为陈旧） */
const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 }

/** 顶栏交易对 datalist 的静态兜底（/api/market/symbols 不可用时） */
const FALLBACK_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT']

/** 研究台中栏固定全量标注（无 Brooks 复盘页的显示开关） */
const RESEARCH_DISPLAY: BrooksDisplay = { swings: true, legs: true, io: true, signals: true, ema: true, regime: true }

interface Evaluation {
  quoteId: string
  breakevenWinRate: number
  expectedNet: string | null
  winAmount: string
  loseAmount: string
  countdownMs: number
  horizonMatched: boolean
  unavailableReason: string | null
}

export default function ResearchPage(): JSX.Element {
  const { t } = useTranslation()
  const [scenario, setScenario] = useState<Scenario>('perp')
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [horizon, setHorizon] = useState<Horizon>('1h')
  const [question, setQuestion] = useState('')
  const [tab, setTab] = useState<'chart' | 'run' | 'evidence'>('chart')
  /** 「发起研究 / 录入」弹层（默认收起，对话为主操作面） */
  const [toolsOpen, setToolsOpen] = useState(false)

  const [positions, setPositions] = useState<Position[]>([])
  const [quotes, setQuotes] = useState<EventQuote[]>([])
  const [evaluations, setEvaluations] = useState<Record<string, Evaluation>>({})
  const [runs, setRuns] = useState<ResearchRun[]>([])
  const [selectedPosition, setSelectedPosition] = useState<string>('')
  const [selectedQuote, setSelectedQuote] = useState<string>('')

  /** 左栏数据拉取失败（DB 不可用等）：显式横幅，不静默吞错 */
  const [leftError, setLeftError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** 顶栏交易对候选（/api/market/symbols；失败回退静态常用列表） */
  const [symbolList, setSymbolList] = useState<string[]>(FALLBACK_SYMBOLS)
  /** 报价行「确认结算」展开态与提交态 */
  const [confirmingQuote, setConfirmingQuote] = useState<string | null>(null)
  const [quoteConfirmBusy, setQuoteConfirmBusy] = useState(false)
  const [quoteConfirmError, setQuoteConfirmError] = useState('')
  /** 30s 时钟（顶栏行情新鲜度随时间推进重估） */
  const [nowTick, setNowTick] = useState(() => Date.now())
  /** 证据联动：结构事件定位高亮的 bar（openTime） */
  const [highlightTime, setHighlightTime] = useState<number | null>(null)
  /** 查看历史 run 时按其 asOf 冻结图表（结果与图同一时刻；清除后回到实时） */
  const [chartAsOf, setChartAsOf] = useState<number | null>(null)

  const { upColor } = useMarket()
  const chartInterval = HORIZON_TF[horizon]
  const product = SCENARIO_PRODUCT[scenario]
  const marketType = SCENARIO_MARKET[scenario]

  const refreshLeft = useCallback(async (): Promise<void> => {
    try {
      const [p, q, r] = await Promise.all([
        api<{ positions: Position[] }>('/portfolio'),
        api<{ quotes: EventQuote[]; evaluations: Evaluation[] }>('/event-quotes'),
        api<{ runs: ResearchRun[] }>('/research/runs'),
      ])
      setPositions(p.positions)
      setQuotes(q.quotes)
      setEvaluations(Object.fromEntries(q.evaluations.map((e) => [e.quoteId, e])))
      setRuns(r.runs)
      setLeftError('')
    } catch (e) {
      // 数据服务不可用（DB 中断等）：显式只读横幅，保留旧数据不静默吞错
      setLeftError(t('research:main.leftDataError', { msg: (e as Error).message }))
    }
  }, [t])

  const tracker = useResearchRun({
    onPublished: () => void refreshLeft(),
    onOpen: (run) => {
      setDrawerOpen(false)
      setHighlightTime(null)
      // 历史结果与图表对齐同一 asOf（不重查当前行情污染复盘视角）
      setChartAsOf(run.asOf)
    },
  })

  /** 聊天/历史带回 runId → 拉列表定位后交给 tracker（同一 run 重开由 tracker 内部续游标） */
  const openRunById = async (runId: string): Promise<void> => {
    setTab('run')
    if (tracker.activeRun?.id === runId) return
    try {
      const d = await api<{ run: ResearchRun }>(`/research/runs/${encodeURIComponent(runId)}`)
      setSymbol(d.run.symbol)
      setHorizon(d.run.horizon)
      setScenario(d.run.product === 'event' ? 'event' : d.run.product === 'teaching' ? 'spot' : 'perp')
      tracker.openRun(d.run)
    } catch (e) {
      setLeftError(t('research:main.researchLoadFailed', { msg: (e as Error).message }))
    }
  }

  const conv = useResearchConversation({
    context: { symbol, marketType, horizon, product, positionId: selectedPosition, quoteId: selectedQuote },
    onRunCreated: (runId) => void openRunById(runId),
    onPositionsChanged: () => void refreshLeft(),
  })

  const { candles, bars, loading: chartLoading, error: chartError, source: chartSource, fallbackReason: chartFallback } = useResearchCandles(
    symbol,
    marketType,
    chartInterval,
    chartAsOf ?? undefined,
    // 图表处于 run 冻结视图且交易对一致时读该 run 的快照输入包（评审 F3）
    chartAsOf !== null && tracker.activeRun?.symbol === symbol ? tracker.activeRun.id : null,
  )

  // 悬浮 AI 助手「在研究工作台打开」带 ?run= 进来：挂载或已停留在本页时参数变化都打开对应 run
  // （助手是全局浮层，跳转是同路由参数变化、组件不重挂载，不能只在 mount 时消费一次）
  const [searchParams] = useSearchParams()
  const bootRunRef = useRef<string | null>(null)
  const bootConvRef = useRef<string | null>(null)
  useEffect(() => {
    const id = searchParams.get('conversation')
    if (!id || bootConvRef.current === id) return
    bootConvRef.current = id
    void (async () => {
      if (!await conv.loadConversation(id)) return
      const list = await conv.refreshConversations()
      const ctx = list.find(c => c.id === id)?.context
      if (!ctx) return
      // A run deep link owns the frozen chart settings; the conversation still restores its messages.
      if (!searchParams.get('run')) {
        setScenario(ctx.product === 'event' ? 'event' : ctx.product === 'teaching' ? 'spot' : 'perp')
        if (ctx.symbol) setSymbol(ctx.symbol)
        if (ctx.horizon && ctx.horizon in HORIZON_TF) setHorizon(ctx.horizon as Horizon)
      }
      setSelectedPosition(ctx.product === 'perp' ? ctx.positionId ?? '' : '')
      setSelectedQuote(ctx.product === 'event' ? ctx.quoteId ?? '' : '')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])
  useEffect(() => {
    const runId = searchParams.get('run')
    if (runId === null || runId === '' || bootRunRef.current === runId) return
    bootRunRef.current = runId
    void openRunById(runId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  useEffect(() => {
    void refreshLeft()
  }, [refreshLeft])

  // 倒计时刷新（30s 一次重拉报价评估）
  useEffect(() => {
    const t = setInterval(() => void refreshLeft(), 30_000)
    return () => clearInterval(t)
  }, [refreshLeft])

  // 顶栏新鲜度时钟（30s）
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // 顶栏交易对候选：库内已采集 ∪ provider 可交易；失败回退静态常用列表
  useEffect(() => {
    let alive = true
    api<{ symbols: string[] }>(`/market/symbols?marketType=${marketType}`)
      .then((r) => {
        if (alive && r.symbols.length > 0) setSymbolList(r.symbols)
      })
      .catch(() => {
        if (alive) setSymbolList(FALLBACK_SYMBOLS)
      })
    return () => {
      alive = false
    }
  }, [marketType])

  // 标的/周期切换后旧高亮失效，避免在新序列上错位
  useEffect(() => setHighlightTime(null), [symbol, marketType, chartInterval])

  const createRun = async (): Promise<void> => {
    try {
      const r = await api<{ run: ResearchRun }>('/research/runs', {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(), // P1-5：网络重试不双建 run/双扣额度
        body: {
          product,
          symbol,
          marketType,
          horizon,
          question: question === '' ? undefined : question,
          positionId: product === 'perp' && selectedPosition !== '' ? selectedPosition : undefined,
          quoteId: product === 'event' && selectedQuote !== '' ? selectedQuote : undefined,
        },
      })
      tracker.openRun(r.run)
      setTab('run')
      setToolsOpen(false)
      void refreshLeft()
    } catch (e) {
      tracker.setSseError((e as Error).message)
      setTab('run')
    }
  }

  /** run 失败重试 / 追问重跑（2026-10-20 评审 #3 同口径）：优先从 run.input（创建请求
   * 快照）恢复 question/positionId/quoteId/positionOverride/asOf——持仓复查仍是持仓
   * 复查、报价评估仍带报价、历史复盘不变成当前研究；无 input 的旧 run 退回当前关联。
   * interval:'same'（事件到期临近重估）保持原周期并按当前时刻重估。 */
  const rerunFrom = async (opts: { horizon?: Horizon; asOfNow?: boolean } = {}): Promise<void> => {
    const activeRun = tracker.activeRun
    if (activeRun === null) return
    const src = (activeRun.input ?? {}) as Partial<NonNullable<ResearchRun['input']>>
    try {
      const r = await api<{ run: ResearchRun }>('/research/runs', {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(), // P1-5：网络重试不双建 run/双扣额度
        body: {
          product: activeRun.product,
          symbol: activeRun.symbol,
          marketType: activeRun.marketType,
          horizon: opts.horizon ?? activeRun.horizon,
          question: typeof src.question === 'string' ? src.question : question === '' ? undefined : question,
          positionId: typeof src.positionId === 'string' ? src.positionId : activeRun.product === 'perp' && selectedPosition !== '' ? selectedPosition : undefined,
          quoteId: typeof src.quoteId === 'string' ? src.quoteId : activeRun.product === 'event' && selectedQuote !== '' ? selectedQuote : undefined,
          positionOverride: src.positionOverride,
          asOf: opts.asOfNow === true ? undefined : (typeof src.asOf === 'number' ? src.asOf : activeRun.asOf),
          sceneCode: activeRun.sceneCode,
        },
      })
      tracker.setSseError('')
      tracker.openRun(r.run)
      setTab('run')
      void refreshLeft()
    } catch (e) {
      tracker.setSseError((e as Error).message)
    }
  }

  const retryRun = async (): Promise<void> => { await rerunFrom() }

  /** P1-3 结构化追问分发（2026-10-20 评审 #7：旧版研究台入口接通，与工作台同语义） */
  const onFollowUp = (a: FollowUpAction): void => {
    if (a.action === 'open_evidence' || a.action === 'open_rule_card') { setDrawerOpen(true); setTab('evidence'); return }
    if (a.action === 'switch_context') { setToolsOpen(true); setTab('run'); return }
    if (a.action === 'rerun_with') {
      const interval = (a.parameters?.interval as string | undefined) ?? 'next'
      if (interval === 'same') { void rerunFrom({ asOfNow: true }); return }
      const order: Horizon[] = ['10m', '30m', '1h', '1d', '1w']
      void rerunFrom({ horizon: order[(order.indexOf(tracker.activeRun?.horizon ?? '1h') + 1) % order.length] })
      return
    }
    if (a.action === 'counter_search') {
      void conv.send(t('research:main.counterFollowUp', { symbol: tracker.activeRun?.symbol ?? symbol, horizon: tracker.activeRun?.horizon ?? horizon }))
      return
    }
  }

  /** 报价级结算确认（W6）：写 userConfirmedOutcome 并同步该报价下未确认预测 */
  const confirmQuoteOutcome = async (quoteId: string, outcome: 'above' | 'below' | 'tie'): Promise<void> => {
    setQuoteConfirmBusy(true)
    setQuoteConfirmError('')
    try {
      await api(`/event-quotes/${quoteId}/confirm`, { method: 'POST', body: { outcome } })
      setConfirmingQuote(null)
      void refreshLeft()
    } catch (e) {
      setQuoteConfirmError((e as Error).message)
    } finally {
      setQuoteConfirmBusy(false)
    }
  }

  const evalOf = (id: string): Evaluation | undefined => evaluations[id]
  const activeRun = tracker.activeRun
  const result = tracker.result

  /** 中栏叠加层：复用共享引擎分析已收盘 K 线（与 Brooks 复盘页同一份代码） */
  const chartAnalysis = useMemo(
    () => analyzeBrooks(bars, { swingK: 3, locale: currentLocale() === 'en-US' ? 'en-US' : 'zh-CN' }),
    [bars],
  )

  /**
   * W3 多周期结论条：结果契约（ResearchResultV2）不直接携带 structureView，
   * 结构阶段的执行/背景周期结论与周期冲突以 fact 论断写入 claims（服务端同源文本，前端不重新计算）
   */
  const structureFacts = useMemo(() => {
    if (result === null) return []
    return result.claims
      .filter((c) => c.kind === 'fact')
      .map((c) => c.text)
      .filter((t) => t.includes('：状态 ') || t.startsWith('周期冲突'))
  }, [result])

  /**
   * W3 关键价位：仅取 payload 契约字段（perp 止损/强平、event 执行价），无可靠来源则不渲染；
   * 仅在图表标的与当前 run 一致时叠加，避免切交易对后错位
   */
  const chartLevels = useMemo<BrooksChartLevel[]>(() => {
    if (result === null || activeRun === null || activeRun.symbol !== symbol) return []
    const pp = (result as unknown as { payload?: Record<string, unknown> }).payload ?? {}
    const levels: BrooksChartLevel[] = []
    if (pp.kind === 'perp') {
      const pos = pp.position as { stopPrice?: string | null } | null | undefined
      const stop = pos?.stopPrice !== null && pos?.stopPrice !== undefined ? Number(pos.stopPrice) : NaN
      if (Number.isFinite(stop)) levels.push({ price: stop, label: t('research:chart.stop') })
      const liq = (pp.liquidation as { price?: number | null } | undefined)?.price
      if (typeof liq === 'number' && Number.isFinite(liq)) levels.push({ price: liq, label: t('research:chart.liq') })
    } else if (pp.kind === 'event') {
      const quote = pp.quote as { strikePrice?: string } | null | undefined
      const strike = quote?.strikePrice !== undefined ? Number(quote.strikePrice) : NaN
      if (Number.isFinite(strike)) levels.push({ price: strike, label: t('research:chart.strike') })
    }
    return levels
  }, [result, activeRun, symbol, t])

  /** W4 顶栏行情时间与新鲜度：最后一根已收盘 closeTime；超过 周期长度+一个周期宽限 视为陈旧 */
  const dataFreshness = useMemo(() => {
    const last = candles.length > 0 ? candles[candles.length - 1] : null
    if (last === null) return null
    const intervalMs = INTERVAL_MS[chartInterval] ?? 60_000
    const ageMs = nowTick - last.closeTime
    return { closeTime: last.closeTime, stale: ageMs > intervalMs * 2 }
  }, [candles, chartInterval, nowTick])

  return (
    <div className="research-page">
      <div className="research-topbar">
        <UiModeSwitch disabled={conv.busy || conv.cardBusy !== null} conversationId={conv.convId ?? searchParams.get('conversation')} runId={tracker.activeRun?.id ?? searchParams.get('run')} />
        <Dropdown
          value={scenario}
          onChange={(v) => { setScenario(v); setChartAsOf(null) }}
          ariaLabel={t('research:main.sceneAria')}
          options={[
            { value: 'spot', label: t('research:main.sceneSpot') },
            { value: 'perp', label: t('research:main.scenePerp') },
            { value: 'event', label: t('research:main.sceneEvent') },
          ]}
        />
        <Combobox
          inputClassName="symbol-input"
          value={symbol}
          onChange={(v) => { setSymbol(v.toUpperCase()); setChartAsOf(null) }}
          ariaLabel={t('research:main.symbolAria')}
          suggestions={symbolList}
        />
        <Dropdown
          value={horizon}
          onChange={(v) => { setHorizon(v); setChartAsOf(null) }}
          ariaLabel={t('research:main.horizonAria')}
          options={[
            { value: '10m', label: t('research:main.h10m') },
            { value: '30m', label: t('research:main.h30m') },
            { value: '1h', label: t('research:main.h1h') },
            { value: '1d', label: t('research:main.h1d') },
            { value: '1w', label: t('research:main.h1w') },
          ]}
        />
        <span className="muted">
          {dataFreshness !== null ? (
            <>
              {t('research:main.dataUntil', { time: new Date(dataFreshness.closeTime).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' }) })}
              {dataFreshness.stale && <em className="stale-tag-inline">{t('research:main.dataStale')}</em>}
            </>
          ) : (
            t('research:main.dataSource')
          )}
        </span>
        <span className={`conn-badge conn-${tracker.sseConn}`} role="status" aria-label={t('research:main.sseAria', { label: sseConnLabel(tracker.sseConn) })}>
          {t('research:main.sseLabel', { label: sseConnLabel(tracker.sseConn) })}
        </span>
      </div>

      {leftError !== '' && (
        <div className="left-error-banner" role="alert">
          {leftError}{t('research:main.leftErrorNote')}
        </div>
      )}

      <div className="research-mobile-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chart'} className={tab === 'chart' ? 'on' : ''} onClick={() => setTab('chart')}>{t('research:main.tabChart')}</button>
        <button role="tab" aria-selected={tab === 'run'} className={tab === 'run' ? 'on' : ''} onClick={() => setTab('run')}>{t('research:main.tabChat')}</button>
        <button role="tab" aria-selected={tab === 'evidence'} className={tab === 'evidence' ? 'on' : ''} onClick={() => { setDrawerOpen(true); setTab('evidence') }}>{t('research:main.tabEvidence')}</button>
      </div>

      <div className={`research-grid t-${tab}`}>
        <aside className="research-left">
          <div className="panel">
            <h4>{t('research:main.positionsTitle')}</h4>
            {positions.length === 0 && <p className="muted">{t('research:main.notEntered')}</p>}
            <ul className="left-list">
              {positions.map((p) => (
                <li key={p.id} className={selectedPosition === p.id ? 'sel' : ''}>
                  <button onClick={() => setSelectedPosition(p.id)}>
                    <strong>{p.symbol}</strong> {t(p.side === 'long' ? 'research:ctx.long' : 'research:ctx.short')} ×{p.qty} @ {p.entryPrice}
                    {p.isStale && <em className="stale-tag">{t('research:main.staleNeedReconfirm')}</em>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="panel">
            <h4>{t('research:main.quotesTitle')}</h4>
            {quotes.length === 0 && <p className="muted">{t('research:main.notEntered')}</p>}
            {quoteConfirmError !== '' && <p className="err-text">{quoteConfirmError}</p>}
            <ul className="left-list">
              {quotes.map((q) => {
                const ev = evalOf(q.id)
                const mins = Math.floor((q.remainingMs ?? 0) / 60000)
                return (
                  <li key={q.id} className={selectedQuote === q.id ? 'sel' : ''}>
                    <button onClick={() => setSelectedQuote(q.id)}>
                      <strong>{q.symbol}</strong> {t(q.direction === 'above' ? 'research:main.above' : 'research:main.below')} {q.strikePrice}
                      <span className="muted">{t('research:main.remainMins', { mins })}</span>
                      {ev && <span className={ev.horizonMatched ? 'match-ok' : 'match-no'}>{ev.horizonMatched ? t('research:main.horizonMatched') : t('research:main.horizonUnmatched')}</span>}
                      {q.userConfirmedOutcome !== null && q.userConfirmedOutcome !== undefined && <em>{t('research:main.confirmed', { value: q.userConfirmedOutcome })}</em>}
                      {q.estimatedOutcome !== null && q.estimatedOutcome !== undefined && <em>{t('research:main.estimated', { value: q.estimatedOutcome })}</em>}
                    </button>
                    {(q.userConfirmedOutcome === null || q.userConfirmedOutcome === undefined) &&
                      (confirmingQuote === q.id ? (
                        <span className="quote-confirm-row" role="group" aria-label={t('research:main.confirmGroupAria', { symbol: q.symbol })}>
                          {(['above', 'below', 'tie'] as const).map((o) => (
                            <button
                              key={o}
                              disabled={quoteConfirmBusy}
                              aria-label={t('research:main.confirmAsAria', { label: t(o === 'above' ? 'research:main.above' : o === 'below' ? 'research:main.below' : 'research:main.tie') })}
                              onClick={() => void confirmQuoteOutcome(q.id, o)}
                            >
                              {t(o === 'above' ? 'research:main.above' : o === 'below' ? 'research:main.below' : 'research:main.tie')}
                            </button>
                          ))}
                          <button disabled={quoteConfirmBusy} aria-label={t('research:main.cancelConfirmAria')} onClick={() => setConfirmingQuote(null)}>{t('research:run.cancel')}</button>
                        </span>
                      ) : (
                        <button
                          className="quote-confirm-toggle"
                          aria-label={t('research:main.confirmSettlementAria', { symbol: q.symbol })}
                          onClick={() => {
                            setQuoteConfirmError('')
                            setConfirmingQuote(q.id)
                          }}
                        >
                          {t('research:main.confirmSettlement')}
                        </button>
                      ))}
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="panel">
            <h4>{t('research:main.historyTitle')}</h4>
            {runs.length === 0 && <p className="muted">{t('research:main.none')}</p>}
            <ul className="left-list">
              {runs.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <button onClick={() => tracker.openRun(r)}>
                    <span className={`run-status st-${r.status}`}>{r.status}</span> {r.product} · {r.symbol} · {r.horizon}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="research-center" id="research-chart">
          {structureFacts.length > 0 && (
            <div className="mtf-bar" role="status" aria-label={t('research:main.mtfAria')}>
              <strong>{t('research:main.mtfTitle')}</strong>
              {structureFacts.map((fact) => (
                <span key={fact} className={fact.startsWith('周期冲突') ? 'mtf-conflict' : undefined}>{fact}</span>
              ))}
            </div>
          )}
          <div className="research-chart">
            <div className="research-chart-head">
              <strong>{symbol}</strong>
              <span>{chartInterval} · {marketType === 'usdm_perp' ? t('research:main.marketPerp') : t('research:main.marketSpot')} · {t('research:main.closedOnly')}</span>
              {chartLoading && <span className="muted">{t('research:main.loading')}</span>}
              <span className="muted">{t('research:main.barsCount', { count: bars.length })}{chartAsOf !== null ? t('research:main.asOfFrozen') : ''}</span>
            </div>
            <div className="research-chart-body">
              <BrooksChart
                bars={bars}
                analysis={chartAnalysis}
                display={RESEARCH_DISPLAY}
                upColor={upColor}
                highlightTime={highlightTime}
                levels={chartLevels}
              />
              {chartLoading && <div className="chart-mask">{t('research:main.loadKline', { symbol })}</div>}
              {chartError !== '' && (
                <div className="chart-mask error">
                  <span>{chartError}</span>
                </div>
              )}
            </div>
          </div>
          {activeRun?.snapshotId && (
            <p className="muted snapshot-line">
              {t('research:main.snapshotLine', { id: activeRun.snapshotId.slice(0, 8), rule: activeRun.ruleVersion ?? '-', config: activeRun.configVersion ?? '-', knowledge: activeRun.knowledgeVersion ? activeRun.knowledgeVersion.slice(0, 8) : t('research:main.noKnowledgeVersion') })}
              {chartAsOf !== null && (
                <>
                  {t('research:main.chartFrozenAt', { time: new Date(chartAsOf).toLocaleString() })}
                  {chartSource === 'snapshot' ? t('research:main.chartFromSnapshot') : ''}
                  <button className="btn btn-sm" onClick={() => setChartAsOf(null)}>{t('research:main.backToLive')}</button>
                </>
              )}
            </p>
          )}
          {chartAsOf !== null && chartFallback !== null && (
            <p className="snapshot-line warn-line" role="alert">
              {t('research:main.snapshotFallback', { reason: chartFallback })}
            </p>
          )}
        </section>

        <section className="research-right" id="research-run">
          <div className="panel chat-panel">
            <div className="chat-head-row">
              <h4>{t('research:main.chatTitle')}</h4>
              <button className="btn btn-ghost btn-sm" onClick={() => setToolsOpen(true)}>
                {t('research:main.toolsButton')}
              </button>
            </div>
            <div className="chat-messages" role="log" aria-live="polite">
              {conv.messages.map((m, i) => (
                <div key={i} className={`chat-msg ${m.role}`}>
                  {m.role === 'user' ? m.text : <MiniMarkdown text={m.text} />}
                  {m.text !== '' && <MessageTranslate text={m.text} />}
                  {m.citations !== undefined && <CitationBadges citations={m.citations} />}
                  {m.card !== undefined && (
                    <PositionConfirmCard card={m.card} busy={conv.cardBusy === i} onResolve={(confirm) => void conv.resolveCard(i, confirm)} />
                  )}
                  {m.runId !== undefined && (
                    <button className="chat-runlink" onClick={() => void openRunById(m.runId as string)}>
                      {t('research:main.viewRun', { id: (m.runId as string).slice(0, 8) })}
                    </button>
                  )}
                </div>
              ))}
              {conv.busy && <div className="chat-msg assistant muted">{t('research:main.analyzing')}</div>}
              {activeRun && (
                <RunBubble
                  run={activeRun}
                  steps={tracker.steps}
                  result={result}
                  sseError={tracker.sseError}
                  sseConn={tracker.sseConn}
                  degraded={tracker.degraded}
                  details={tracker.details}
                  securityInterrupt={tracker.securityInterrupt}
                  onCancel={() => void tracker.cancelRun()}
                  onRetry={() => void retryRun()}
                  onFollowUp={onFollowUp}
                  footer={
                    result !== null ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => setDrawerOpen(true)}>
                        {t('research:main.viewEvidence')}
                      </button>
                    ) : undefined
                  }
                />
              )}
            </div>
            <div className="chat-input-row">
              <input
                value={conv.input}
                onChange={(e) => conv.setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void conv.send()
                }}
                placeholder={t('research:main.inputPlaceholder')}
                aria-label={t('research:main.inputAria')}
              />
              <button className="btn btn-primary" disabled={conv.busy || conv.input.trim() === ''} onClick={() => void conv.send()}>
                {t('research:main.send')}
              </button>
            </div>
          </div>
        </section>
      </div>

      {toolsOpen && (
        <div className="modal-overlay" onClick={() => setToolsOpen(false)}>
          <div className="modal research-tools-modal" role="dialog" aria-label={t('research:main.toolsModalAria')} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{t('research:main.toolsTitle')}</h3>
              <button className="modal-close" aria-label={t('common:toast.close')} onClick={() => setToolsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="run-launcher">
                <h4>{t('research:main.startResearchTitle')}</h4>
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={product === 'event' ? t('research:main.questionPlaceholderEvent') : t('research:main.questionPlaceholderDefault')}
                  rows={2}
                />
                {product === 'perp' && (
                  <p className="muted">{selectedPosition === '' ? t('research:main.noPositionSelected') : t('research:main.positionLinked', { id: selectedPosition.slice(0, 8) })}</p>
                )}
                {product === 'event' && (
                  <p className="muted">{selectedQuote === '' ? t('research:main.noQuoteSelected') : t('research:main.quoteLinked', { id: selectedQuote.slice(0, 8) })}</p>
                )}
                <button className="btn btn-primary" onClick={() => void createRun()}>{t('research:main.startResearch')}</button>
              </div>
              {product === 'perp' && <PositionForm symbol={symbol} onSaved={() => void refreshLeft()} />}
              {product === 'event' && <QuoteForm symbol={symbol} onSaved={() => void refreshLeft()} />}
            </div>
          </div>
        </div>
      )}

      {activeRun && (
        <div className={`evidence-pane ${tab === 'evidence' ? 'show-mobile' : ''}`}>
          <EvidenceDrawer
            runId={activeRun.id}
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            onLocateBar={(t) => {
              setHighlightTime(t)
              setTab('chart')
            }}
          />
        </div>
      )}
    </div>
  )
}
