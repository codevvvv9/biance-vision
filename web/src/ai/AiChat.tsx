/**
 * 悬浮 AI 助手聊天窗：与研究工作台共用 /api/conversations 链路（useResearchConversation）。
 * 打开时恢复最近会话；发消息带回 runId 时交给 useResearchRun 跟踪 SSE，
 * 进度/结果作为消息流末尾的运行气泡；发布后内联结果卡 + 「在研究工作台打开」链接。
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import type { ResearchRun } from 'biance-vision-brooks'
import { useAi } from './AiContext'
import { useChatSize } from './useChatSize'
import { useResearchConversation } from '../research/useResearchConversation'
import { useResearchRun } from '../research/useResearchRun'
import { PositionConfirmCard } from '../research/PositionConfirmCard'
import { RunBubble } from '../research/RunBubble'
import MiniMarkdown from '../components/MiniMarkdown'
import { MessageTranslate } from '../research/MessageTranslate'

interface Props {
  onClose: () => void
}

/** 建议问题走 ai:chat.suggestions 词典（returnObjects 数组） */

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
  const { t } = useTranslation()
  const suggestions = t('ai:chat.suggestions', { returnObjects: true }) as string[]
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

  /** run 失败重试 / 追问重跑（2026-10-20 评审 #3/#4 第二轮同口径）：优先从 run.input
   * （创建请求快照）恢复原研究上下文；无 input 的旧 run 退回最近一条用户消息。
   * asOfNow=true（事件「临近到期重估」interval:'same'）按当前时刻重估同一报价；
   * horizon=下一档（perp「换个周期」interval:'next'）。 */
  const rerunFrom = async (opts: { horizon?: ResearchRun['horizon']; asOfNow?: boolean } = {}): Promise<void> => {
    const failed = tracker.activeRun
    if (failed === null) return
    const src = (failed.input ?? {}) as Partial<NonNullable<ResearchRun['input']>>
    const lastQuestion = [...conv.messages].reverse().find((m) => m.role === 'user')?.text
    try {
      const r = await api<{ run: ResearchRun }>('/research/runs', {
        method: 'POST',
        body: {
          product: failed.product,
          symbol: failed.symbol,
          marketType: failed.marketType,
          horizon: opts.horizon ?? failed.horizon,
          question: typeof src.question === 'string' ? src.question : lastQuestion,
          positionId: typeof src.positionId === 'string' ? src.positionId : undefined,
          quoteId: typeof src.quoteId === 'string' ? src.quoteId : undefined,
          positionOverride: src.positionOverride,
          asOf: opts.asOfNow === true ? undefined : (typeof src.asOf === 'number' ? src.asOf : failed.asOf),
          sceneCode: failed.sceneCode,
        },
      })
      tracker.setSseError('')
      tracker.openRun(r.run)
    } catch (e) {
      tracker.setSseError((e as Error).message)
    }
  }

  const retryRun = async (): Promise<void> => { await rerunFrom() }

  /** P1-3 结构化追问（2026-10-20 评审 #7/#4）：悬浮助手无抽屉/表单——证据与上下文类动作
   * 跳转研究台处理；重跑与反证检索在本会话内完成。rerun_with 按 interval 分语义：
   * 'next'=换下一档周期重跑（perp），'same'=事件到期临近重估（当前时刻重估同一报价） */
  const onFollowUp = (a: import('biance-vision-brooks').FollowUpAction): void => {
    const target = tracker.activeRun
    if (a.action === 'open_evidence' || a.action === 'open_rule_card' || a.action === 'switch_context') {
      onClose()
      window.location.assign(`/research?run=${encodeURIComponent(target?.id ?? '')}`)
      return
    }
    if (a.action === 'rerun_with') {
      const interval = (a.parameters?.interval as string | undefined) ?? 'next'
      if (interval === 'same') { void rerunFrom({ asOfNow: true }); return }
      const order: ResearchRun['horizon'][] = ['10m', '30m', '1h', '1d', '1w']
      void rerunFrom({ horizon: order[(order.indexOf(target?.horizon ?? '1h') + 1) % order.length] })
      return
    }
    if (a.action === 'counter_search') {
      void conv.send(t('ai:chat.counterFollowUp', { symbol: target?.symbol ?? '', horizon: target?.horizon ?? '' }))
      return
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
      aria-label={t('ai:chat.aria')}
      style={minimized ? undefined : { width: `${size.w}px`, height: `${size.h}px` }}
    >
      <div className="ai-chat-head" onClick={minimized ? () => setMinimized(false) : undefined}>
        <span className="ai-chat-title">
          <span className="ai-avatar" aria-hidden="true">🤖</span>
          {t('ai:chat.title')}{status.model ? <em>{status.model}</em> : null}
        </span>
        <span className="ai-chat-tools">
          <button
            className="ai-chat-tool"
            title={minimized ? t('ai:chat.expand') : t('ai:chat.minimize')}
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
                title={t('ai:chat.history')}
                onClick={() => {
                  if (panel === 'history') setPanel(null)
                  else {
                    setPanel('history')
                    void conv.refreshConversations()
                  }
                }}
              >
                {t('ai:chat.historyShort')}
              </button>
              <button
                className="ai-chat-tool"
                title={t('ai:chat.newChatTitle')}
                onClick={() => {
                  setPanel(null)
                  conv.newConversation()
                }}
                disabled={conv.busy}
              >
                {t('ai:chat.newChat')}
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
          <p className="ai-pop-title">{t('ai:chat.historyPopTitle')}</p>
          {conv.conversations.length === 0 ? (
            <p className="ai-pop-empty">{t('ai:chat.historyEmpty')}</p>
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
                  <span className="ai-conv-title">{c.title !== '' ? c.title : t('ai:chat.untitled')}</span>
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
            {m.text !== '' && <MessageTranslate text={m.text} />}
            {m.card !== undefined && (
              <PositionConfirmCard card={m.card} busy={conv.cardBusy === i} onResolve={(confirm) => void conv.resolveCard(i, confirm)} />
            )}
          </div>
        ))}
        {conv.busy && (
          <div className="ai-bubble bot">
            <span className="ai-typing">{t('ai:chat.typing')}</span>
          </div>
        )}
        {activeRun && (
          <RunBubble
            run={activeRun}
            steps={tracker.steps}
            result={tracker.result}
            sseError={tracker.sseError}
            sseConn={tracker.sseConn}
            degraded={tracker.degraded}
            details={tracker.details}
            securityInterrupt={tracker.securityInterrupt}
            onCancel={() => void tracker.cancelRun()}
            onRetry={() => void retryRun()}
            onFollowUp={onFollowUp}
            footer={
              tracker.result !== null ? (
                <Link className="btn btn-ghost btn-sm" to={`/research?run=${activeRun.id}`} onClick={onClose}>
                  {t('ai:chat.openInWorkbench')}
                </Link>
              ) : undefined
            }
          />
        )}
        {conv.messages.length <= 1 && !activeRun && (
          <div className="ai-welcome">
            <p className="ai-welcome-sub">{t('ai:chat.welcomeSub')}</p>
            <div className="ai-chips">
              {suggestions.map((s) => (
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
          placeholder={t('ai:chat.placeholder')}
          disabled={conv.busy}
          spellCheck={false}
        />
        <button className="btn btn-sm btn-primary" onClick={() => void conv.send()} disabled={conv.busy || conv.input.trim() === ''}>
          {conv.busy ? '…' : t('ai:chat.send')}
        </button>
      </div>
      <p className="ai-disclaim">{t('ai:chat.disclaim')}</p>
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
