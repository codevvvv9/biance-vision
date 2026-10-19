/**
 * 运行气泡：研究 run 的 SSE 步骤进度与结果卡，内联在对话消息流末尾。
 * 研究工作台右栏与悬浮 AI 助手共用（状态来自 useResearchRun）。
 * P1-7：step_detail 过程播报子步骤行（真实状态/计数，非思维链）与
 * security_interrupt 安全中断横幅；P1-1：场景徽章；P1-3：追问动作透传给结果卡。
 */
import type { ReactNode } from 'react'
import type { FollowUpAction, ResearchResult, ResearchRun, RunStepInfo } from 'biance-vision-brooks'
import { SSE_CONN_LABEL, STEP_LABEL } from './useResearchRun'
import type { SseConnState, SecurityInterruptInfo, StepDetailRow } from './useResearchRun'
import { ResultCard } from './ResearchResult'

interface Props {
  run: ResearchRun
  steps: RunStepInfo[]
  result: ResearchResult | null
  sseError: string
  sseConn: SseConnState
  /** P0-5 受控降级（task_degraded 事件）：显示降级横幅；正常运行为 null */
  degraded?: { code: string; handling: string; reason: string } | null
  /** P1-7 过程播报行（step_detail 事件）；缺省不渲染（旧调用方兼容） */
  details?: StepDetailRow[]
  /** P1-7 安全中断（security_interrupt 事件）；缺省不渲染 */
  securityInterrupt?: SecurityInterruptInfo | null
  onCancel: () => void
  /** 失败后以相同标的与期限重新发起（研究台与悬浮助手均提供） */
  onRetry?: () => void
  /** 结果卡下方附加操作（如「查看证据」「在研究工作台打开」） */
  footer?: ReactNode
  onCitation?: (evidenceId: string) => void
  /** P1-3 结构化追问分发器（提供时结果卡渲染动作 chips） */
  onFollowUp?: (action: FollowUpAction) => void
}

const DEGRADED_LABEL: Record<string, string> = {
  repair_exhausted: '修复预算耗尽，已剔除未经校验的归纳内容',
  data_stale: '数据过期',
  model_unpublished: '模型未发布',
  quote_missing: '报价缺失',
}

/** P1-1 任务场景徽章（与服务端 scenes.ts 标签同源） */
const SCENE_LABEL: Record<string, string> = {
  'hold-review': '持仓复查',
  'structure-scan': '结构扫描',
  'concept-teach': '概念教学',
  'quote-review': '报价评估',
  'replay-analysis': '历史复盘',
  'news-attribution': '消息归因',
}

const DETAIL_KIND_ICON: Record<string, string> = {
  llm_call: '⚙',
  retrieval_variant: '⌕',
  repair_loop: '↻',
  evidence_frozen: '❄',
  structure_claim: '⌁',
  synthesis: '✎',
}

export function RunBubble({ run, steps, result, sseError, sseConn, degraded, details, securityInterrupt, onCancel, onRetry, footer, onCitation, onFollowUp }: Props): JSX.Element {
  const active = run.status !== 'published' && run.status !== 'failed' && run.status !== 'cancelled'
  const sceneLabel = run.sceneCode !== undefined ? SCENE_LABEL[run.sceneCode] : undefined
  return (
    <div
      className={`run-bubble rb-${run.status}${active ? ' fx-beam fx-pulse-line' : ''}`}
      role="status"
      aria-label={`研究运行 ${run.id.slice(0, 8)} 状态 ${run.status}`}
    >
      <div className="run-bubble-head">
        <strong>运行 {run.id.slice(0, 8)}</strong>
        {sceneLabel !== undefined && <span className="scene-badge">{sceneLabel}</span>}
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
      {details !== undefined && details.length > 0 && (
        <ul className="step-detail-list" aria-label="过程状态">
          {details.map((d) => (
            <li key={d.key} className={`sd-${d.status}`}>
              <span aria-hidden>{DETAIL_KIND_ICON[d.kind] ?? '·'}</span> {d.label}
              {d.count !== undefined ? `（${d.count}）` : ''}
              {d.status === 'finished' ? ' ✓' : '…'}
            </li>
          ))}
        </ul>
      )}
      {securityInterrupt != null && (
        <p className="security-banner" role="alert">
          安全中断（{securityInterrupt.code}）：{securityInterrupt.reason}——本次运行已停止，请重新发起。
        </p>
      )}
      {sseError !== '' && <p className="err-text">{sseError}</p>}
      {degraded !== null && degraded !== undefined && (
        <p className="degraded-note" role="status">
          受控降级：{DEGRADED_LABEL[degraded.code] ?? degraded.code}
          {degraded.reason !== '' ? `（${degraded.reason.slice(0, 200)}）` : ''}
        </p>
      )}
      {run.error !== undefined && run.error !== '' && <p className="err-text">{run.error}</p>}
      {run.status === 'failed' && onRetry !== undefined && (
        <button className="btn btn-primary btn-sm" aria-label="以相同标的与期限重新发起研究" onClick={onRetry}>
          重新发起（相同标的与期限）
        </button>
      )}
      {result !== null && run.status === 'published' && <ResultCard result={result} horizon={run.horizon} runId={run.id} onCitation={onCitation} onFollowUp={onFollowUp} />}
      {footer}
    </div>
  )
}
