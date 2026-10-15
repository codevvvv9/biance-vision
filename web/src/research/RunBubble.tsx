/**
 * 运行气泡：研究 run 的 SSE 步骤进度与结果卡，内联在对话消息流末尾。
 * 研究工作台右栏与悬浮 AI 助手共用（状态来自 useResearchRun）。
 */
import type { ReactNode } from 'react'
import type { ResearchResult, ResearchRun, RunStepInfo } from 'biance-vision-brooks'
import { SSE_CONN_LABEL, STEP_LABEL } from './useResearchRun'
import type { SseConnState } from './useResearchRun'
import { ResultCard } from './ResearchResult'

interface Props {
  run: ResearchRun
  steps: RunStepInfo[]
  result: ResearchResult | null
  sseError: string
  sseConn: SseConnState
  onCancel: () => void
  /** 失败后以相同标的与期限重新发起（研究台与悬浮助手均提供） */
  onRetry?: () => void
  /** 结果卡下方附加操作（如「查看证据」「在研究工作台打开」） */
  footer?: ReactNode
}

export function RunBubble({ run, steps, result, sseError, sseConn, onCancel, onRetry, footer }: Props): JSX.Element {
  const active = run.status !== 'published' && run.status !== 'failed' && run.status !== 'cancelled'
  return (
    <div
      className={`run-bubble rb-${run.status}${active ? ' fx-beam fx-pulse-line' : ''}`}
      role="status"
      aria-label={`研究运行 ${run.id.slice(0, 8)} 状态 ${run.status}`}
    >
      <div className="run-bubble-head">
        <strong>运行 {run.id.slice(0, 8)}</strong>
        <span className={`run-status st-${run.status}`}>{run.status}</span>
        <span className={`conn-badge conn-${sseConn}`} aria-label={`SSE 连接状态：${SSE_CONN_LABEL[sseConn]}`}>
          SSE：{SSE_CONN_LABEL[sseConn]}
        </span>
        {active && (
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      {steps.length > 0 && (
        <ol className="step-list">
          {steps.map((s) => (
            <li key={s.step} className={s.status}>
              {STEP_LABEL[s.step] ?? s.step}
              {s.status === 'completed' && ' ✓'}
            </li>
          ))}
        </ol>
      )}
      {sseError !== '' && <p className="err-text">{sseError}</p>}
      {run.error !== undefined && run.error !== '' && <p className="err-text">{run.error}</p>}
      {run.status === 'failed' && onRetry !== undefined && (
        <button className="btn btn-primary btn-sm" aria-label="以相同参数重新发起研究" onClick={onRetry}>
          重新发起（相同标的与期限）
        </button>
      )}
      {result !== null && <ResultCard result={result} horizon={run.horizon} runId={run.id} />}
      {footer}
    </div>
  )
}
