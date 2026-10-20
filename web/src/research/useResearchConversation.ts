/**
 * 研究会话状态 hook（从 ResearchPage 聊天逻辑抽出，悬浮 AI 助手复用同一链路）：
 * - 会话：POST /conversations 懒建（或 restoreLatest 恢复最近会话）；历史消息 GET /conversations/:id/messages
 * - 发消息：POST /conversations/:id/messages（202：assistant 回复即时返回；runId 由调用方交给 useResearchRun 跟踪）
 * - 上下文：顶栏选择变化时 PATCH /conversations/:id/context（context 为 null 时跳过，悬浮窗无顶栏）
 * - 确认卡：confirm_position 内联卡片，「确认写入」PATCH context（positionDraft+confirm）后才落库
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import i18n from '../i18n'
import { api } from '../api'

/** 会话确认卡（confirm_position）：未经确认不落库，卡片内联在消息流中 */
export interface PositionDraftCard {
  kind: 'confirm_position'
  draft: Record<string, unknown>
  /** 缺失的必填槽位（评审 F6：不齐时不可确认，提示用户补齐） */
  missingFields?: string[]
  /** 草稿字段是否齐全（false 时确认按钮禁用） */
  complete?: boolean
  /** archived = 从历史会话恢复的旧卡（服务端不存确认态），只读展示不再可操作 */
  state: 'pending' | 'confirmed' | 'cancelled' | 'archived'
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  runId?: string
  card?: PositionDraftCard
}

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
  context?: Partial<ConversationContextSync>
}

/** 顶栏同步进会话上下文的字段（与 PATCH /conversations/:id/context 契约一致） */
export interface ConversationContextSync {
  symbol: string
  marketType: string
  horizon: string
  product: string
  positionId: string
  quoteId: string
}

interface ServerMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  runId: string | null
  card: { kind: string; draft: Record<string, unknown>; missingFields?: string[]; complete?: boolean } | null
}

export interface UseResearchConversationOptions {
  /** Public workbench must never load private conversations or send anonymous requests. */
  enabled?: boolean
  /** 顶栏上下文（变化时 PATCH）；null = 不同步（悬浮助手无顶栏） */
  context?: ConversationContextSync | null
  /** 首条助手问候语 */
  greeting?: string
  /** 挂载时恢复最近会话（含历史消息） */
  restoreLatest?: boolean
  /** 恢复后仍无会话时立即创建空会话 */
  ensureOnMount?: boolean
  /** 消息带回 runId 时回调（调用方负责 openRun 跟踪 SSE） */
  onRunCreated?: (runId: string) => void
  onConversationCreated?: (conversationId: string) => void
  /** 确认卡落库后回调（如刷新持仓列表） */
  onPositionsChanged?: () => void
}

/** 问候语跟随 UI 语言（hook 内非组件上下文，直接读 i18n 实例） */
const DEFAULT_GREETING = (): string => i18n.t('research:conv.welcome')

function toChatMessage(m: ServerMessage): ChatMessage | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null
  const card =
    m.card?.kind === 'confirm_position' && m.card.draft !== null && m.card.draft !== undefined
      ? {
          kind: 'confirm_position' as const,
          draft: m.card.draft,
          state: 'archived' as const,
          ...(m.card.missingFields !== undefined ? { missingFields: m.card.missingFields } : {}),
          ...(m.card.complete !== undefined ? { complete: m.card.complete } : {}),
        }
      : undefined
  return { role: m.role, text: m.content, runId: m.runId ?? undefined, ...(card !== undefined ? { card } : {}) }
}

