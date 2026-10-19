import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { EventQuote, Position, ResearchRun } from 'biance-vision-brooks'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { Logo } from '../components/Header'
import MiniMarkdown from '../components/MiniMarkdown'
import { PositionForm, QuoteForm } from './ResearchForms'
import { PositionConfirmCard } from './PositionConfirmCard'
import { EvidenceDrawer } from './ResearchResult'
import { RunBubble } from './RunBubble'
import { UiModeSwitch } from './UiModeSwitch'
import { authUrl } from './uiMode'
import { useResearchConversation } from './useResearchConversation'
import type { ConversationContextSync } from './useResearchConversation'
import { useResearchRun } from './useResearchRun'
import './workbench.css'

const WorkbenchChart = lazy(() => import('./WorkbenchChart'))
type Scene = 'spot' | 'perp' | 'event'
type Horizon = ResearchRun['horizon']
const SCENES = {
  spot: { label: '现货研究', product: 'teaching', marketType: 'spot', hint: '分析 BTC 当前的趋势、结构与关键价位', examples: ['BTC 当前是趋势还是震荡？', '解释二次进场的确认与失效条件'] },
  perp: { label: 'USDT 永续', product: 'perp', marketType: 'usdm_perp', hint: '描述持仓或研究问题，一起检查结构与风险', examples: ['BTC 永续多头还能继续持有吗？', '当前回调二次进场，需要等哪些确认？'] },
  event: { label: '事件合约', product: 'event', marketType: 'usdm_perp', hint: '描述执行价、到期时间与报价，评估参与条件', examples: ['BTC 未来 10 分钟的结构偏向是什么？', '如何判断一笔事件合约的盈亏平衡胜率？'] },
} as const
const TERMINAL = ['published', 'failed', 'cancelled']
const DRAFT_KEY = 'bv.workbench.drafts.v1'
interface DraftState { owner: string | null; scene: Scene; symbol: string; horizon: Horizon; drafts: Record<Scene, string> }
function readDraft(owner: string | null): DraftState {
  const fallback: DraftState = { owner, scene: 'perp', symbol: 'BTCUSDT', horizon: '1h', drafts: { spot: '', perp: '', event: '' } }
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as DraftState | null
    if (!d || (d.owner !== owner && d.owner !== null) || !['spot', 'perp', 'event'].includes(d.scene) || !['10m', '30m', '1h', '1d', '1w'].includes(d.horizon)) return fallback
    return { ...fallback, scene: d.scene, symbol: typeof d.symbol === 'string' ? d.symbol : 'BTCUSDT', horizon: d.horizon,
      drafts: { spot: String(d.drafts?.spot ?? ''), perp: String(d.drafts?.perp ?? ''), event: String(d.drafts?.event ?? '') } }
  } catch { return fallback }
}
function dateGroup(time: number): string {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const age = (start.getTime() - time) / 86400000
  return age < 0 ? '今天' : age < 1 ? '昨天' : age < 7 ? '最近 7 天' : '更早'
}
function useCompact(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 759px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 759px)')
    const change = (): void => setCompact(mq.matches)
    mq.addEventListener('change', change)
    return () => mq.removeEventListener('change', change)
  }, [])
  return compact
}
/** Escape closes every layer; modal layers additionally contain focus and return it to their trigger. */
function useLayerFocus(ref: RefObject<HTMLElement>, open: boolean, modal: boolean, close: () => void): void {
  const closeRef = useRef(close); closeRef.current = close
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const root = ref.current
    if (modal) root?.focus()
    const keydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return }
      if (!modal || e.key !== 'Tab' || !root) return
      const nodes = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(n => n.getClientRects().length > 0)
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (!first) { e.preventDefault(); return }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === root)) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [ref, open, modal])
}

