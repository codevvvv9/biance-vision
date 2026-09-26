import { useEffect, useRef, useState } from 'react'
import { useAi } from './AiContext'
import Markdown from './Markdown'
import { api } from '../api'
import { fmtDateTime, lsGet, lsSet } from '../utils'

interface Props {
  onClose: () => void
}

interface Msg {
  role: 'user' | 'assistant'
  content: string
  at?: number
}

interface NewsItem {
  title: string
  url: string
  source: string
  publishedAt: number
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

interface ConversationDetail {
  id: string
  title: string
  messages: Msg[]
}

interface MemoryItem {
  id: string
  kind: 'preference' | 'fact' | 'interest' | 'habit' | 'manual'
  content: string
  createdAt: number
  updatedAt: number
}

const MEMORY_KIND_LABEL: Record<MemoryItem['kind'], string> = {
  preference: '偏好',
  fact: '背景',
  interest: '关注',
  habit: '习惯',
  manual: '手动',
}

/** @ 提及候选（成交额靠前的交易对） */
interface SymItem {
  s: string
  c: string
  P: string
}

/** / 斜杠命令菜单（与服务端 runSlashCommand 的别名对应） */
interface SlashCommand {
  cmd: string
  args: string
  desc: string
}

const COMMANDS: SlashCommand[] = [
  { cmd: '/chart', args: 'SOL 1h', desc: '画 K 线图（币种 周期 条数）' },
  { cmd: '/analyze', args: 'BTC 1d', desc: '技术分析：均线 / RSI / 布林 / 回撤' },
  { cmd: '/movers', args: '涨|跌', desc: '24h 涨跌榜（条形图）' },
  { cmd: '/corr', args: 'BTC ETH', desc: '两币走势相关性' },
  { cmd: '/calc', args: '10000*3%', desc: '计算器：仓位 / 盈亏 / 收益率' },
  { cmd: '/news', args: '', desc: '最新币圈要闻' },
  { cmd: '/remember', args: '内容', desc: '手动记入长期记忆' },
  { cmd: '/forget', args: '关键词|all', desc: '删除相关长期记忆' },
  { cmd: '/mem', args: '', desc: '查看全部长期记忆' },
]

const SUGGESTIONS = [
  '📊 解读当前大盘，给出操作建议',
  '🟡 BTC 后市怎么看？',
  '🔵 ETH 现在适合定投吗？',
  '⚡ 最近涨跌异动的币种，有什么机会和风险？',
]

/** 更新最后一条助手消息的内容（流式追加） */
function appendDelta(msgs: Msg[], delta: string): Msg[] {
  if (msgs.length === 0) return msgs
  const last = msgs[msgs.length - 1]
  if (last.role !== 'assistant') return msgs
  return [...msgs.slice(0, -1), { role: 'assistant', content: last.content + delta }]
}

/** 列表里的相对时间（今天只显示时分，更早显示月日 + 时分） */
function fmtBrief(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const SIZE_KEY = 'bv.aiChatSize'
const MIN_W = 360
const MIN_H = 400

/** 尺寸限制：下限保证头部+输入区可用，上限不超过视口（留边距），另设硬上限 */
function clampSize(w: number, h: number): { w: number; h: number } {
  const maxW = Math.min(Math.max(window.innerWidth - 48, MIN_W), 1400)
  const maxH = Math.min(Math.max(window.innerHeight - 96, MIN_H), 1600)
  return {
    w: Math.round(Math.min(Math.max(w, MIN_W), maxW)),
    h: Math.round(Math.min(Math.max(h, MIN_H), maxH)),
  }
}

function loadSize(): { w: number; h: number } {
  const saved = lsGet<{ w: number; h: number } | null>(SIZE_KEY, null)
  if (saved) return clampSize(saved.w, saved.h)
  return clampSize(560, Math.min(720, window.innerHeight - 96))
}

export default function AiChat({ onClose }: Props): JSX.Element {
  const { status } = useAi()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [news, setNews] = useState<NewsItem[]>([])
  // 会话历史（服务端按用户持久化，关闭窗口 / 刷新后恢复）
  const [convList, setConvList] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // 头部浮层：null 关闭 / history 会话列表 / memory 长期记忆
  const [panel, setPanel] = useState<'history' | 'memory' | null>(null)
  const [memoryList, setMemoryList] = useState<MemoryItem[] | null>(null)
  const [editingMemId, setEditingMemId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // / 命令与 @ 币种菜单（是否展示由输入内容派生；dismiss 在 Esc 后保持关闭直到输入变化）
  const [cmdIdx, setCmdIdx] = useState(0)
  const [atIdx, setAtIdx] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [symbols, setSymbols] = useState<SymItem[]>([])
  // 尺寸：右/下/右下角拖拽改变，localStorage 记忆；最小化收成头部胶囊条
  const [size, setSize] = useState(loadSize)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const [minimized, setMinimized] = useState(false)
  const resizeRef = useRef<{ dir: 'e' | 's' | 'se'; startX: number; startY: number; startW: number; startH: number } | null>(
    null,
  )
  // 最近一次计算出的尺寸：松手时直接持久化，避免 state 异步渲染导致存旧值
  const pendingSizeRef = useRef<{ w: number; h: number } | null>(null)

  // 视口变化时把已有尺寸收回到限制内
  useEffect(() => {
    const onWinResize = (): void => setSize((s) => clampSize(s.w, s.h))
    window.addEventListener('resize', onWinResize)
    return () => window.removeEventListener('resize', onWinResize)
  }, [])

  const startResize = (e: React.PointerEvent<HTMLDivElement>, dir: 'e' | 's' | 'se'): void => {
    if (e.button !== 0) return
    resizeRef.current = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startW: sizeRef.current.w,
      startH: sizeRef.current.h,
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 指针未激活（如合成事件）时忽略，拖拽逻辑仍可用 */
    }
  }
  const moveResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = resizeRef.current
    if (!st) return
    const dw = st.dir === 's' ? 0 : e.clientX - st.startX
    const dh = st.dir === 'e' ? 0 : e.clientY - st.startY
    const next = clampSize(st.startW + dw, st.startH + dh)
    pendingSizeRef.current = next
    setSize(next)
  }
  const endResize = (): void => {
    if (!resizeRef.current) return
    resizeRef.current = null
    lsSet(SIZE_KEY, pendingSizeRef.current ?? sizeRef.current)
    pendingSizeRef.current = null
  }

  const refreshConvList = async (): Promise<ConversationSummary[]> => {
    try {
      const d = await api<{ conversations: ConversationSummary[] }>('/ai/conversations')
      setConvList(d.conversations)
      return d.conversations
    } catch {
      return []
    }
  }

  const loadConversation = async (id: string): Promise<void> => {
    setPanel(null)
    try {
      const d = await api<{ conversation: ConversationDetail }>(`/ai/conversations/${id}`)
      setActiveId(d.conversation.id)
      setMessages(d.conversation.messages)
    } catch {
      /* 会话可能刚被删除：留在当前视图 */
    }
  }

  const removeConversation = async (id: string): Promise<void> => {
    if (!window.confirm('删除该会话及其全部消息？')) return
    try {
      await api(`/ai/conversations/${id}`, { method: 'DELETE' })
      const list = await refreshConvList()
      if (activeId === id) {
        setActiveId(null)
        setMessages([])
        if (list.length > 0) void loadConversation(list[0].id)
      }
    } catch (e) {
      window.alert((e as Error).message)
    }
  }

  const newConversation = (): void => {
    setPanel(null)
    setActiveId(null)
    setMessages([])
  }

  // 打开聊天窗：拉新闻 + @ 候选币种 + 恢复最近一次会话（跨窗口 / 跨设备保持上下文连续）
  useEffect(() => {
    fetch('/api/ai/news')
      .then((r) => (r.ok ? r.json() : { news: [] }))
      .then((d: { news?: NewsItem[] }) => setNews(d.news ?? []))
      .catch(() => {
        /* 新闻失败不影响聊天 */
      })
    fetch('/api/tickers?limit=80')
      .then((r) => (r.ok ? r.json() : { tickers: [] }))
      .then((d: { tickers?: SymItem[] }) => setSymbols(d.tickers ?? []))
      .catch(() => {
        /* @ 菜单退化：无候选则不弹出 */
      })
    void refreshConvList().then((list) => {
      if (list.length > 0) void loadConversation(list[0].id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- / 命令与 @ 提及菜单（是否可见由 input 派生） ----

  const cmdOpen =
    !menuDismissed && input.startsWith('/') && !input.includes(' ') && !streaming
  const cmdFilter = input.slice(1).toLowerCase()
  const cmdMatches = cmdOpen ? COMMANDS.filter((c) => c.cmd.slice(1).toLowerCase().startsWith(cmdFilter)) : []
  const cmdSel = Math.min(cmdIdx, Math.max(cmdMatches.length - 1, 0))

  /** 光标末尾的 @token（简单启发：消息最后一个以 @ 开头的词） */
  const atMatch = /(?:^|\s)@([A-Za-z0-9]*)$/.exec(input)
  const atOpen = !menuDismissed && !!atMatch && !streaming
  const atFilter = (atMatch?.[1] ?? '').toUpperCase()
  const atMatches = atOpen
    ? symbols.filter((t) => t.s.startsWith(atFilter) || t.s.replace(/USDT$/, '').startsWith(atFilter)).slice(0, 8)
    : []
  const atSel = Math.min(atIdx, Math.max(atMatches.length - 1, 0))

  const applyCmd = (c: SlashCommand): void => {
    setInput(`${c.cmd} `)
    setMenuDismissed(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const applySymbol = (s: string): void => {
    setInput(input.replace(/@([A-Za-z0-9]*)$/, `${s.replace(/USDT$/, '')} `))
    setMenuDismissed(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /** 输入框按键：菜单开启时 ↑↓ 选择、Tab/Enter 补全、Esc 关闭；否则 Enter 发送 */
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (cmdOpen && cmdMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIdx((cmdSel + 1) % cmdMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIdx((cmdSel - 1 + cmdMatches.length) % cmdMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
        e.preventDefault()
        applyCmd(cmdMatches[cmdSel])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuDismissed(true)
        return
      }
    } else if (atOpen && atMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtIdx((atSel + 1) % atMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtIdx((atSel - 1 + atMatches.length) % atMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
        e.preventDefault()
        applySymbol(atMatches[atSel].s)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(input)
  }

  /** / 命令：本地直执行（不消耗 AI 对话次数），结果与图表落入会话 */
  const sendCommand = async (text: string): Promise<void> => {
    setInput('')
    setMenuDismissed(false)
    setStreaming(true)
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    try {
      const d = await api<{ conversationId: string; reply: string; chart: unknown }>('/ai/command', {
        method: 'POST',
        body: { conversationId: activeId ?? undefined, text },
      })
      if (d.conversationId && d.conversationId !== activeId) setActiveId(d.conversationId)
      const chartBlock = d.chart ? `\`\`\`chart\n${JSON.stringify(d.chart)}\n\`\`\`\n\n` : ''
      setMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', content: `${chartBlock}${d.reply}` }])
      void refreshConvList()
    } catch (e) {
      setMessages((prev) => appendDelta(prev, `⚠ ${(e as Error).message}`))
    } finally {
      setStreaming(false)
    }
  }

  const send = async (text: string): Promise<void> => {
    const content = text.trim()
    if (!content || streaming) return
    if (content.startsWith('/')) {
      void sendCommand(content)
      return
    }
    setInput('')
    setMenuDismissed(false)
    setStreaming(true)
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: activeId ?? undefined, content }),
      })
      if (!res.ok || !res.body) {
        let detail = `HTTP ${res.status}`
        try {
          detail = ((await res.json()) as { message?: string }).message ?? detail
        } catch {
          /* noop */
        }
        throw new Error(detail)
      }
      // 新建会话的 id 由服务端在响应头回传，后续消息续接同一会话
      const convId = res.headers.get('x-conversation-id')
      if (convId && convId !== activeId) setActiveId(convId)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const delta = decoder.decode(value, { stream: true })
        if (delta) setMessages((prev) => appendDelta(prev, delta))
      }
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant' && last.content.trim() === '') {
          return [...prev.slice(0, -1), { role: 'assistant', content: '（模型返回了空回复，请重试）' }]
        }
        return prev
      })
      void refreshConvList() // 列表顺序 / 标题可能已更新
    } catch (e) {
      const msg = (e as Error).message || '请求失败'
      setMessages((prev) => appendDelta(prev, `⚠ ${msg}`))
    } finally {
      setStreaming(false)
    }
  }

  // ---- 长期记忆面板 ----

  const openMemory = async (): Promise<void> => {
    if (panel === 'memory') {
      setPanel(null)
      return
    }
    setPanel('memory')
    setEditingMemId(null)
    setMemoryList(null)
    try {
      const d = await api<{ memories: MemoryItem[] }>('/ai/memories')
      setMemoryList(d.memories)
    } catch (e) {
      setMemoryList([])
      window.alert((e as Error).message)
    }
  }

  const saveMemory = async (id: string): Promise<void> => {
    const text = editingText.trim()
    if (!text) return
    try {
      await api(`/ai/memories/${id}`, { method: 'PUT', body: { content: text } })
      setMemoryList((prev) =>
        (prev ?? []).map((m) => (m.id === id ? { ...m, content: text, updatedAt: Date.now() } : m)),
      )
      setEditingMemId(null)
    } catch (e) {
      window.alert((e as Error).message)
    }
  }

  const removeMemory = async (id: string): Promise<void> => {
    try {
      await api(`/ai/memories/${id}`, { method: 'DELETE' })
      setMemoryList((prev) => (prev ?? []).filter((m) => m.id !== id))
    } catch (e) {
      window.alert((e as Error).message)
    }
  }

  const clearAllMemories = async (): Promise<void> => {
    if (!window.confirm('清空全部长期记忆？删除后 AI 将不再记得这些偏好。')) return
    try {
      await api('/ai/memories', { method: 'DELETE' })
      setMemoryList([])
    } catch (e) {
      window.alert((e as Error).message)
    }
  }

  // 新内容到达时滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  return (
    <div
      className={`ai-chat${minimized ? ' min' : ''}`}
      role="dialog"
      aria-label="AI 助手对话"
      style={minimized ? undefined : { width: `${size.w}px`, height: `${size.h}px` }}
    >
      <div className="ai-chat-head" onClick={minimized ? () => setMinimized(false) : undefined}>
        <span className="ai-chat-title">
          <span className="ai-avatar" aria-hidden="true">🤖</span>
          AI 助手{status.model ? <em>{status.model}</em> : null}
        </span>
        <span className="ai-chat-tools">
          <button
            className="ai-chat-tool"
            title={minimized ? '展开' : '最小化'}
            onClick={(e) => {
              e.stopPropagation()
              setMinimized((m) => !m)
              setPanel(null)
            }}
          >
            {minimized ? '▢' : '—'}
          </button>
          {!minimized && (
            <>
              <button
                className={`ai-chat-tool${panel === 'history' ? ' on' : ''}`}
                title="历史会话"
                onClick={() => {
                  if (panel === 'history') setPanel(null)
                  else {
                    setPanel('history')
                    void refreshConvList()
                  }
                }}
                disabled={streaming}
              >
                历史
              </button>
              <button
                className={`ai-chat-tool${panel === 'memory' ? ' on' : ''}`}
                title="AI 对你的长期记忆（自动总结，跨会话生效）"
                onClick={() => void openMemory()}
              >
                记忆
              </button>
              <button
                className="ai-chat-tool"
                title="开启新对话（历史会话仍可从「历史」找回）"
                onClick={newConversation}
                disabled={streaming}
              >
                ✚ 新对话
              </button>
            </>
          )}
          <button
            className="ai-chat-tool"
            title="关闭"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            ✕
          </button>
        </span>
      </div>

      {panel === 'history' && (
        <div className="ai-pop">
          <p className="ai-pop-title">🕘 历史会话</p>
          {convList.length === 0 ? (
            <p className="ai-pop-empty">还没有历史会话</p>
          ) : (
            convList.map((c) => (
              <div key={c.id} className={`ai-conv-item${c.id === activeId ? ' on' : ''}`}>
                <button className="ai-conv-main" onClick={() => void loadConversation(c.id)}>
                  <span className="ai-conv-title">{c.title}</span>
                  <span className="ai-conv-meta">
                    {fmtBrief(c.updatedAt)} · {c.messageCount} 条
                  </span>
                </button>
                <button
                  className="ai-conv-del"
                  title="删除会话"
                  onClick={() => void removeConversation(c.id)}
                  disabled={streaming}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {panel === 'memory' && (
        <div className="ai-pop">
          <p className="ai-pop-title">
            🧠 长期记忆
            {memoryList !== null && memoryList.length > 0 && (
              <button className="ai-pop-clear" onClick={() => void clearAllMemories()}>
                清空全部
              </button>
            )}
          </p>
          <p className="ai-pop-hint">AI 从你的对话中自动总结，跨会话生效；可编辑或删除。</p>
          {memoryList === null ? (
            <p className="ai-pop-empty">加载中…</p>
          ) : memoryList.length === 0 ? (
            <p className="ai-pop-empty">
              还没有长期记忆——多聊几句你的偏好、关注的币种，
              <br />
              AI 会自动记住你
            </p>
          ) : (
            memoryList.map((m) => (
              <div key={m.id} className="ai-mem-item">
                <span className={`ai-mem-kind k-${m.kind}`}>{MEMORY_KIND_LABEL[m.kind] ?? m.kind}</span>
                {editingMemId === m.id ? (
                  <span className="ai-mem-edit">
                    <textarea
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      rows={2}
                      autoFocus
                      spellCheck={false}
                    />
                    <button className="ai-mem-act" onClick={() => void saveMemory(m.id)} disabled={!editingText.trim()}>
                      保存
                    </button>
                    <button className="ai-mem-act" onClick={() => setEditingMemId(null)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="ai-mem-content">{m.content}</span>
                    <span className="ai-mem-ops">
                      <button
                        className="ai-mem-act"
                        title="编辑"
                        onClick={() => {
                          setEditingMemId(m.id)
                          setEditingText(m.content)
                        }}
                      >
                        改
                      </button>
                      <button className="ai-mem-act" title="删除" onClick={() => void removeMemory(m.id)}>
                        删
                      </button>
                    </span>
                  </>
                )}
                <span className="ai-mem-time" title={fmtDateTime(m.updatedAt)}>
                  {fmtBrief(m.updatedAt)}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      <div className="ai-msgs" ref={listRef} onClick={() => panel && setPanel(null)}>
        {messages.length === 0 ? (
          <div className="ai-welcome">
            <p className="ai-welcome-hi">你好，我是行情助手 🤖</p>
            <p className="ai-welcome-sub">可解读实时大盘、分析币种走势，也可以随便聊聊。试试：</p>
            <div className="ai-chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="ai-chip" onClick={() => void send(s.slice(2))}>
                  {s}
                </button>
              ))}
              <button className="ai-chip" title="输入 / 唤起全部命令" onClick={() => void sendCommand('/movers 涨')}>
                📈 看涨跌榜（/movers）
              </button>
            </div>
            <p className="ai-welcome-cmd">
              输入 <code>/</code> 唤起命令（画图 · 分析 · 计算器 · 记忆），输入 <code>@</code> 快速提及币种
            </p>
            {news.length > 0 && (
              <div className="ai-news">
                <p className="ai-news-title">📰 币圈要闻</p>
                {news.map((n) => (
                  <a key={n.url} className="ai-news-item" href={n.url} target="_blank" rel="noreferrer">
                    <span className="ai-news-src">{n.source}</span>
                    <span className="ai-news-txt">{n.title}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`ai-bubble ${m.role === 'user' ? 'me' : 'bot'}`}>
              {m.role === 'assistant' ? (
                m.content === '' && streaming ? (
                  <span className="ai-typing">思考中…</span>
                ) : (
                  <Markdown content={m.content} />
                )
              ) : (
                m.content
              )}
            </div>
          ))
        )}
      </div>

      <div className="ai-input-row">
        {cmdOpen && cmdMatches.length > 0 && (
          <div className="ai-cmd-pop">
            {cmdMatches.map((c, i) => (
              <button
                key={c.cmd}
                type="button"
                className={`ai-cmd-item${i === cmdSel ? ' on' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault() // 不让输入框失焦
                  applyCmd(c)
                }}
              >
                <span className="ai-cmd-name">{c.cmd}</span>
                <span className="ai-cmd-desc">{c.desc}</span>
                {c.args && <span className="ai-cmd-args">{c.args}</span>}
              </button>
            ))}
            <p className="ai-cmd-hint">↑↓ 选择 · Tab/Enter 补全 · Esc 关闭 · 直达执行不消耗 AI 次数</p>
          </div>
        )}
        {cmdMatches.length === 0 && atOpen && atMatches.length > 0 && (
          <div className="ai-cmd-pop">
            {atMatches.map((t, i) => {
              const pct = parseFloat(t.P)
              return (
                <button
                  key={t.s}
                  type="button"
                  className={`ai-cmd-item${i === atSel ? ' on' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applySymbol(t.s)
                  }}
                >
                  <span className="ai-cmd-name">{t.s.replace(/USDT$/, '')}</span>
                  <span className="ai-cmd-desc">{t.c}</span>
                  <span className={`ai-cmd-pct ${pct >= 0 ? 'up' : 'down'}`}>
                    {pct >= 0 ? '+' : ''}
                    {pct.toFixed(2)}%
                  </span>
                </button>
              )
            })}
            <p className="ai-cmd-hint">↑↓ 选择 · Tab/Enter 插入 · Esc 关闭</p>
          </div>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setMenuDismissed(false)
            setCmdIdx(0)
            setAtIdx(0)
          }}
          onKeyDown={onInputKeyDown}
          placeholder="提问 · 输入 / 用命令 · @ 提及币种"
          disabled={streaming}
          spellCheck={false}
        />
        <button className="btn btn-sm btn-primary" onClick={() => void send(input)} disabled={streaming || !input.trim()}>
          {streaming ? '…' : '发送'}
        </button>
      </div>
      <p className="ai-disclaim">AI 输出仅供参考，不构成投资建议</p>
      {!minimized && (
        <>
          <div
            className="ai-resize e"
            onPointerDown={(e) => startResize(e, 'e')}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
          <div
            className="ai-resize s"
            onPointerDown={(e) => startResize(e, 's')}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
          <div
            className="ai-resize se"
            onPointerDown={(e) => startResize(e, 'se')}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
        </>
      )}
    </div>
  )
}
