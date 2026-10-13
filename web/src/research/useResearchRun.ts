/**
 * 研究运行 SSE 跟踪 hook（从 ResearchPage.openRun 原样抽出）：
 * - 打开 run：拉详情与已发布结果；非终态则订阅 /api/research/runs/:id/events
 * - 游标重放：同一 run 重开以 ?after= 续发，浏览器自动重连带 Last-Event-ID
 * - 终态（published/failed/cancelled）关闭连接；published 后拉 /result 并回调 onPublished
 * 事件协议（docs/specs/api-storage.md）：step_started/step_completed/run_completed/
 * run_failed/run_cancelled/run_published。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ResearchResult, ResearchRun, RunStepInfo } from 'biance-vision-brooks'

export type SseConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export const SSE_CONN_LABEL: Record<SseConnState, string> = {
  idle: '未订阅',
  connecting: '连接中…',
  open: '已连接',
  reconnecting: '断开重连中…',
  closed: '已断开',
}

export const STEP_LABEL: Record<string, string> = {
  plan: '意图规划',
  snapshot: '行情快照',
  structures: '结构计算',
  retrieve: '知识检索',
  product_analysis: '产品分析',
  countercase: '反证审查',
  validate: '风险校验',
  publish: '发布',
}

export interface UseResearchRunOptions {
  /** run 发布后回调（如刷新持仓/报价/历史列表） */
  onPublished?: () => void
  /** 每次打开 run 时回调（如清空证据高亮、按 run.asOf 冻结图表） */
  onOpen?: (run: ResearchRun) => void
}

export interface ResearchRunTracker {
  activeRun: ResearchRun | null
  steps: RunStepInfo[]
  result: ResearchResult | null
  sseError: string
  sseConn: SseConnState
  openRun: (run: ResearchRun) => void
  cancelRun: () => Promise<void>
  setSseError: (msg: string) => void
}

export function useResearchRun(opts: UseResearchRunOptions = {}): ResearchRunTracker {
  const [activeRun, setActiveRun] = useState<ResearchRun | null>(null)
  const [steps, setSteps] = useState<RunStepInfo[]>([])
  const [result, setResult] = useState<ResearchResult | null>(null)
  const [sseError, setSseError] = useState('')
  /** SSE 连接状态（显式展示，不断言静默重连成功） */
  const [sseConn, setSseConn] = useState<SseConnState>('idle')
  const esRef = useRef<EventSource | null>(null)
  /** SSE 重放游标（事件 id）：同一 run 重新订阅时以 ?after= 续发，避免丢事件/重复事件 */
  const lastSeqRef = useRef<number>(0)
  /** 请求代次（评审 F5）：打开 A 后又打开 B，A 的延迟响应（详情/结果/SSE 回调）不得覆盖 B 的状态 */
  const genRef = useRef(0)
  /** openRun 的 reopen 判定需要最新 activeRun，但不依赖其重建回调 */
  const activeRunRef = useRef<ResearchRun | null>(null)
  activeRunRef.current = activeRun
  const optsRef = useRef(opts)
  optsRef.current = opts

  const openRun = useCallback((run: ResearchRun): void => {
    const gen = ++genRef.current
    const isCurrent = (): boolean => genRef.current === gen
    const reopen = activeRunRef.current?.id === run.id
    setActiveRun(run)
    setSteps([])
    setResult(null)
    setSseError('')
    setSseConn('idle')
    optsRef.current.onOpen?.(run)
    esRef.current?.close()
    // 重新打开同一 run：保留 SSE 游标，以 ?after= 续发（不重放已见事件）
    if (!reopen) lastSeqRef.current = 0
    void api<{ run: ResearchRun; steps: RunStepInfo[] }>(`/research/runs/${run.id}`)
      .then((d) => {
        if (!isCurrent()) return
        setSteps(d.steps)
        setActiveRun(d.run)
      })
      .catch(() => {})
    void api<{ result: ResearchResult }>(`/research/runs/${run.id}/result`)
      .then((d) => {
        if (!isCurrent()) return
        setResult(d.result)
      })
      .catch(() => {
        /* 未发布（409）或进行中：SSE 会推送 */
      })
    if (run.status === 'published') return
    const after = lastSeqRef.current > 0 ? `?after=${lastSeqRef.current}` : ''
    const es = new EventSource(`/api/research/runs/${run.id}/events${after}`)
    esRef.current = es
    setSseConn('connecting')
    es.onopen = () => {
      if (isCurrent()) setSseConn('open')
    }
    const trackSeq = (ev: Event): void => {
      const id = Number((ev as MessageEvent).lastEventId)
      if (Number.isFinite(id) && id > 0) lastSeqRef.current = id
    }
    es.addEventListener('step_started', trackSeq)
    es.addEventListener('step_completed', (ev) => {
      if (!isCurrent()) return
      trackSeq(ev)
      const data = JSON.parse((ev as MessageEvent).data) as { step: string; at: number }
      setSteps((prev) => [...prev.filter((s) => s.step !== data.step), { step: data.step, status: 'completed', endedAt: data.at }])
    })
    es.addEventListener('run_published', (ev) => {
      if (!isCurrent()) return
      trackSeq(ev)
      es.close()
      setSseConn('closed')
      void api<{ result: ResearchResult }>(`/research/runs/${run.id}/result`)
        .then((d) => {
          if (!isCurrent()) return
          setResult(d.result)
        })
        .catch((e: Error) => {
          if (isCurrent()) setSseError(e.message)
        })
      optsRef.current.onPublished?.()
      setActiveRun((prev) => (isCurrent() && prev !== null && prev.id === run.id ? { ...prev, status: 'published' } : prev))
    })
    es.addEventListener('run_failed', (ev) => {
      if (!isCurrent()) return
      trackSeq(ev)
      es.close()
      setSseConn('closed')
      const data = JSON.parse((ev as MessageEvent).data) as { error?: string }
      setSseError(data.error ?? '运行失败')
      setActiveRun((prev) => (prev !== null && prev.id === run.id ? { ...prev, status: 'failed' } : prev))
    })
    es.addEventListener('run_cancelled', (ev) => {
      if (!isCurrent()) return
      trackSeq(ev)
      es.close()
      setSseConn('closed')
      setActiveRun((prev) => (prev !== null && prev.id === run.id ? { ...prev, status: 'cancelled' } : prev))
    })
    es.onerror = () => {
      /* 断线：浏览器自动重连（带 Last-Event-ID 头，服务端按游标重放）；轮询详情兜底 */
      if (isCurrent()) setSseConn(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    }
  }, [])

  const cancelRun = useCallback(async (): Promise<void> => {
    const run = activeRunRef.current
    if (!run) return
    try {
      await api(`/research/runs/${run.id}/cancel`, { method: 'POST' })
    } catch (e) {
      setSseError((e as Error).message)
    }
  }, [])

  useEffect(() => () => esRef.current?.close(), [])

  return { activeRun, steps, result, sseError, sseConn, openRun, cancelRun, setSseError }
}
