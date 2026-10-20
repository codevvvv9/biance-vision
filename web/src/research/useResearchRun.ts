/**
 * 研究运行 SSE 跟踪 hook（从 ResearchPage.openRun 原样抽出）：
 * - 打开 run：拉详情与已发布结果；非终态则订阅 /api/research/runs/:id/events
 * - 游标重放：同一 run 重开以 ?after= 续发，浏览器自动重连带 Last-Event-ID
 * - 终态（published/failed/cancelled）关闭连接；published 后拉 /result 并回调 onPublished
 * 事件协议（docs/specs/api-storage.md）：step_started/step_completed/run_completed/
 * run_failed/run_cancelled/run_published。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import i18n from '../i18n'
import { api } from '../api'
import type { ResearchResult, ResearchRun, RunStepInfo } from 'biance-vision-brooks'

export type SseConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/** SSE 连接状态 → research:sse.* 词典 key（调用方用 t() 取当前语言文案） */
export const SSE_CONN_KEYS: Record<SseConnState, string> = {
  idle: 'research:sse.idle',
  connecting: 'research:sse.connecting',
  open: 'research:sse.open',
  reconnecting: 'research:sse.reconnecting',
  closed: 'research:sse.closed',
}

export function sseConnLabel(state: SseConnState): string {
  return i18n.t(SSE_CONN_KEYS[state])
}

/** 阶段 → research:step.* 词典 key */
export const STEP_KEYS: Record<string, string> = {
  plan: 'research:step.plan',
  snapshot: 'research:step.snapshot',
  structures: 'research:step.structures',
  retrieve: 'research:step.retrieve',
  product_analysis: 'research:step.product_analysis',
  countercase: 'research:step.countercase',
  synthesis: 'research:step.synthesis',
  validate: 'research:step.validate',
  publish: 'research:step.publish',
}

export function stepLabel(step: string): string {
  return i18n.t(STEP_KEYS[step] ?? step)
}

/** P1-7 过程播报行（step_detail 事件）：真实阶段/工具状态/计数（服务端承诺无正文） */
export interface StepDetailRow {
  key: string
  step: string
  kind: string
  label: string
  status: 'started' | 'finished'
  count?: number
}

