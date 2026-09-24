import { useEffect, useRef, useState } from 'react'
import { useAi } from './AiContext'
import Markdown from './Markdown'
import { api } from '../api'
import { fmtDateTime } from '../utils'

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
  kind: 'preference' | 'fact' | 'interest' | 'habit'
  content: string
  createdAt: number
  updatedAt: number
}

const MEMORY_KIND_LABEL: Record<MemoryItem['kind'], string> = {
  preference: '偏好',
  fact: '背景',
  interest: '关注',
  habit: '习惯',
}

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

  // 打开聊天窗：拉新闻 + 恢复最近一次会话（跨窗口 / 跨设备保持上下文连续）
  useEffect(() => {
    fetch('/api/ai/news')
      .then((r) => (r.ok ? r.json() : { news: [] }))
      .then((d: { news?: NewsItem[] }) => setNews(d.news ?? []))
      .catch(() => {
        /* 新闻失败不影响聊天 */
      })
    void refreshConvList().then((list) => {
      if (list.length > 0) void loadConversation(list[0].id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async (text: string): Promise<void> => {
    const content = text.trim()
    if (!content || streaming) return
    setMessages((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '' }])
    setInput('')
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
    <div className="ai-chat" role="dialog" aria-label="AI 助手对话">
      <div className="ai-chat-head">
        <span className="ai-chat-title">
          <span className="ai-avatar" aria-hidden="true">🤖</span>
          AI 助手{status.model ? <em>{status.model}</em> : null}
        </span>
        <span className="ai-chat-tools">
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
          <button className="ai-chat-tool" title="关闭" onClick={onClose}>
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
            </div>
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
            <div key={i} className={`ai-msg ${m.role === 'user' ? 'me' : 'bot'}`}>
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
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(input)
          }}
          placeholder="问点什么，例如：现在大盘怎么样？"
          disabled={streaming}
          spellCheck={false}
        />
        <button className="btn btn-sm btn-primary" onClick={() => void send(input)} disabled={streaming || !input.trim()}>
          {streaming ? '…' : '发送'}
        </button>
      </div>
      <p className="ai-disclaim">AI 输出仅供参考，不构成投资建议</p>
    </div>
  )
}