export default function WorkbenchPage(): JSX.Element {
  const { user, logout } = useAuth()
  const location = useLocation(), navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const compact = useCompact()
  const [saved] = useState(() => readDraft(user?.username ?? null))
  const [scene, setScene] = useState<Scene>(saved.scene)
  const [symbol, setSymbol] = useState(saved.symbol)
  const [horizon, setHorizon] = useState<Horizon>(saved.horizon)
  const [drafts, setDrafts] = useState(saved.drafts)
  const [positionId, setPositionId] = useState(''), [quoteId, setQuoteId] = useState('')
  const [navOpen, setNavOpen] = useState(false), [collapsed, setCollapsed] = useState(false)
  const [panel, setPanel] = useState<'evidence' | 'chart' | null>(null)
  const [evidenceId, setEvidenceId] = useState<string | null>(null)
  const [highlightTime, setHighlightTime] = useState<number | null>(null)
  const [panelWidth, setPanelWidth] = useState(430)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [positions, setPositions] = useState<Position[]>([]), [quotes, setQuotes] = useState<EventQuote[]>([])
  const [dataError, setDataError] = useState(''), [pageError, setPageError] = useState('')
  const [runLoading, setRunLoading] = useState(false), [retryBusy, setRetryBusy] = useState(false)
  const [contextLoading, setContextLoading] = useState(false)
  const [unread, setUnread] = useState(false)
  const navRef = useRef<HTMLElement>(null), panelRef = useRef<HTMLElement>(null), toolsRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null)
  const nearBottom = useRef(true), runGeneration = useRef(0)
  const userScroll = useRef(false)
  const composerRef = useRef({ scene, symbol })
  composerRef.current = { scene, symbol }
  const tracker = useResearchRun({ onPublished: () => void refreshTools() })
  const selectedRun = params.get('run'), selectedConversation = params.get('conversation')
  const updateUrl = useCallback((changes: Record<string, string | null>, replace = false): void => {
    setParams(p => { const next = new URLSearchParams(p); next.set('ui', 'dev'); for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k); return next }, { replace })
  }, [setParams])
  const refreshTools = useCallback(async (): Promise<void> => {
    if (!user) return
    const [p, q] = await Promise.allSettled([api<{ positions: Position[] }>('/portfolio'), api<{ quotes: EventQuote[] }>('/event-quotes')])
    if (p.status === 'fulfilled') setPositions(p.value.positions)
    if (q.status === 'fulfilled') setQuotes(q.value.quotes)
    setDataError([p, q].flatMap(r => r.status === 'rejected' ? [(r.reason as Error).message] : []).join('；'))
  }, [user])
  const context = { symbol, horizon, product: SCENES[scene].product, marketType: SCENES[scene].marketType, positionId, quoteId }
  const conv = useResearchConversation({ enabled: !!user, greeting: '', context,
    onConversationCreated: id => updateUrl({ conversation: id }, true),
    onRunCreated: id => updateUrl({ run: id }), onPositionsChanged: () => void refreshTools(),
  })
  const run = tracker.activeRun
  const running = !!run && !TERMINAL.includes(run.status)
  const locked = conv.busy || conv.loadingConversation || contextLoading || conv.cardBusy !== null || runLoading || running || retryBusy || (!!selectedConversation && conv.convId !== selectedConversation)
  const restoreContext = (c?: Partial<ConversationContextSync>): void => {
    if (!c) return
    setScene(c.product === 'event' ? 'event' : c.product === 'teaching' ? 'spot' : 'perp')
    if (c.symbol) setSymbol(c.symbol)
    if (c.horizon && ['10m', '30m', '1h', '1d', '1w'].includes(c.horizon)) setHorizon(c.horizon as Horizon)
    setPositionId(c.product === 'perp' ? c.positionId ?? '' : '')
    setQuoteId(c.product === 'event' ? c.quoteId ?? '' : '')
  }

  useEffect(() => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ owner: user?.username ?? null, scene, symbol, horizon, drafts })) } catch { /* Storage can be disabled. */ } }, [user, scene, symbol, horizon, drafts])
  useEffect(() => { if (user) { void conv.refreshConversations(); void refreshTools() } }, [user, conv.refreshConversations, refreshTools])
  useEffect(() => {
    if (!toolsOpen) return
    void refreshTools()
    const timer = setInterval(() => void refreshTools(), 30000)
    return () => clearInterval(timer)
  }, [toolsOpen, refreshTools])
  useEffect(() => {
    if (!user || conv.busy || conv.cardBusy !== null) return
    let alive = true
    if (selectedConversation && selectedConversation !== conv.convId) {
      setContextLoading(true)
      void (async () => {
        try {
          const loaded = await conv.loadConversation(selectedConversation)
          if (!alive || !loaded) return
          const list = await conv.refreshConversations()
          if (alive) restoreContext(list.find(c => c.id === selectedConversation)?.context)
        } finally { if (alive) setContextLoading(false) }
      })()
    } else { setContextLoading(false); if (!selectedConversation && conv.convId) conv.newConversation() }
    return () => { alive = false }
    // URL is the source of navigation; a newly created conversation already has its messages in memory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversation, user, conv.busy, conv.cardBusy])
  useEffect(() => {
    const gen = ++runGeneration.current
    setPanel(null); setEvidenceId(null); setHighlightTime(null); setPageError('')
    tracker.clearRun()
    if (!user || !selectedRun) { setRunLoading(false); return }
    setRunLoading(true)
    void api<{ run: ResearchRun }>(`/research/runs/${encodeURIComponent(selectedRun)}`)
      .then(d => { if (runGeneration.current === gen) tracker.openRun(d.run) })
      .catch((e: Error) => { if (runGeneration.current === gen) setPageError(`研究加载失败：${e.message}`) })
      .finally(() => { if (runGeneration.current === gen) setRunLoading(false) })
    return () => { ++runGeneration.current }
  }, [selectedRun, user, tracker.openRun, tracker.clearRun])
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const follow = (): void => {
      if (nearBottom.current) { el.scrollTop = el.scrollHeight; setUnread(false) } else setUnread(true)
    }
    follow()
    const observer = new ResizeObserver(follow)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [conv.messages, conv.busy, tracker.steps, tracker.result, run])
  useLayerFocus(navRef, compact && navOpen, true, () => setNavOpen(false))
  useLayerFocus(panelRef, panel !== null, compact, () => setPanel(null))
  useLayerFocus(toolsRef, toolsOpen, true, () => setToolsOpen(false))

  const login = (): void => navigate(authUrl('/login', `${location.pathname}${location.search}`, 'dev'))
  const changeScene = (next: Scene): void => { if (locked) return; setScene(next); setPositionId(''); setQuoteId(''); inputRef.current?.focus() }
  const newChat = (): void => {
    if (conv.busy || conv.cardBusy !== null || retryBusy) return
    conv.newConversation(); tracker.clearRun(); setPanel(null); setPositionId(''); setQuoteId(''); setNavOpen(false)
    nearBottom.current = true; setUnread(false)
    updateUrl({ conversation: null, run: null }); inputRef.current?.focus()
  }
  const send = async (): Promise<void> => {
    if (!drafts[scene].trim() || locked) return
    if (!user) { login(); return }
    if (!/^[A-Z0-9]{3,30}USDT$/.test(symbol)) { setPageError('请输入有效的 USDT 交易对，例如 BTCUSDT。'); return }
    const raw = drafts[scene]; setDrafts(prev => ({ ...prev, [scene]: '' })); setPageError('')
    nearBottom.current = true
    const sent = await conv.send(raw)
    if (!sent) setDrafts(prev => ({ ...prev, [scene]: prev[scene] || raw }))
    inputRef.current?.focus()
  }
  const openPanel = (next: 'chart' | 'evidence', id: string | null = null): void => { setEvidenceId(id); setPanel(next) }
  const retry = async (): Promise<void> => {
    if (!run || retryBusy) return
    setRetryBusy(true)
    try {
      const d = await api<{ run: ResearchRun }>('/research/runs', { method: 'POST', body: { product: run.product, symbol: run.symbol, marketType: run.marketType, horizon: run.horizon } })
      updateUrl({ run: d.run.id })
    } catch (e) { setPageError((e as Error).message) } finally { setRetryBusy(false) }
  }
  const citationIds = [...new Set(tracker.result?.claims.flatMap(c => c.evidenceIds) ?? [])]
  const bubble = run ? <RunBubble run={run} steps={tracker.steps} result={tracker.result} sseError={tracker.sseError} sseConn={tracker.sseConn} degraded={tracker.degraded}
    onCancel={() => void tracker.cancelRun()} onRetry={() => void retry()} onCitation={id => openPanel('evidence', id)}
    footer={<div className="wb-run-actions"><button onClick={() => openPanel('evidence')}>查看证据 ↗</button><button onClick={() => openPanel('chart')}>查看图表 ↗</button><span>{run.symbol} · {run.horizon} · {new Date(run.asOf).toLocaleString()}</span></div>} /> : null
  const visibleMessages = conv.messages.filter(m => m.text || m.card || m.runId)
  const hasInlineRun = conv.messages.some(m => m.runId === run?.id)
  const welcome = visibleMessages.length === 0 && !run && !runLoading
  const title = conv.conversations.find(c => c.id === conv.convId)?.title || (run ? `${run.symbol} · 研究` : '新的研究对话')

  return <div className={`workbench ${collapsed ? 'wb-collapsed' : ''}`} style={{ '--wb-panel-width': `${panelWidth}px` } as CSSProperties}>
    {compact && navOpen && <button className="wb-shade" aria-label="关闭会话导航" onClick={() => setNavOpen(false)} />}
    <aside ref={navRef} tabIndex={-1} className={`wb-sidebar ${navOpen ? 'is-open' : ''}`} role={compact ? 'dialog' : undefined} aria-modal={compact && navOpen || undefined} aria-label="会话导航">
      <div className="wb-brand"><Link to="/research?ui=dev" aria-label="研究工作台首页"><Logo /><span>VISION<span className="wb-brand-sub">比特币研究 Agent</span></span></Link><button className="wb-icon" aria-label={collapsed ? '展开导航' : '折叠导航'} onClick={() => compact ? setNavOpen(false) : setCollapsed(!collapsed)}>☷</button></div>
      <button className="wb-new" disabled={conv.busy || conv.cardBusy !== null || retryBusy} onClick={newChat}><span aria-hidden>＋</span><span className="wb-nav-text">开启新对话</span></button>
      <div className="wb-history"><div className="wb-section-title">对话记录</div>
        {!user ? <div className="wb-history-empty"><span aria-hidden>◌</span><p>登录后，你的研究对话<br />会保存在这里</p></div> : <>
          {conv.historyError && <div className="wb-history-error" role="alert">{conv.historyError}<button onClick={() => void conv.refreshConversations()}>重试</button></div>}
          {conv.conversations.length === 0 && !conv.historyError && <p className="wb-caption">从一个问题开始研究</p>}
          {conv.conversations.map((c, i, list) => <div key={c.id}>{(i === 0 || dateGroup(list[i - 1].updatedAt) !== dateGroup(c.updatedAt)) && <div className="wb-date">{dateGroup(c.updatedAt)}</div>}
            <button className={`wb-history-item ${c.id === conv.convId ? 'active' : ''}`} title={c.title} aria-current={c.id === conv.convId ? 'page' : undefined} disabled={conv.busy || conv.cardBusy !== null || retryBusy}
              onClick={() => { setNavOpen(false); nearBottom.current = true; updateUrl({ conversation: c.id, run: null }) }}>{c.title || '未命名对话'}</button></div>)}
        </>}
      </div>
      <div className="wb-sidebar-foot"><nav aria-label="其他工作台"><Link to="/">◫ <span>行情大盘</span></Link><Link to="/brooks">⌁ <span>价格行为</span></Link>{user?.role === 'superadmin' && <Link to="/admin">⚙ <span>管理后台</span></Link>}</nav>
        <div className="wb-account">{user ? <><span className="wb-avatar">{user.username.slice(0, 1).toUpperCase()}</span><span className="wb-account-name">{user.username}</span><button onClick={() => void logout()} aria-label="退出登录">退出</button></> : <button className="wb-login" onClick={login}><span className="wb-avatar">↗</span><span>点击登录</span></button>}</div>
      </div>
    </aside>
    <main className="wb-main">
      <header className="wb-top"><button className="wb-icon wb-mobile-menu" aria-label="打开会话导航" onClick={() => setNavOpen(true)}>☷</button><div className="wb-title">{title}<span>研究工作台 <em>DEV</em></span></div><UiModeSwitch disabled={conv.busy || conv.cardBusy !== null || retryBusy} conversationId={conv.convId ?? selectedConversation} runId={run?.id ?? selectedRun} /></header>
      <nav className="wb-mobile-views" aria-label="工作台视图">{(['chart', 'chat', 'evidence'] as const).map(v => <button key={v} aria-pressed={v === 'chat' ? panel === null : panel === v} onClick={() => v === 'chat' ? setPanel(null) : openPanel(v)}>{v === 'chart' ? '图表' : v === 'chat' ? '对话' : '证据'}</button>)}</nav>
      <div className={`wb-chat-area ${welcome ? 'is-welcome' : ''}`}>
        <div className="wb-log" ref={logRef} tabIndex={0} aria-label="研究对话内容"
          onWheel={() => { userScroll.current = true }} onTouchMove={() => { userScroll.current = true }}
          onPointerDown={() => { userScroll.current = true }} onPointerMove={e => { if (e.buttons) userScroll.current = true }}
          onKeyDown={e => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) userScroll.current = true }}
          onScroll={() => {
            const el = logRef.current!
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
            if (userScroll.current || atBottom) nearBottom.current = atBottom
            userScroll.current = false
            if (nearBottom.current) setUnread(false)
          }}>
          <div className="wb-thread">
            {welcome && <section className="wb-welcome"><div className="wb-welcome-icon"><Logo /></div><div className="wb-eyebrow">从问题出发，让证据说话</div><h1>你的比特币<br /><span>研究伙伴</span></h1><p>看清市场结构，检查交易假设，理解每一条依据。</p><div className="wb-suggestions">{SCENES[scene].examples.map(q => <button key={q} onClick={() => { setDrafts(d => ({ ...d, [scene]: q })); inputRef.current?.focus() }}>{q}<span aria-hidden>↗</span></button>)}</div></section>}
            {conv.loadingConversation && <p role="status" className="wb-caption">正在恢复对话…</p>}
            {!conv.loadingConversation && conv.messages.map((m, i) => (!m.text && !m.card && !m.runId) ? null : <article key={i} className={`wb-message ${m.role}`}>
              <div className="wb-message-label">{m.role === 'user' ? '你' : 'VISION'}</div><div className="wb-message-body">{m.text && (m.role === 'user' ? <p className="wb-user-text">{m.text}</p> : <MiniMarkdown text={m.text} />)}
                {m.card && <PositionConfirmCard card={m.card} busy={conv.cardBusy !== null} onResolve={confirm => void conv.resolveCard(i, confirm)} />}
                {m.runId && (m.runId === run?.id ? bubble : <button className="wb-run-link" disabled={running || conv.busy} onClick={() => updateUrl({ run: m.runId! })}>查看这次研究 {m.runId.slice(0, 8)} ↗</button>)}</div>
            </article>)}
            {conv.busy && <p className="wb-thinking" role="status"><span />正在理解问题…</p>}
            {runLoading && <p className="wb-caption" role="status">正在读取研究…</p>}
            {run && !hasInlineRun && <article className="wb-message assistant"><div className="wb-message-label">VISION · 研究</div><div className="wb-message-body">{bubble}</div></article>}
          </div>
        </div>
        {unread && <button className="wb-to-bottom" onClick={() => { nearBottom.current = true; const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; setUnread(false) }}>回到底部 ↓</button>}
        <div className="wb-compose-wrap">
          {pageError && <p className="wb-alert" role="alert">{pageError}</p>}
          {conv.historyError && selectedConversation && <p className="wb-alert" role="alert">无法恢复会话：{conv.historyError}</p>}
          <div className="wb-composer"><div className="wb-scenes" role="tablist" aria-label="研究场景" onKeyDown={e => {
            if (locked || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
            e.preventDefault()
            const scenes = Object.keys(SCENES) as Scene[]
            const next = scenes[e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (scenes.indexOf(scene) + (e.key === 'ArrowRight' ? 1 : 2)) % 3]
            changeScene(next); document.getElementById(`scene-${next}`)?.focus()
          }}>{(Object.keys(SCENES) as Scene[]).map(s => <button key={s} id={`scene-${s}`} role="tab" tabIndex={scene === s ? 0 : -1} aria-selected={scene === s} aria-controls="wb-composer-panel" disabled={locked} onClick={() => changeScene(s)}>{SCENES[s].label}</button>)}</div>
            <div role="tabpanel" id="wb-composer-panel" aria-labelledby={`scene-${scene}`}><textarea ref={inputRef} aria-label="研究问题" value={drafts[scene]} placeholder={SCENES[scene].hint} maxLength={2000} rows={3} onChange={e => setDrafts(d => ({ ...d, [scene]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
              <div className="wb-compose-tools"><div className="wb-context"><label><span className="sr-only">交易对</span><input aria-label="交易对" value={symbol} disabled={locked} onChange={e => { setSymbol(e.target.value.toUpperCase()); setPositionId(''); setQuoteId('') }} list="wb-symbols" /></label><datalist id="wb-symbols">{['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'].map(s => <option key={s} value={s} />)}</datalist><label><span className="sr-only">研究期限</span><select aria-label="研究期限" value={horizon} disabled={locked} onChange={e => setHorizon(e.target.value as Horizon)}>{(['10m', '30m', '1h', '1d', '1w'] as Horizon[]).map(h => <option key={h} value={h}>{h}{h === '1w' ? ' · 研究模式' : ''}</option>)}</select></label></div>
                <div className="wb-send-tools">{scene !== 'spot' && <button className="wb-tool" disabled={locked} onClick={() => user ? setToolsOpen(true) : login()}>{scene === 'perp' ? (positionId ? '已关联持仓' : '持仓 / 风险') : (quoteId ? '已关联报价' : '报价 / 结算')}</button>}<button className="wb-send" aria-label={user ? '发送研究问题' : '登录后发起研究'} disabled={locked || !drafts[scene].trim()} onClick={() => void send()}>{conv.busy ? '…' : '↑'}</button></div>
              </div>
            </div>
          </div>
          <div className="wb-compose-note">{running ? '研究进行中，当前场景已锁定；开启新对话可切换场景。' : horizon === '1w' ? '1w 为研究模式，非币安事件合约产品。' : scene === 'event' && !quoteId ? '未关联报价，EV 不可计算；可先录入 App 实际报价。' : scene === 'perp' && !positionId ? '未关联持仓，按一般结构研究；不计算计划盈亏。' : '基于行情、结构与知识证据研究，仅供学习参考。'}<span>Enter 发送 · Shift + Enter 换行</span></div>
        </div>
      </div>
    </main>
    {panel && <>
      {compact && <div className="wb-shade wb-panel-shade" onClick={() => setPanel(null)} />}
      <aside ref={panelRef} tabIndex={-1} className="wb-detail" role={compact ? 'dialog' : 'region'} aria-modal={compact || undefined} aria-label="研究资料">
        {!compact && <div className="wb-resizer" role="separator" aria-label="调整研究资料宽度" aria-orientation="vertical" aria-valuenow={panelWidth} aria-valuemin={340} aria-valuemax={700} tabIndex={0} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setPanelWidth(w => Math.max(340, Math.min(700, w + (e.key === 'ArrowLeft' ? 20 : -20)))) } }} onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setPanelWidth(Math.max(340, Math.min(700, window.innerWidth - e.clientX))) }} onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)} />}
        <div className="wb-detail-head"><div className="wb-detail-tabs">{(['evidence', 'chart'] as const).map(p => <button key={p} aria-pressed={panel === p} onClick={() => setPanel(p)}>{p === 'evidence' ? '引用与证据' : '结构图表'}</button>)}</div><button className="wb-icon" aria-label="关闭研究资料" onClick={() => setPanel(null)}>✕</button></div>
        <div className="wb-detail-body">{!user ? <p className="wb-caption">登录后可查看研究证据与图表。</p> : !run ? <p className="wb-caption">先发起研究，或从对话中选择一条研究结果。</p> : <><p className="wb-caption">研究 {run.id.slice(0, 8)} · {run.symbol}<br />{new Date(run.asOf).toLocaleString()}</p>{panel === 'evidence' ? <EvidenceDrawer key={run.id} runId={run.id} open embedded selectedEvidenceId={evidenceId} citationIds={citationIds} onClose={() => setPanel(null)} onLocateBar={time => { setHighlightTime(time); setPanel('chart') }} /> : <Suspense fallback={<p role="status">加载图表…</p>}><WorkbenchChart key={run.id} run={run} result={tracker.result} highlightTime={highlightTime} /></Suspense>}</> }</div>
      </aside>
    </>}
    {toolsOpen && user && <div className="wb-modal-shade" onClick={() => setToolsOpen(false)}><div ref={toolsRef} tabIndex={-1} className="wb-tools-modal" role="dialog" aria-modal="true" aria-label={scene === 'perp' ? '持仓与风险' : '事件报价与结算'} onClick={e => e.stopPropagation()}><div className="wb-detail-head"><strong>{scene === 'perp' ? '持仓与风险' : '事件报价与结算'} · {symbol}</strong><button className="wb-icon" aria-label="关闭录入工具" onClick={() => setToolsOpen(false)}>✕</button></div><div className="wb-tools-body">{dataError && <p className="err-text" role="alert">数据读取失败：{dataError}<button onClick={() => void refreshTools()}>重试</button></p>}
      <label className="wb-associated">{scene === 'perp' ? '关联已确认持仓' : '关联手工报价'}<select aria-label="关联记录" value={scene === 'perp' ? positionId : quoteId} onChange={e => scene === 'perp' ? setPositionId(e.target.value) : setQuoteId(e.target.value)}><option value="">不关联</option>{scene === 'perp' ? positions.filter(p => p.symbol === symbol).map(p => <option key={p.id} value={p.id}>{p.symbol} · {p.side} · {p.qty} @ {p.entryPrice}{p.isStale ? ' · 已过期，请重新确认' : ''}</option>) : quotes.filter(q => q.symbol === symbol).map(q => <option key={q.id} value={q.id}>{q.symbol} · {q.direction} {q.strikePrice} · {new Date(q.expiryAt).toLocaleString()}</option>)}</select></label>
      {scene === 'perp' ? <PositionForm symbol={symbol} onSaved={p => { if (composerRef.current.scene === 'perp' && composerRef.current.symbol === p.symbol) setPositionId(p.id); void refreshTools() }} /> : <><QuoteForm symbol={symbol} onSaved={q => { if (composerRef.current.scene === 'event' && composerRef.current.symbol === q.symbol) setQuoteId(q.id); void refreshTools() }} /><SettlementList quotes={quotes.filter(q => q.symbol === symbol)} onChanged={refreshTools} /></>}
      <button className="btn btn-primary wb-tools-done" onClick={() => setToolsOpen(false)}>完成，返回对话</button>
    </div></div></div>}
  </div>
}

