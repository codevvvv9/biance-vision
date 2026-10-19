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
import { api } from '../api'
import { analyzeBrooks } from 'biance-vision-brooks'
import type { BrooksDisplay, EventQuote, Position, ResearchRun } from 'biance-vision-brooks'
import { useMarket } from '../market/MarketContext'
import BrooksChart from '../brooks/BrooksChart'
import type { BrooksChartLevel } from '../brooks/BrooksChart'
import { PositionForm, QuoteForm } from './ResearchForms'
import { EvidenceDrawer } from './ResearchResult'
import { useResearchRun, SSE_CONN_LABEL } from './useResearchRun'
import { useResearchConversation } from './useResearchConversation'
import { useResearchCandles } from './useResearchCandles'
import { PositionConfirmCard } from './PositionConfirmCard'
import { RunBubble } from './RunBubble'
import MiniMarkdown from '../components/MiniMarkdown'
import { UiModeSwitch } from './UiModeSwitch'
import { Dropdown } from './Dropdown'

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
      setLeftError(`数据服务不可用（只读）：${(e as Error).message}`)
    }
  }, [])

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
      setLeftError(`研究加载失败：${(e as Error).message}`)
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

  /** run 失败重试：以该 run 的 product/symbol/marketType/horizon + 当前关联（持仓/报价/问题）重新创建 */
  const retryRun = async (): Promise<void> => {
    const activeRun = tracker.activeRun
    if (activeRun === null) return
    try {
      const r = await api<{ run: ResearchRun }>('/research/runs', {
        method: 'POST',
        body: {
          product: activeRun.product,
          symbol: activeRun.symbol,
          marketType: activeRun.marketType,
          horizon: activeRun.horizon,
          question: question === '' ? undefined : question,
          positionId: activeRun.product === 'perp' && selectedPosition !== '' ? selectedPosition : undefined,
          quoteId: activeRun.product === 'event' && selectedQuote !== '' ? selectedQuote : undefined,
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
  const chartAnalysis = useMemo(() => analyzeBrooks(bars), [bars])

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
      if (Number.isFinite(stop)) levels.push({ price: stop, label: '止损' })
      const liq = (pp.liquidation as { price?: number | null } | undefined)?.price
      if (typeof liq === 'number' && Number.isFinite(liq)) levels.push({ price: liq, label: '强平' })
    } else if (pp.kind === 'event') {
      const quote = pp.quote as { strikePrice?: string } | null | undefined
      const strike = quote?.strikePrice !== undefined ? Number(quote.strikePrice) : NaN
      if (Number.isFinite(strike)) levels.push({ price: strike, label: '执行价' })
    }
    return levels
  }, [result, activeRun, symbol])

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
          ariaLabel="研究场景"
          options={[
            { value: 'spot', label: '现货' },
            { value: 'perp', label: 'USDT 永续' },
            { value: 'event', label: '事件合约' },
          ]}
        />
        <input
          className="symbol-input"
          value={symbol}
          onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setChartAsOf(null) }}
          aria-label="交易对"
          list="research-symbol-list"
          spellCheck={false}
        />
        <datalist id="research-symbol-list">
          {symbolList.slice(0, 60).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Dropdown
          value={horizon}
          onChange={(v) => { setHorizon(v); setChartAsOf(null) }}
          ariaLabel="研究期限"
          options={[
            { value: '10m', label: '10 分钟' },
            { value: '30m', label: '30 分钟' },
            { value: '1h', label: '1 小时' },
            { value: '1d', label: '1 天' },
            { value: '1w', label: '1 周（研究模式）' },
          ]}
        />
        <span className="muted">
          {dataFreshness !== null ? (
            <>
              数据至 {new Date(dataFreshness.closeTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              {dataFreshness.stale && <em className="stale-tag-inline">数据陈旧</em>}
            </>
          ) : (
            '数据源：库内已收盘 K 线（asOf 冻结）'
          )}
        </span>
        <span className={`conn-badge conn-${tracker.sseConn}`} role="status" aria-label={`SSE 连接状态：${SSE_CONN_LABEL[tracker.sseConn]}`}>
          SSE：{SSE_CONN_LABEL[tracker.sseConn]}
        </span>
      </div>

      {leftError !== '' && (
        <div className="left-error-banner" role="alert">
          {leftError}（持仓/报价/历史为上次成功拉取的快照，新增研究可能失败）
        </div>
      )}

      <div className="research-mobile-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chart'} className={tab === 'chart' ? 'on' : ''} onClick={() => setTab('chart')}>图表</button>
        <button role="tab" aria-selected={tab === 'run'} className={tab === 'run' ? 'on' : ''} onClick={() => setTab('run')}>对话</button>
        <button role="tab" aria-selected={tab === 'evidence'} className={tab === 'evidence' ? 'on' : ''} onClick={() => { setDrawerOpen(true); setTab('evidence') }}>证据</button>
      </div>

      <div className={`research-grid t-${tab}`}>
        <aside className="research-left">
          <div className="panel">
            <h4>持仓（手动确认）</h4>
            {positions.length === 0 && <p className="muted">尚未录入</p>}
            <ul className="left-list">
              {positions.map((p) => (
                <li key={p.id} className={selectedPosition === p.id ? 'sel' : ''}>
                  <button onClick={() => setSelectedPosition(p.id)}>
                    <strong>{p.symbol}</strong> {p.side === 'long' ? '多' : '空'} ×{p.qty} @ {p.entryPrice}
                    {p.isStale && <em className="stale-tag">已过期需重确认</em>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="panel">
            <h4>事件报价</h4>
            {quotes.length === 0 && <p className="muted">尚未录入</p>}
            {quoteConfirmError !== '' && <p className="err-text">{quoteConfirmError}</p>}
            <ul className="left-list">
              {quotes.map((q) => {
                const ev = evalOf(q.id)
                const mins = Math.floor((q.remainingMs ?? 0) / 60000)
                return (
                  <li key={q.id} className={selectedQuote === q.id ? 'sel' : ''}>
                    <button onClick={() => setSelectedQuote(q.id)}>
                      <strong>{q.symbol}</strong> {q.direction === 'above' ? '高于' : '低于'} {q.strikePrice}
                      <span className="muted"> · 剩 {mins} 分</span>
                      {ev && <span className={ev.horizonMatched ? 'match-ok' : 'match-no'}>{ev.horizonMatched ? '期限匹配' : '期限未匹配'}</span>}
                      {q.userConfirmedOutcome !== null && q.userConfirmedOutcome !== undefined && <em>已确认 {q.userConfirmedOutcome}</em>}
                      {q.estimatedOutcome !== null && q.estimatedOutcome !== undefined && <em>估算 {q.estimatedOutcome}</em>}
                    </button>
                    {(q.userConfirmedOutcome === null || q.userConfirmedOutcome === undefined) &&
                      (confirmingQuote === q.id ? (
                        <span className="quote-confirm-row" role="group" aria-label={`确认 ${q.symbol} 报价结算结果`}>
                          {(['above', 'below', 'tie'] as const).map((o) => (
                            <button
                              key={o}
                              disabled={quoteConfirmBusy}
                              aria-label={`确认结算为${o === 'above' ? '高于' : o === 'below' ? '低于' : '平价'}`}
                              onClick={() => void confirmQuoteOutcome(q.id, o)}
                            >
                              {o === 'above' ? '高于' : o === 'below' ? '低于' : '平价'}
                            </button>
                          ))}
                          <button disabled={quoteConfirmBusy} aria-label="取消结算确认" onClick={() => setConfirmingQuote(null)}>取消</button>
                        </span>
                      ) : (
                        <button
                          className="quote-confirm-toggle"
                          aria-label={`确认 ${q.symbol} 报价的到期结算结果`}
                          onClick={() => {
                            setQuoteConfirmError('')
                            setConfirmingQuote(q.id)
                          }}
                        >
                          确认结算
                        </button>
                      ))}
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="panel">
            <h4>历史研究</h4>
            {runs.length === 0 && <p className="muted">暂无</p>}
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
            <div className="mtf-bar" role="status" aria-label="多周期结构结论">
              <strong>多周期结构</strong>
              {structureFacts.map((t) => (
                <span key={t} className={t.startsWith('周期冲突') ? 'mtf-conflict' : undefined}>{t}</span>
              ))}
            </div>
          )}
          <div className="research-chart">
            <div className="research-chart-head">
              <strong>{symbol}</strong>
              <span>{chartInterval} · {marketType === 'usdm_perp' ? '永续' : '现货'} · 已收盘</span>
              {chartLoading && <span className="muted">加载中…</span>}
              <span className="muted">{bars.length} 根{chartAsOf !== null ? ' · asOf 冻结' : ''}</span>
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
              {chartLoading && <div className="chart-mask">加载 {symbol} K 线…</div>}
              {chartError !== '' && (
                <div className="chart-mask error">
                  <span>{chartError}</span>
                </div>
              )}
            </div>
          </div>
          {activeRun?.snapshotId && (
            <p className="muted snapshot-line">
              冻结快照 {activeRun.snapshotId.slice(0, 8)} · 规则 {activeRun.ruleVersion ?? '-'} · 配置 {activeRun.configVersion ?? '-'} · 知识 {activeRun.knowledgeVersion ? activeRun.knowledgeVersion.slice(0, 8) : '无发布版本'}
              {chartAsOf !== null && (
                <>
                  {` · 图表按运行 asOf 冻结（${new Date(chartAsOf).toLocaleString()}）`}
                  {chartSource === 'snapshot' ? ' · 输入包数据' : ''}
                  <button className="btn btn-sm" onClick={() => setChartAsOf(null)}>回到实时</button>
                </>
              )}
            </p>
          )}
          {chartAsOf !== null && chartFallback !== null && (
            <p className="snapshot-line warn-line" role="alert">
              快照不可复现：{chartFallback}（图表未使用冻结输入包，结论仍有效，图仅作参考）
            </p>
          )}
        </section>

        <section className="research-right" id="research-run">
          <div className="panel chat-panel">
            <div className="chat-head-row">
              <h4>研究对话</h4>
              <button className="btn btn-ghost btn-sm" onClick={() => setToolsOpen(true)}>
                发起研究 / 录入
              </button>
            </div>
            <div className="chat-messages" role="log" aria-live="polite">
              {conv.messages.map((m, i) => (
                <div key={i} className={`chat-msg ${m.role}`}>
                  {m.role === 'user' ? m.text : <MiniMarkdown text={m.text} />}
                  {m.card !== undefined && (
                    <PositionConfirmCard card={m.card} busy={conv.cardBusy === i} onResolve={(confirm) => void conv.resolveCard(i, confirm)} />
                  )}
                  {m.runId !== undefined && (
                    <button className="chat-runlink" onClick={() => void openRunById(m.runId as string)}>
                      查看研究 {(m.runId as string).slice(0, 8)}
                    </button>
                  )}
                </div>
              ))}
              {conv.busy && <div className="chat-msg assistant muted">分析中…</div>}
              {activeRun && (
                <RunBubble
                  run={activeRun}
                  steps={tracker.steps}
                  result={result}
                  sseError={tracker.sseError}
                  sseConn={tracker.sseConn}
                  degraded={tracker.degraded}
                  onCancel={() => void tracker.cancelRun()}
                  onRetry={() => void retryRun()}
                  footer={
                    result !== null ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => setDrawerOpen(true)}>
                        查看证据
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
                placeholder="直接问：BTC 永续多头还能拿吗？/ 10 分钟高于 60000 值得参与吗？"
                aria-label="研究对话输入"
              />
              <button className="btn btn-primary" disabled={conv.busy || conv.input.trim() === ''} onClick={() => void conv.send()}>
                发送
              </button>
            </div>
          </div>
        </section>
      </div>

      {toolsOpen && (
        <div className="modal-overlay" onClick={() => setToolsOpen(false)}>
          <div className="modal research-tools-modal" role="dialog" aria-label="发起研究与数据录入" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>发起研究 / 录入</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setToolsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="run-launcher">
                <h4>发起研究</h4>
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={product === 'event' ? '例：当前结构支持到期高于执行价吗？' : '例：多头持仓是否继续持有？回调二次进场怎么等？'}
                  rows={2}
                />
                {product === 'perp' && (
                  <p className="muted">{selectedPosition === '' ? '未选择持仓：按一般结构研究（无计划盈亏）' : `关联持仓 ${selectedPosition.slice(0, 8)}`}</p>
                )}
                {product === 'event' && (
                  <p className="muted">{selectedQuote === '' ? '未选择报价：EV 不可计算（可先在下方录入）' : `关联报价 ${selectedQuote.slice(0, 8)}`}</p>
                )}
                <button className="btn btn-primary" onClick={() => void createRun()}>发起研究</button>
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
