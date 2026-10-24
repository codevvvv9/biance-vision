import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { EventQuote, Position, ResearchRun } from 'biance-vision-brooks'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { Logo } from '../components/Header'
import MiniMarkdown from '../components/MiniMarkdown'
import CitationBadges from './CitationBadges'
import { MessageTranslate } from './MessageTranslate'
import { PositionForm, QuoteForm } from './ResearchForms'
import { PositionConfirmCard } from './PositionConfirmCard'
import { EvidenceDrawer } from './ResearchResult'
import { RunBubble } from './RunBubble'
import { UiModeSwitch } from './UiModeSwitch'
import { Dropdown } from './Dropdown'
import { ContextCard } from './ContextCard'
import type { FollowUpAction } from 'biance-vision-brooks'
import { Combobox } from './Combobox'
import { authUrl } from './uiMode'
import { ENTRY_KEY, parseEntry, type ResearchEntryDraftV1 } from './websiteEntry'
import { useResearchConversation } from './useResearchConversation'
import type { ConversationContextSync } from './useResearchConversation'
import { useResearchRun } from './useResearchRun'
import './workbench.css'

const WorkbenchChart = lazy(() => import('./WorkbenchChart'))
type Scene = 'spot' | 'perp' | 'event'
type Horizon = ResearchRun['horizon']
/** 场景静态属性（文案走 research:scene.<key>.* 词典，语言切换时由组件重取） */
const SCENES = {
  spot: { product: 'teaching', marketType: 'spot' },
  perp: { product: 'perp', marketType: 'usdm_perp' },
  event: { product: 'event', marketType: 'usdm_perp' },
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
function dateGroupKey(time: number): string {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const age = (start.getTime() - time) / 86400000
  return age < 0 ? 'research:age.today' : age < 1 ? 'research:age.yesterday' : age < 7 ? 'research:age.week' : 'research:age.earlier'
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
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const websiteLocale = zh ? 'zh' : 'en'
  const { user, logout } = useAuth()
  const location = useLocation(), navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const compact = useCompact()
  const [saved] = useState(() => readDraft(user?.username ?? null))
  const [entry, setEntry] = useState<ResearchEntryDraftV1 | null>(() => { try { return parseEntry(sessionStorage.getItem(ENTRY_KEY)) } catch { return null } })
  const [entryNotice, setEntryNotice] = useState('')
  const [quota, setQuota] = useState<{ managed: boolean; remaining: number | null } | null>(null)
  const refreshQuota = useCallback(async (): Promise<void> => { if (!user) return; try { setQuota(await api('/users/me/ai-access')) } catch { /* Server still enforces quota if status cannot load. */ } }, [user])
  useEffect(() => { void refreshQuota() }, [refreshQuota])
  useEffect(() => { try { if (sessionStorage.getItem(ENTRY_KEY) && !entry) { sessionStorage.removeItem(ENTRY_KEY); setEntryNotice(zh ? '官网问题已失效，请重新输入或选择下方示例问题。' : 'Your website question expired. Write a question or choose an example below.') } } catch { /* Manual input remains available. */ } }, [])
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
  /** P1-8 输入面板配置（服务端下发；缺失回退内置占位/2 条建议） */
  const [inputCfg, setInputCfg] = useState<{ placeholder: Record<string, string>; suggestionLimit: number }>({ placeholder: {}, suggestionLimit: 2 })
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
  const applyEntry = (): void => {
    const valid = entry ? parseEntry(JSON.stringify(entry)) : null
    if (!valid) { setEntry(null); setEntryNotice(zh ? '问题已失效，请重新输入或选择示例。' : 'Question expired. Write a new question or choose an example.'); return }
    if (selectedConversation || selectedRun) { updateUrl({ conversation: null, run: null }); conv.newConversation(); tracker.clearRun() }
    setScene(valid.scene); setSymbol(valid.symbol); setHorizon(valid.horizon); setPositionId(''); setQuoteId('')
    setDrafts(d => ({ ...d, [valid.scene]: valid.question })); void i18n.changeLanguage(valid.locale)
    try { sessionStorage.removeItem(ENTRY_KEY) } catch { /* No storage is required for sending. */ }
    setEntry(null); setEntryNotice(valid.locale === 'zh-CN' ? '官网问题已恢复，请检查后确认发送。' : 'Question restored. Review it before sending.'); inputRef.current?.focus()
  }
  const keepDraft = (): void => { try { sessionStorage.removeItem(ENTRY_KEY) } catch { /* optional */ }; setEntry(null) }
  const context = { symbol, horizon, product: SCENES[scene].product, marketType: SCENES[scene].marketType, positionId, quoteId }
  const conv = useResearchConversation({ enabled: !!user, greeting: '', context,
    onConversationCreated: id => updateUrl({ conversation: id }, true),
    onRunCreated: id => updateUrl({ run: id }), onPositionsChanged: () => void refreshTools(),
  })
  useEffect(() => { if (user && entry && !selectedConversation && !selectedRun && !Object.values(drafts).some(d => d.trim())) applyEntry() }, [user, entry, selectedConversation, selectedRun])
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
  // P1-8 输入面板配置（服务端 /config/research-ui；失败回退内置，不阻塞页面）
  useEffect(() => {
    let alive = true
    void api<{ chatInput?: { scenes?: Record<string, { placeholder?: string; suggestionLimit?: number }> } }>('/config/research-ui')
      .then((d) => {
        if (!alive || d.chatInput?.scenes === undefined) return
        const placeholder: Record<string, string> = {}
        for (const [k, v] of Object.entries(d.chatInput.scenes)) if (v.placeholder !== undefined) placeholder[k] = v.placeholder
        const limit = Object.values(d.chatInput.scenes).find((v) => v.suggestionLimit !== undefined)?.suggestionLimit
        setInputCfg({ placeholder, suggestionLimit: typeof limit === 'number' && limit >= 0 && limit <= 8 ? limit : 2 })
      })
      .catch(() => { /* 配置拉取失败用内置默认 */ })
    return () => { alive = false }
  }, [])
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
      .catch((e: Error) => { if (runGeneration.current === gen) setPageError(t('research:wb.dataLoadFailed', { msg: e.message })) })
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
    if (!drafts[scene].trim() || locked || quota?.remaining === 0) return
    if (!user) { login(); return }
    if (!/^[A-Z0-9]{3,30}USDT$/.test(symbol)) { setPageError(t('research:run.invalidSymbol')); return }
    const raw = drafts[scene]; setDrafts(prev => ({ ...prev, [scene]: '' })); setPageError('')
    nearBottom.current = true
    const sent = await conv.send(raw)
    void refreshQuota()
    if (!sent) setDrafts(prev => ({ ...prev, [scene]: prev[scene] || raw }))
    inputRef.current?.focus()
  }
  const openPanel = (next: 'chart' | 'evidence', id: string | null = null): void => { setEvidenceId(id); setPanel(next) }
  // P1-1 直建 run 的场景（与服务端 defaultSceneForProduct 同口径：产品+持仓引用推导）
  const sceneOf = (product: string, hasPosition: boolean): string =>
    product === 'perp' ? (hasPosition ? 'hold-review' : 'structure-scan') : product === 'event' ? 'quote-review' : 'structure-scan'
  const HORIZON_ORDER: Horizon[] = ['10m', '30m', '1h', '1d', '1w']
  // P1-3 重跑携带原研究上下文（2026-10-20 评审 #3）：question/positionId/quoteId/
  // positionOverride/asOf 从 run.input（创建请求快照）恢复——持仓复查仍是持仓复查、
  // 报价评估仍带报价、历史复盘不变成当前研究；旧 run 无 input 时退回 run 行可得字段。
  // asOf 默认沿用原研究时点（replay 换周期仍在同一历史时点）；asOfNow=true（事件
  // 「临近到期重估」）时以当前时刻重估同一报价。
  const createRunDirect = async (opts: { horizon?: Horizon; asOfNow?: boolean } = {}): Promise<void> => {
    if (!run || retryBusy) return
    setRetryBusy(true)
    try {
      const src = (run.input ?? {}) as Partial<NonNullable<ResearchRun['input']>>
      const nextH = opts.horizon ?? run.horizon
      const d = await api<{ run: ResearchRun }>('/research/runs', {
        method: 'POST',
        body: {
          product: run.product,
          symbol: run.symbol,
          marketType: run.marketType,
          horizon: nextH,
          question: typeof src.question === 'string' ? src.question : undefined,
          positionId: typeof src.positionId === 'string' ? src.positionId : undefined,
          quoteId: typeof src.quoteId === 'string' ? src.quoteId : undefined,
          positionOverride: (src.positionOverride as { leverage: number } | undefined) ?? undefined,
          asOf: opts.asOfNow === true ? undefined : (typeof src.asOf === 'number' ? src.asOf : run.asOf),
          sceneCode: run.sceneCode ?? sceneOf(run.product, typeof src.positionId === 'string'),
        },
      })
      updateUrl({ run: d.run.id })
    } catch (e) { setPageError((e as Error).message) } finally { setRetryBusy(false) }
  }
  const retry = async (): Promise<void> => { await createRunDirect() }
  // P1-3 结构化追问分发（动作不转聊天消息；counter_search 例外——明确告知是新研究）
  const onFollowUp = (a: FollowUpAction): void => {
    if (a.action === 'open_evidence' || a.action === 'open_rule_card') { openPanel('evidence'); return }
    if (a.action === 'switch_context') { setToolsOpen(true); return }
    if (a.action === 'rerun_with') {
      // interval:'next' = 换周期重跑（perp/replay）；interval:'same' = 事件到期临近重估
      //（保持原报价与周期，当前时刻重跑——不再被统一处理成切换研究周期）
      const interval = (a.parameters?.interval as string | undefined) ?? 'next'
      if (interval === 'same') { void createRunDirect({ asOfNow: true }); return }
      void createRunDirect({ horizon: HORIZON_ORDER[(HORIZON_ORDER.indexOf(run?.horizon ?? '1h') + 1) % HORIZON_ORDER.length] })
      return
    }
    if (a.action === 'counter_search') {
      void conv.send(t('research:wb.counterFollowUp', { symbol: run?.symbol ?? symbol, horizon: run?.horizon ?? horizon }))
      return
    }
  }
  const citationIds = [...new Set(tracker.result?.claims.flatMap(c => c.evidenceIds) ?? [])]
  const bubble = run ? <RunBubble run={run} steps={tracker.steps} result={tracker.result} sseError={tracker.sseError} sseConn={tracker.sseConn} degraded={tracker.degraded} details={tracker.details} securityInterrupt={tracker.securityInterrupt}
    onCancel={() => void tracker.cancelRun()} onRetry={() => void retry()} onCitation={id => openPanel('evidence', id)} onFollowUp={onFollowUp}
    footer={<div className="wb-run-actions"><button onClick={() => openPanel('evidence')}>{t('research:wb.viewEvidence')}</button><button onClick={() => openPanel('chart')}>{t('research:wb.viewChart')}</button><span>{run.symbol} · {run.horizon} · {new Date(run.asOf).toLocaleString()}</span></div>} /> : null
  const visibleMessages = conv.messages.filter(m => m.text || m.card || m.runId)
  const hasInlineRun = conv.messages.some(m => m.runId === run?.id)
  const welcome = visibleMessages.length === 0 && !run && !runLoading
  const title = conv.conversations.find(c => c.id === conv.convId)?.title || (run ? t('research:wb.researchOf', { symbol: run.symbol }) : t('research:wb.newConversation'))

  return <div className={`workbench ${collapsed ? 'wb-collapsed' : ''}`} style={{ '--wb-panel-width': `${panelWidth}px` } as CSSProperties}>
    {compact && navOpen && <button className="wb-shade" aria-label={t('research:wb.closeNavAria')} onClick={() => setNavOpen(false)} />}
    <aside ref={navRef} tabIndex={-1} className={`wb-sidebar ${navOpen ? 'is-open' : ''}`} role={compact ? 'dialog' : undefined} aria-modal={compact && navOpen || undefined} aria-label={t('research:wb.navAria')}>
      <div className="wb-brand"><Link to="/research?ui=dev" aria-label={t('research:wb.homeAria')}><Logo /><span>VISION<span className="wb-brand-sub">{t('research:wb.brandSub')}</span></span></Link><button className="wb-icon" aria-label={collapsed ? t('research:wb.expandNav') : t('research:wb.collapseNav')} onClick={() => compact ? setNavOpen(false) : setCollapsed(!collapsed)}>☷</button></div>
      <button className="wb-new" disabled={conv.busy || conv.cardBusy !== null || retryBusy} onClick={newChat}><span aria-hidden>＋</span><span className="wb-nav-text">{t('research:wb.newChat')}</span></button>
      <div className="wb-history"><div className="wb-section-title">{t('research:wb.historyTitle')}</div>
        {!user ? <div className="wb-history-empty"><span aria-hidden>◌</span><p>{t('research:wb.loginToSave').split('\n').map((line, i, arr) => <span key={i}>{line}{i < arr.length - 1 && <br />}</span>)}</p></div> : <>
          {conv.historyError && <div className="wb-history-error" role="alert">{conv.historyError}<button onClick={() => void conv.refreshConversations()}>{t('research:wb.retry')}</button></div>}
          {conv.conversations.length === 0 && !conv.historyError && <p className="wb-caption">{t('research:wb.startFromQuestion')}</p>}
          {conv.conversations.map((c, i, list) => <div key={c.id}>{(i === 0 || dateGroupKey(list[i - 1].updatedAt) !== dateGroupKey(c.updatedAt)) && <div className="wb-date">{t(dateGroupKey(c.updatedAt))}</div>}
            <button className={`wb-history-item ${c.id === conv.convId ? 'active' : ''}`} title={c.title} aria-current={c.id === conv.convId ? 'page' : undefined} disabled={conv.busy || conv.cardBusy !== null || retryBusy}
              onClick={() => { setNavOpen(false); nearBottom.current = true; updateUrl({ conversation: c.id, run: null }) }}>{c.title || t('research:wb.untitled')}</button></div>)}
        </>}
      </div>
      <div className="wb-sidebar-foot"><nav aria-label={t('research:wb.otherWorkbench')}><Link to="/dashboard">◫ <span>{t('research:wb.markets')}</span></Link><a href={`/${websiteLocale}`}>↗ <span>{zh ? '官网' : 'Website'}</span></a><Link to="/brooks">⌁ <span>{t('research:wb.priceAction')}</span></Link></nav>
        <div className="wb-account">{user ? <><span className="wb-avatar">{user.username.slice(0, 1).toUpperCase()}</span><span className="wb-account-name">{user.username}</span><button onClick={() => void logout()} aria-label={t('research:wb.logoutAria')}>{t('research:wb.logout')}</button></> : <button className="wb-login" onClick={login}><span className="wb-avatar">↗</span><span>{t('research:wb.login')}</span></button>}</div>
      </div>
    </aside>
    <main className="wb-main">
      <header className="wb-top"><button className="wb-icon wb-mobile-menu" aria-label={t('research:wb.openNavAria')} onClick={() => setNavOpen(true)}>☷</button><div className="wb-title">{title}<span>{t('research:wb.workbenchTitle')} <em>DEV</em></span></div><UiModeSwitch disabled={conv.busy || conv.cardBusy !== null || retryBusy} conversationId={conv.convId ?? selectedConversation} runId={run?.id ?? selectedRun} /></header>
      <nav className="wb-mobile-views" aria-label={t('research:wb.viewsAria')}>{(['chart', 'chat', 'evidence'] as const).map(v => <button key={v} aria-pressed={v === 'chat' ? panel === null : panel === v} onClick={() => v === 'chat' ? setPanel(null) : openPanel(v)}>{v === 'chart' ? t('research:main.tabChart') : v === 'chat' ? t('research:main.tabChat') : t('research:main.tabEvidence')}</button>)}</nav>
      <div className={`wb-chat-area ${welcome ? 'is-welcome' : ''}`}>
        <div className="wb-log" ref={logRef} tabIndex={0} aria-label={t('research:wb.researchChatAria')}
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
            {welcome && <section className="wb-welcome"><div className="wb-welcome-icon"><Logo /></div><div className="wb-eyebrow">{t('research:wb.eyebrow')}</div><h1>{t('research:wb.heroTitle1')}<br /><span>{t('research:wb.heroTitle2')}</span></h1><p>{t('research:wb.heroDesc')}</p><div className="wb-suggestions">{(t(`research:scene.${scene}.examples`, { returnObjects: true }) as string[]).slice(0, inputCfg.suggestionLimit).map(q => <button key={q} onClick={() => { setDrafts(d => ({ ...d, [scene]: q })); inputRef.current?.focus() }}>{q}<span aria-hidden>↗</span></button>)}</div></section>}
            {conv.loadingConversation && <p role="status" className="wb-caption">{t('research:wb.restoring')}</p>}
            {!conv.loadingConversation && conv.messages.map((m, i) => (!m.text && !m.card && !m.runId) ? null : <article key={i} className={`wb-message ${m.role}`}>
              <div className="wb-message-label">{m.role === 'user' ? t('research:wb.you') : 'VISION'}</div><div className="wb-message-body">{m.text && (m.role === 'user' ? <p className="wb-user-text">{m.text}</p> : <MiniMarkdown text={m.text} />)}
                {m.text !== '' && <MessageTranslate text={m.text} />}
                {m.citations !== undefined && <CitationBadges citations={m.citations} />}
                {m.card && <PositionConfirmCard card={m.card} busy={conv.cardBusy !== null} onResolve={confirm => void conv.resolveCard(i, confirm)} />}
                {m.runId && (m.runId === run?.id ? bubble : <button className="wb-run-link" disabled={running || conv.busy} onClick={() => updateUrl({ run: m.runId! })}>{t('research:wb.viewThisRun', { id: m.runId.slice(0, 8) })}</button>)}</div>
            </article>)}
            {(run || visibleMessages.some(m => m.role === 'assistant')) && <details className="wb-result-help"><summary>{zh ? '如何阅读研究结果' : 'How to read your research'}</summary><p>{zh ? '先看结论适用的场景与时间，再核对支持证据、反对证据和失效条件。数据不足时先补充问题或等待，不将研究结果视为保证。' : 'Check the context and research time, then compare supporting evidence, opposing evidence and invalidation conditions. When data is insufficient, refine your question or wait. Research does not guarantee outcomes.'}</p><a href={`/${websiteLocale}/guides/reading-research-results`}>{zh ? '完整阅读指南' : 'Read the full guide'}</a></details>}
            {conv.busy && <p className="wb-thinking" role="status"><span />{t('research:wb.understanding')}</p>}
            {runLoading && <p className="wb-caption" role="status">{t('research:wb.readingRun')}</p>}
            {run && !hasInlineRun && <article className="wb-message assistant"><div className="wb-message-label">{t('research:wb.visionResearch')}</div><div className="wb-message-body">{bubble}</div></article>}
          </div>
        </div>
        {unread && <button className="wb-to-bottom" onClick={() => { nearBottom.current = true; const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; setUnread(false) }}>{t('research:wb.toBottom')}</button>}
        <div className="wb-compose-wrap">
          {entry && user && <div className="wb-entry" role="region" aria-label={zh ? '官网问题恢复' : 'Restore website question'}><p>{zh ? '官网有一个待恢复的问题。恢复仅填写输入框，由你确认发送。' : 'A website question is ready to restore. Review and send it yourself.'}</p><blockquote>{entry.question}</blockquote>{(Object.values(drafts).some(d => d.trim()) || selectedConversation || selectedRun) && <p>{zh ? '当前有草稿或历史会话。替换会切换到新会话，请先保存需要保留的文字。' : 'There is a draft or history open. Restoring starts a new conversation. Save any text you wish to keep first.'}</p>}<button disabled={locked} onClick={applyEntry}>{zh ? '恢复官网问题' : 'Restore website question'}</button><button onClick={keepDraft}>{zh ? '保留当前草稿' : 'Keep current draft'}</button></div>}
          {entryNotice && <p className="wb-caption" role="status">{entryNotice}</p>}
          {quota?.managed && <p className="wb-caption" role="status">{zh ? `剩余 AI 交互次数：${quota.remaining}` : `AI interactions remaining: ${quota.remaining}`} · <a href={`/${websiteLocale}/contact`}>{zh ? '联系开通会员服务' : 'Contact us for membership'}</a></p>}
          {pageError && <p className="wb-alert" role="alert">{pageError} <a href={`/${websiteLocale}/guides/getting-started`}>{zh ? '查看首次使用指南' : 'Getting started'}</a></p>}
          {conv.historyError && selectedConversation && <p className="wb-alert" role="alert">{t('research:wb.restoreFailed', { msg: conv.historyError })}</p>}
          <ContextCard symbol={symbol} horizon={horizon} product={SCENES[scene].product}
            position={scene === 'perp' ? positions.find(p => p.id === positionId) ?? null : null}
            quote={scene === 'event' ? quotes.find(q => q.id === quoteId) ?? null : null}
            onOpenTools={() => setToolsOpen(true)} loggedIn={!!user} />
          <div className="wb-composer"><div className="wb-scenes" role="tablist" aria-label={t('research:wb.scenesAria')} onKeyDown={e => {
            if (locked || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
            e.preventDefault()
            const scenes = Object.keys(SCENES) as Scene[]
            const next = scenes[e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (scenes.indexOf(scene) + (e.key === 'ArrowRight' ? 1 : 2)) % 3]
            changeScene(next); document.getElementById(`scene-${next}`)?.focus()
          }}>{(Object.keys(SCENES) as Scene[]).map(s => <button key={s} id={`scene-${s}`} role="tab" tabIndex={scene === s ? 0 : -1} aria-selected={scene === s} aria-controls="wb-composer-panel" disabled={locked} onClick={() => changeScene(s)}>{t(`research:scene.${s}.label`)}</button>)}</div>
            <div role="tabpanel" id="wb-composer-panel" aria-labelledby={`scene-${scene}`}><textarea ref={inputRef} aria-label={t('research:wb.questionAria')} value={drafts[scene]} placeholder={inputCfg.placeholder[scene] ?? t(`research:scene.${scene}.hint`)} maxLength={2000} rows={3} onChange={e => setDrafts(d => ({ ...d, [scene]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
              <div className="wb-compose-tools"><div className="wb-context"><label><span className="sr-only">{t('research:wb.symbolAria')}</span><Combobox ariaLabel={t('research:wb.symbolAria')} value={symbol} disabled={locked} onChange={v => { setSymbol(v.toUpperCase()); setPositionId(''); setQuoteId('') }} suggestions={['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']} /></label><label><span className="sr-only">{t('research:wb.horizonAria')}</span><Dropdown ariaLabel={t('research:wb.horizonAria')} value={horizon} disabled={locked} onChange={v => setHorizon(v)} options={(['10m', '30m', '1h', '1d', '1w'] as Horizon[]).map(h => ({ value: h, label: `${h}${h === '1w' ? t('research:wb.h1wSuffix') : ''}` }))} /></label></div>
                <div className="wb-send-tools">{scene !== 'spot' && <button className="wb-tool" disabled={locked} onClick={() => user ? setToolsOpen(true) : login()}>{scene === 'perp' ? (positionId ? t('research:wb.positionLinked') : t('research:wb.positionTools')) : (quoteId ? t('research:wb.quoteLinked') : t('research:wb.quoteTools'))}</button>}<button className="wb-send" aria-label={user ? t('research:wb.sendAria') : t('research:wb.sendLoginAria')} disabled={locked || quota?.remaining === 0 || !drafts[scene].trim()} onClick={() => void send()}>{conv.busy ? '…' : '↑'}</button></div>
              </div>
            </div>
          </div>
          <div className="wb-compose-note">{running ? t('research:wb.noteRunning') : horizon === '1w' ? t('research:wb.note1w') : scene === 'event' && !quoteId ? t('research:wb.noteEventNoQuote') : scene === 'perp' && !positionId ? t('research:wb.notePerpNoPosition') : t('research:wb.noteDefault')}<span>{t('research:wb.enterHint')}</span></div>
        </div>
      </div>
    </main>
    {panel && <>
      {compact && <div className="wb-shade wb-panel-shade" onClick={() => setPanel(null)} />}
      <aside ref={panelRef} tabIndex={-1} className="wb-detail" role={compact ? 'dialog' : 'region'} aria-modal={compact || undefined} aria-label={t('research:wb.detailAria')}>
        {!compact && <div className="wb-resizer" role="separator" aria-label={t('research:wb.resizerAria')} aria-orientation="vertical" aria-valuenow={panelWidth} aria-valuemin={340} aria-valuemax={700} tabIndex={0} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setPanelWidth(w => Math.max(340, Math.min(700, w + (e.key === 'ArrowLeft' ? 20 : -20)))) } }} onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setPanelWidth(Math.max(340, Math.min(700, window.innerWidth - e.clientX))) }} onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)} />}
        <div className="wb-detail-head"><div className="wb-detail-tabs">{(['evidence', 'chart'] as const).map(p => <button key={p} aria-pressed={panel === p} onClick={() => setPanel(p)}>{p === 'evidence' ? t('research:wb.tabEvidence') : t('research:wb.tabChart')}</button>)}</div><button className="wb-icon" aria-label={t('research:wb.closeDetailAria')} onClick={() => setPanel(null)}>✕</button></div>
        <div className="wb-detail-body">{!user ? <p className="wb-caption">{t('research:wb.loginForEvidence')}</p> : !run ? <p className="wb-caption">{t('research:wb.noRunYet')}</p> : <><p className="wb-caption">{t('research:wb.runMeta', { id: run.id.slice(0, 8), symbol: run.symbol })}<br />{new Date(run.asOf).toLocaleString()}</p>{panel === 'evidence' ? <EvidenceDrawer key={run.id} runId={run.id} open embedded selectedEvidenceId={evidenceId} citationIds={citationIds} onClose={() => setPanel(null)} onLocateBar={time => { setHighlightTime(time); setPanel('chart') }} /> : <Suspense fallback={<p role="status">{t('research:wb.loadingChart')}</p>}><WorkbenchChart key={run.id} run={run} result={tracker.result} highlightTime={highlightTime} /></Suspense>}</> }</div>
      </aside>
    </>}
    {toolsOpen && user && <div className="wb-modal-shade" onClick={() => setToolsOpen(false)}><div ref={toolsRef} tabIndex={-1} className="wb-tools-modal" role="dialog" aria-modal="true" aria-label={scene === 'perp' ? t('research:wb.toolsAriaPerp') : t('research:wb.toolsAriaEvent')} onClick={e => e.stopPropagation()}><div className="wb-detail-head"><strong>{scene === 'perp' ? t('research:wb.toolsAriaPerp') : t('research:wb.toolsAriaEvent')} · {symbol}</strong><button className="wb-icon" aria-label={t('research:wb.toolsCloseAria')} onClick={() => setToolsOpen(false)}>✕</button></div><div className="wb-tools-body">{dataError && <p className="err-text" role="alert">{t('research:wb.dataLoadFailed', { msg: dataError })}<button onClick={() => void refreshTools()}>{t('research:wb.retry')}</button></p>}
      <label className="wb-associated">{scene === 'perp' ? t('research:wb.linkPosition') : t('research:wb.linkQuote')}<Dropdown ariaLabel={t('research:wb.linkAria')} value={scene === 'perp' ? positionId : quoteId} onChange={v => scene === 'perp' ? setPositionId(v) : setQuoteId(v)} options={[{ value: '', label: t('research:wb.noLink') }, ...(scene === 'perp' ? positions.filter(p => p.symbol === symbol).map(p => ({ value: p.id, label: `${p.symbol} · ${p.side} · ${p.qty} @ ${p.entryPrice}${p.isStale ? t('research:wb.staleReconfirm') : ''}` })) : quotes.filter(q => q.symbol === symbol).map(q => ({ value: q.id, label: `${q.symbol} · ${q.direction} ${q.strikePrice} · ${new Date(q.expiryAt).toLocaleString()}` })))]} /></label>
      {scene === 'perp' ? <PositionForm symbol={symbol} onSaved={p => { if (composerRef.current.scene === 'perp' && composerRef.current.symbol === p.symbol) setPositionId(p.id); void refreshTools() }} /> : <><QuoteForm symbol={symbol} onSaved={q => { if (composerRef.current.scene === 'event' && composerRef.current.symbol === q.symbol) setQuoteId(q.id); void refreshTools() }} /><SettlementList quotes={quotes.filter(q => q.symbol === symbol)} onChanged={refreshTools} /></>}
      <button className="btn btn-primary wb-tools-done" onClick={() => setToolsOpen(false)}>{t('research:wb.done')}</button>
    </div></div></div>}
  </div>
}