/** P1-7 安全中断（security_interrupt 事件）：仅 version_mismatch 硬中断场景 */
export interface SecurityInterruptInfo {
  code: string
  reason: string
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
  /** P0-5 受控降级（task_degraded 事件）：修复耗尽等场景的降级说明；正常运行为 null */
  degraded: { code: string; handling: string; reason: string } | null
  /** P1-7 过程播报行（step_detail 事件；真实状态与计数，非思维链） */
  details: StepDetailRow[]
  /** P1-7 安全中断（security_interrupt 事件）；正常运行为 null */
  securityInterrupt: SecurityInterruptInfo | null
  openRun: (run: ResearchRun) => void
  clearRun: () => void
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
  /** P0-5 受控降级（task_degraded）：随 run 生命周期，openRun 清空 */
  const [degraded, setDegraded] = useState<ResearchRunTracker['degraded']>(null)
  /** P1-7 过程播报行（step_detail）：按 step+kind 键 upsert，openRun 清空 */
  const [details, setDetails] = useState<StepDetailRow[]>([])
  /** P1-7 安全中断（security_interrupt）：version_mismatch 硬中断横幅，openRun 清空 */
  const [securityInterrupt, setSecurityInterrupt] = useState<SecurityInterruptInfo | null>(null)
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
    activeRunRef.current = run
    setActiveRun(run)
    setSteps([])
    setResult(null)
    setSseError('')
    setDegraded(null)
    setDetails([])
    setSecurityInterrupt(null)
    setSseConn('idle')
    optsRef.current.onOpen?.(run)
    esRef.current?.close()
    // 重新打开同一 run：保留 SSE 游标，以 ?after= 续发（不重放已见事件）
    if (!reopen) lastSeqRef.current = 0
    void api<{ run: ResearchRun; steps: RunStepInfo[] }>(`/research/runs/${run.id}`)
      .then((d) => {
        if (!isCurrent()) return
        setSteps(d.steps)
        setActiveRun(prev => prev?.id === d.run.id && ['published', 'failed', 'cancelled'].includes(prev.status) ? prev : d.run)
      })
      .catch((e: Error) => { if (isCurrent()) setSseError(i18n.t("research:run.detailLoadFailed", { msg: e.message })) })
    void api<{ result: ResearchResult }>(`/research/runs/${run.id}/result`)
      .then((d) => {
        if (!isCurrent()) return
        setResult(d.result)
      })
      .catch((e: Error) => {
        if (isCurrent() && run.status === 'published') setSseError(i18n.t("research:run.publishedLoadFailed", { msg: e.message }))
      })
    if (['published', 'failed', 'cancelled'].includes(run.status)) return
    const after = lastSeqRef.current > 0 ? `?after=${lastSeqRef.current}` : ''
    const es = new EventSource(`/api/research/runs/${run.id}/events${after}`)
    esRef.current = es
    setSseConn('connecting')
    es.onopen = () => {
      if (isCurrent()) setSseConn('open')
    }
    const trackSeq = (ev: Event): void => {
      if (!isCurrent()) return
      const id = Number((ev as MessageEvent).lastEventId)
      if (Number.isFinite(id) && id > 0) lastSeqRef.current = id
    }
    es.addEventListener('step_started', trackSeq)
    es.addEventListener('step_started', (ev) => {
      if (!isCurrent()) return
      const data = JSON.parse((ev as MessageEvent).data) as { step: string; at: number }
      setSteps((prev) => [...prev.filter((s) => s.step !== data.step), { step: data.step, status: 'running', startedAt: data.at }])
    })
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
      setSseError(data.error ?? i18n.t("research:run.failed"))
      setActiveRun((prev) => (prev !== null && prev.id === run.id ? { ...prev, status: 'failed' } : prev))
    })
    // P0-5 受控降级（红线 #4：新增事件类型；旧版本前端未注册此 listener 天然忽略）
    es.addEventListener('task_degraded', (ev) => {
      if (!isCurrent()) return
      trackSeq(ev)
      const data = JSON.parse((ev as MessageEvent).data) as { payload?: { code?: string; handling?: string; reason?: string } }
      if (data.payload !== undefined) setDegraded({ code: data.payload.code ?? 'unknown', handling: data.payload.handling ?? 'partial_output', reason: data.payload.reason ?? '' })
    })
    // P1-7 过程播报（step_detail）：真实阶段/工具状态/计数，按 step+kind upsert 覆盖
    es.addEventListener('step_detail', (ev) => {
      if (!isCurrent()) return
      trackSeq(ev)
      const data = JSON.parse((ev as MessageEvent).data) as { payload?: { step?: string; kind?: string; label?: string; status?: 'started' | 'finished'; detail?: { count?: number } } }
      const p = data.payload
      if (p === undefined || p.step === undefined || p.kind === undefined) return
      const row: StepDetailRow = {
        key: `${p.step}:${p.kind}`,
        step: p.step,
        kind: p.kind,
        label: p.label ?? p.kind,
        status: p.status ?? 'finished',
        ...(p.detail?.count !== undefined ? { count: p.detail.count } : {}),
      }
      setDetails((prev) => {
        const next = [...prev.filter((r) => r.key !== row.key), row]
        return next.length > 14 ? next.slice(next.length - 14) : next
      })
    })
    // P1-7 安全中断（security_interrupt）：version_mismatch 硬中断醒目横幅
    es.addEventListener('security_interrupt', (ev) => {
      if (!isCurrent()) return
      trackSeq(ev)
      const data = JSON.parse((ev as MessageEvent).data) as { payload?: { code?: string; reason?: string } }
      if (data.payload !== undefined) setSecurityInterrupt({ code: data.payload.code ?? 'version_mismatch', reason: data.payload.reason ?? '' })
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
    const gen = genRef.current
    try {
      await api(`/research/runs/${run.id}/cancel`, { method: 'POST' })
    } catch (e) {
      if (gen === genRef.current) setSseError((e as Error).message)
    }
  }, [])

  const clearRun = useCallback((): void => {
    ++genRef.current
    esRef.current?.close()
    esRef.current = null
    activeRunRef.current = null
    lastSeqRef.current = 0
    setActiveRun(null)
    setResult(null)
    setSteps([])
    setSseError('')
    setDegraded(null)
    setDetails([])
    setSecurityInterrupt(null)
    setSseConn('idle')
  }, [])

  // Terminal state may have been committed before a disconnected browser sees its final SSE.
  useEffect(() => {
    if (!activeRun || ['published', 'failed', 'cancelled'].includes(activeRun.status)) return
    const id = activeRun.id
    const gen = genRef.current
    let polling = false
    const timer = setInterval(() => {
      if (polling) return
      polling = true
      void api<{ run: ResearchRun; steps: RunStepInfo[] }>(`/research/runs/${id}`)
        .then(async d => {
          if (gen !== genRef.current) return
          setSteps(d.steps)
          if (!['published', 'failed', 'cancelled'].includes(d.run.status)) return
          esRef.current?.close(); setSseConn('closed'); setActiveRun(d.run)
          if (d.run.status === 'published') {
            const r = await api<{ result: ResearchResult }>(`/research/runs/${id}/result`)
            if (gen === genRef.current) { setResult(r.result); setSseError(''); optsRef.current.onPublished?.() }
          }
        })
        .catch((e: Error) => { if (gen === genRef.current) setSseError(i18n.t("research:run.syncFailed", { msg: e.message })) })
        .finally(() => { polling = false })
    }, 5000)
    return () => clearInterval(timer)
  }, [activeRun?.id, activeRun?.status])

  useEffect(() => () => { ++genRef.current; esRef.current?.close() }, [])

  return { activeRun, steps, result, sseError, sseConn, degraded, details, securityInterrupt, openRun, clearRun, cancelRun, setSseError }
}