function SettlementList({ quotes, onChanged }: { quotes: EventQuote[]; onChanged: () => Promise<void> }): JSX.Element {
  const [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const confirm = async (id: string, outcome: 'above' | 'below' | 'tie'): Promise<void> => {
    setBusy(true); setError('')
    try { await api(`/event-quotes/${id}/confirm`, { method: 'POST', body: { outcome } }); setSelected(''); await onChanged() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="wb-settlement"><h4>到期结算记录</h4>{error && <p className="err-text" role="alert">{error}</p>}{quotes.length === 0 && <p className="wb-caption">暂无报价记录</p>}{quotes.map(q => <div key={q.id}><p>{q.direction === 'above' ? '高于' : '低于'} {q.strikePrice} · {new Date(q.expiryAt).toLocaleString()}</p>{q.userConfirmedOutcome ? <span>已确认：{q.userConfirmedOutcome}</span> : selected === q.id ? <div role="group" aria-label="确认实际结算结果">{(['above', 'below', 'tie'] as const).map(o => <button key={o} disabled={busy} onClick={() => void confirm(q.id, o)}>{o === 'above' ? '高于' : o === 'below' ? '低于' : '平价'}</button>)}<button disabled={busy} onClick={() => setSelected('')}>取消</button></div> : <button disabled={busy} onClick={() => setSelected(q.id)}>确认结算</button>}</div>)}</section>
}
