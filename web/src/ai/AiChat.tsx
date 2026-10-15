/**
 * 悬浮 AI 助手聊天窗：与研究工作台共用 /api/conversations 链路（useResearchConversation）。
 * 打开时恢复最近会话；发消息带回 runId 时交给 useResearchRun 跟踪 SSE，
 * 进度/结果作为消息流末尾的运行气泡；发布后内联结果卡 + 「在研究工作台打开」链接。
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { ResearchRun } from 'biance-vision-brooks'
import { useAi } from './AiContext'
import { useChatSize } from './useChatSize'
import { useResearchConversation } from '../research/useResearchConversation'
import { useResearchRun } from '../research/useResearchRun'
import { PositionConfirmCard } from '../research/PositionConfirmCard'
import { RunBubble } from '../research/RunBubble'
import MiniMarkdown from '../components/MiniMarkdown'

interface Props {
  onClose: () => void
}

const SUGGESTIONS = [
  'BTC 永续现在是什么结构？还能追多吗？',
  '10 分钟后高于 60000 的事件合约值得参与吗？',
  '什么是铁丝网（Barb Wire）？怎么识别？',
  '帮我录入一笔 BTCUSDT 多头持仓',
]

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
  const { status, pendingPrompt, consumePendingPrompt } = useAi()
  const { size, minimized, setMinimized, resizeHandleProps } = useChatSize()
  // 头部浮层：null 关闭 / history 历史会话
  const [panel, setPanel] = useState<'history' | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const tracker = useResearchRun()
  const conv = useResearchConversation({
    context: null,
    restoreLatest: true,
    onRunCreated: (runId) => void openRunById(runId),
  })

  /** 消息带回 runId → 拉列表定位后交给 tracker 订阅 SSE */
  const openRunById = async (runId: string): Promise<void> => {
    if (tracker.activeRun?.id === runId) return
    try {
      const d = await api<{ runs: ResearchRun[] }>('/research/runs')
      const target = d.runs.find((x) => x.id === runId)
      if (target) tracker.openRun(target)
    } catch {
      /* 列表不可用（DB 中断等）：保持当前视图 */
    }
  }

  /** 运行失败重试：以该 run 自身的 product/symbol/marketType/horizon + 会话里最近一条用户消息重新发起（助手无顶栏上下文） */
  const retryRun = async (): Promise<void> => {
    const failed = tracker.activeRun
    if (failed === null) return
    const lastQuestion = [...conv.messages].reverse().find((m) => m.role === 'user')?.text
    try {
      const r = await api<{ run: ResearchRun }>('/research/runs', {
        method: 'POST',
        body: {
          product: failed.product,
          symbol: failed.symbol,
          marketType: failed.marketType,
          horizon: failed.horizon,
          question: lastQuestion,
        },
      })
      tracker.setSseError('')
      tracker.openRun(r.run)
    } catch (e) {
      tracker.setSseError((e as Error).message)
    }
  }

  // 其他页面注入的待发送消息（如 /brooks 的「AI 解读」）：等会话恢复完成后自动发送
  const sendRef = useRef(conv.send)
  sendRef.current = conv.send
  useEffect(() => {
    if (!pendingPrompt || !conv.ready) return
    consumePendingPrompt()
    void sendRef.current(pendingPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt, conv.ready])

  // 新内容到达时滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conv.messages, conv.busy, tracker.steps, tracker.result])

  const activeRun = tracker.activeRun

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
          AI 研究助手{status.model ? <em>{status.model}</em> : null}
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
                    void conv.refreshConversations()
                  }
                }}
              >
                历史
              </button>
              <button
                className="ai-chat-tool"
                title="开启新对话（历史会话仍可从「历史」找回）"
                onClick={() => {
                  setPanel(null)
                  conv.newConversation()
                }}
                disabled={conv.busy}
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
          {conv.conversations.length === 0 ? (
            <p className="ai-pop-empty">还没有历史会话</p>
          ) : (
            conv.conversations.map((c) => (
              <div key={c.id} className={`ai-conv-item${c.id === conv.convId ? ' on' : ''}`}>
                <button
                  className="ai-conv-main"
                  onClick={() => {
                    setPanel(null)
                    void conv.loadConversation(c.id)
                  }}
                >
                  <span className="ai-conv-title">{c.title !== '' ? c.title : '未命名会话'}</span>
                  <span className="ai-conv-meta">{fmtBrief(c.updatedAt)}</span>
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="ai-msgs" ref={listRef} onClick={() => panel !== null && setPanel(null)}>
        {conv.messages.map((m, i) => (
          <div key={i} className={`ai-bubble ${m.role === 'user' ? 'me' : 'bot'}`}>
            {m.role === 'user' ? m.text : <MiniMarkdown text={m.text} />}
            {m.card !== undefined && (
              <PositionConfirmCard card={m.card} busy={conv.cardBusy === i} onResolve={(confirm) => void conv.resolveCard(i, confirm)} />
            )}
          </div>
        ))}
        {conv.busy && (
          <div className="ai-bubble bot">
            <span className="ai-typing">分析中…</span>
          </div>
        )}
        {activeRun && (
          <RunBubble
            run={activeRun}
            steps={tracker.steps}
            result={tracker.result}
            sseError={tracker.sseError}
            sseConn={tracker.sseConn}
            onCancel={() => void tracker.cancelRun()}
            onRetry={() => void retryRun()}
            footer={
              tracker.result !== null ? (
                <Link className="btn btn-ghost btn-sm" to={`/research?run=${activeRun.id}`} onClick={onClose}>
                  在研究工作台打开
                </Link>
              ) : undefined
            }
          />
        )}
        {conv.messages.length <= 1 && !activeRun && (
          <div className="ai-welcome">
            <p className="ai-welcome-sub">直接描述问题，我会自动识别场景并启动完整研究。试试：</p>
            <div className="ai-chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="ai-chip" onClick={() => void conv.send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="ai-input-row">
        <input
          value={conv.input}
          onChange={(e) => conv.setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void conv.send()
          }}
          placeholder="描述你的问题，自动启动研究…"
          disabled={conv.busy}
          spellCheck={false}
        />
        <button className="btn btn-sm btn-primary" onClick={() => void conv.send()} disabled={conv.busy || conv.input.trim() === ''}>
          {conv.busy ? '…' : '发送'}
        </button>
      </div>
      <p className="ai-disclaim">AI 输出仅供参考，不构成投资建议</p>
      {!minimized && (
        <>
          <div className="ai-resize e" {...resizeHandleProps('e')} />
          <div className="ai-resize s" {...resizeHandleProps('s')} />
          <div className="ai-resize se" {...resizeHandleProps('se')} />
        </>
      )}
    </div>
  )
}