function SettlementList({ quotes, onChanged }: { quotes: EventQuote[]; onChanged: () => Promise<void> }): JSX.Element {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const confirm = async (id: string, outcome: 'above' | 'below' | 'tie'): Promise<void> => {
    setBusy(true); setError('')
    try { await api(`/event-quotes/${id}/confirm`, { method: 'POST', body: { outcome } }); setSelected(''); await onChanged() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="wb-settlement"><h4>{t('research:wb.settlementTitle')}</h4>{error && <p className="err-text" role="alert">{error}</p>}{quotes.length === 0 && <p className="wb-caption">{t('research:wb.noQuotes')}</p>}{quotes.map(q => <div key={q.id}><p>{q.direction === 'above' ? t('research:main.above') : t('research:main.below')} {q.strikePrice} · {new Date(q.expiryAt).toLocaleString()}</p>{q.userConfirmedOutcome ? <span>{t('research:wb.confirmedAs', { value: q.userConfirmedOutcome })}</span> : selected === q.id ? <div role="group" aria-label={t('research:wb.confirmOutcomeAria')}>{(['above', 'below', 'tie'] as const).map(o => <button key={o} disabled={busy} onClick={() => void confirm(q.id, o)}>{o === 'above' ? t('research:main.above') : o === 'below' ? t('research:main.below') : t('research:main.tie')}</button>)}<button disabled={busy} onClick={() => setSelected('')}>{t('research:run.cancel')}</button></div> : <button disabled={busy} onClick={() => setSelected(q.id)}>{t('research:wb.confirmSettlement')}</button>}</div>)}</section>
}