export function useResearchConversation(options: UseResearchConversationOptions = {}) {
  const { enabled = true, context = null, greeting = DEFAULT_GREETING(), restoreLatest = false, ensureOnMount = false } = options
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'assistant', text: greeting }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /** 确认卡逐个防抖（进行中的卡片序号） */
  const [cardBusy, setCardBusy] = useState<number | null>(null)
  const [convId, setConvId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [historyError, setHistoryError] = useState('')
  const [loadingConversation, setLoadingConversation] = useState(false)
  const generation = useRef(0)
  const sending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++generation.current }
  }, [])
  /** 恢复/建会话完成前不消费 pendingPrompt（避免消息发到新建空会话） */
  const [ready, setReady] = useState(!restoreLatest && !ensureOnMount)
  /** 已同步到会话上下文的顶栏选择（变化时才 PATCH；确认卡落库的引用不经过这里，不会被覆盖） */
  const syncedCtxRef = useRef<ConversationContextSync | null>(null)
  const optsRef = useRef(options)
  optsRef.current = options

  const refreshConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    if (!enabled) return []
    try {
      const d = await api<{ conversations: ConversationSummary[] }>('/conversations')
      if (!mounted.current) return []
      setConversations(d.conversations)
      setHistoryError('')
      return d.conversations
    } catch (e) {
      if (mounted.current) setHistoryError((e as Error).message)
      return []
    }
  }, [enabled])

  const loadConversation = useCallback(async (id: string): Promise<boolean> => {
    if (!enabled || sending.current) return false
    const gen = ++generation.current
    setLoadingConversation(true)
    try {
      const d = await api<{ messages: ServerMessage[] }>(`/conversations/${encodeURIComponent(id)}/messages`)
      if (gen !== generation.current) return false
      const restored = d.messages.map(toChatMessage).filter((m): m is ChatMessage => m !== null)
      setConvId(id)
      syncedCtxRef.current = null // 换会话后下次发消息重新同步顶栏上下文
      setMessages(restored.length > 0 ? restored : [{ role: 'assistant', text: greeting }])
      setHistoryError('')
      return true
    } catch (e) {
      if (gen === generation.current) setHistoryError((e as Error).message)
      return false
    } finally {
      if (gen === generation.current) setLoadingConversation(false)
    }
  }, [enabled, greeting])

  const newConversation = useCallback((): void => {
    if (sending.current) return
    ++generation.current
    setLoadingConversation(false)
    setHistoryError('')
    setConvId(null)
    syncedCtxRef.current = null
    setMessages([{ role: 'assistant', text: greeting }])
  }, [greeting])

  // 恢复最近会话；无历史且 ensureOnMount 时立即创建空会话
  useEffect(() => {
    if (!enabled || (!restoreLatest && !ensureOnMount)) return
    let alive = true
    void (async () => {
      const list = await refreshConversations()
      if (!alive) return
      if (restoreLatest && list.length > 0) {
        await loadConversation(list[0].id)
      } else if (ensureOnMount) {
        try {
          const c = await api<{ conversation: { id: string } }>('/conversations', { method: 'POST', body: {} })
          if (alive) setConvId(c.conversation.id)
        } catch {
          /* 建会话失败：发送时再懒建 */
        }
      }
      if (alive) setReady(true)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = useCallback(
    async (raw?: string): Promise<boolean> => {
      const message = (raw ?? input).trim()
      if (!enabled || message === '' || sending.current || loadingConversation) return false
      sending.current = true
      setInput('')
      setMessages((prev) => [...prev, { role: 'user', text: message }])
      setBusy(true)
      try {
        let cid = convId
        if (cid === null) {
          const c = await api<{ conversation: { id: string } }>('/conversations', { method: 'POST', body: {} })
          cid = c.conversation.id
          if (mounted.current) {
            setConvId(cid)
            optsRef.current.onConversationCreated?.(cid)
          }
        }
        // 顶栏全部状态同步进会话上下文（新会话必同步；之后仅变化时）——
        // 聊天启动的研究由此定位正确行情：切了交易对/期限/场景再聊天，
        // 不带交易对措辞的消息也按顶栏当前值研究（消息里明写交易对时仍以消息为准）
        const ctx = context
        if (ctx !== null) {
          const synced = syncedCtxRef.current
          const changed =
            synced === null ||
            synced.positionId !== ctx.positionId ||
            synced.quoteId !== ctx.quoteId ||
            synced.symbol !== ctx.symbol ||
            synced.marketType !== ctx.marketType ||
            synced.horizon !== ctx.horizon ||
            synced.product !== ctx.product
          if (changed) {
            await api(`/conversations/${cid}/context`, {
              method: 'PATCH',
              body: {
                symbol: ctx.symbol,
                marketType: ctx.marketType,
                horizon: ctx.horizon,
                product: ctx.product,
                positionId: ctx.positionId,
                quoteId: ctx.quoteId,
              },
            })
            syncedCtxRef.current = { ...ctx }
          }
        }
        const r = await api<{ message: { content: string; runId: string | null; card: { kind: string; draft: Record<string, unknown>; missingFields?: string[]; complete?: boolean } | null }; runId: string | null }>(
          `/conversations/${cid}/messages`,
          { method: 'POST', body: { message } },
        )
        const reply = r.message?.content ?? ''
        const runId = r.message?.runId ?? r.runId ?? null
        const cardData =
          r.message?.card?.kind === 'confirm_position' && r.message.card.draft !== null && r.message.card.draft !== undefined
            ? r.message.card
            : null
        if (!mounted.current) return true
        // 确认卡内联进消息流（不再 window.confirm）：用户点「确认写入」后才 PATCH context 落库
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: reply,
            runId: runId ?? undefined,
            ...(cardData !== null
              ? {
                  card: {
                    kind: 'confirm_position' as const,
                    draft: cardData.draft,
                    state: 'pending' as const,
                    ...(cardData.missingFields !== undefined ? { missingFields: cardData.missingFields } : {}),
                    ...(cardData.complete !== undefined ? { complete: cardData.complete } : {}),
                  },
                }
              : {}),
          },
        ])
        if (runId !== null) optsRef.current.onRunCreated?.(runId)
        void refreshConversations()
        return true
      } catch (e) {
        if (mounted.current) setMessages((prev) => [...prev, { role: 'assistant', text: i18n.t('research:conv.error', { msg: (e as Error).message }) }])
        return false
      } finally {
        sending.current = false
        if (mounted.current) setBusy(false)
      }
    },
    [input, enabled, loadingConversation, convId, context, refreshConversations],
  )

  /** 确认卡：确认写入 → PATCH context（服务端校验字段并落 portfolio）；取消 → 仅标记，不落库 */
  const resolveCard = useCallback(
    async (idx: number, confirm: boolean): Promise<void> => {
      const msg = messages[idx]
      if (msg?.card === undefined || msg.card.state !== 'pending' || cardBusy !== null) return
      // 草稿未齐不可确认（评审 F6：补齐字段后才能写入）
      if (confirm && msg.card.complete === false) return
      if (!confirm) {
        setMessages((prev) => [
          ...prev.map((m, i) => (i === idx && m.card !== undefined ? { ...m, card: { ...m.card, state: 'cancelled' as const } } : m)),
          { role: 'assistant', text: i18n.t('research:conv.cancelledDraft') },
        ])
        // 取消同时清除服务端待补齐草稿（评审附注：后续消息的槽位不再合并进已取消草稿）
        if (convId !== null) {
          void api(`/conversations/${convId}/context`, { method: 'PATCH', body: { draft: null } }).catch(() => {})
        }
        return
      }
      if (convId === null) return
      setCardBusy(idx)
      try {
        const r = await api<{ confirmedPositionId: string | null }>(`/conversations/${convId}/context`, {
          method: 'PATCH',
          body: { positionDraft: msg.card.draft, confirm: true },
        })
        setMessages((prev) => [
          ...prev.map((m, i) => (i === idx && m.card !== undefined ? { ...m, card: { ...m.card, state: 'confirmed' as const } } : m)),
          {
            role: 'assistant',
            text: i18n.t('research:conv.positionConfirmed', {
              id: r.confirmedPositionId !== null ? i18n.t('research:conv.positionConfirmedId', { id: r.confirmedPositionId.slice(0, 8) }) : '',
            }),
          },
        ])
        optsRef.current.onPositionsChanged?.()
      } catch (e) {
        setMessages((prev) => [...prev, { role: 'assistant', text: i18n.t('research:conv.positionConfirmFailed', { msg: (e as Error).message }) }])
      } finally {
        setCardBusy(null)
      }
    },
    [messages, cardBusy, convId],
  )

  return {
    messages,
    input,
    setInput,
    busy,
    cardBusy,
    convId,
    ready,
    conversations,
    historyError,
    loadingConversation,
    refreshConversations,
    loadConversation,
    newConversation,
    send,
    resolveCard,
  }
}
