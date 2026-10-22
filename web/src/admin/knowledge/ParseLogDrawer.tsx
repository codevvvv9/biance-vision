/**
 * W2 解析日志抽屉（docs/knowledge-ui-redesign-plan.md 流程 3，失败下钻 G7）：
 * 单轮=最近一轮的完整 stage 时间线（enqueued→inspect/route→parsing 批次→
 * chunking→embedding→completed/failed），failed 事件红色；
 * 旧文档（事件记录启用前导入）显示降级文案。
 * 数据源 parseMeta.events（W2 第二批按证据调整：不建独立事件表，单轮覆盖语义）。
 */
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { KnowledgeEventsResponse } from 'biance-vision-brooks'
import { StatusBadge } from './ui'

/** stage 分类配色（徽章语义：进行=蓝/路由=紫/完成=绿/失败=红/其他=灰） */
const STAGE_CLS: Record<string, string> = {
  enqueued: 'lg-grey',
  inspect: 'lg-grey',
  route: 'lg-route',
  parsing: 'lg-run',
  chunking: 'lg-run',
  embedding: 'lg-run',
  completed: 'lg-ok',
  failed: 'lg-bad',
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export default function ParseLogDrawer({ docId, onClose }: { docId: string; onClose: () => void }): JSX.Element | null {
  const [data, setData] = useState<KnowledgeEventsResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    setData(null)
    setError('')
    let alive = true
    api<KnowledgeEventsResponse>(`/admin/knowledge/documents/${docId}/events`)
      .then((r) => {
        if (alive) setData(r)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [docId])

  const events = data?.events ?? []
  const startAt = events.length > 0 ? events[0].atMs : 0
  const totalMs = events.length > 0 ? events[events.length - 1].atMs - startAt : null

  return (
    <div className="kb-drawer-overlay" onClick={onClose} role="presentation">
      <aside className="kb-drawer kb-log-drawer" role="dialog" aria-label="解析日志" onClick={(e) => e.stopPropagation()}>
        <div className="kb-drawer-head">
          <div className="kb-drawer-title">
            <strong>解析日志{data !== null ? ` · ${data.title}` : ''}</strong>
            <span className="kb-drawer-meta">
              {data !== null && (
                <>
                  <StatusBadge status={data.status} />
                  {data.runNo > 0 && <span>第 {data.runNo} 次解析</span>}
                  {data.attemptId !== null && <span className="kb-log-attempt">attempt {data.attemptId.slice(0, 8)}</span>}
                  {totalMs !== null && <span>总耗时 {fmtMs(totalMs)}</span>}
                </>
              )}
            </span>
          </div>
          <div className="kb-drawer-actions">
            <button onClick={onClose}>关闭</button>
          </div>
        </div>
        <div className="kb-drawer-body">
          {error !== '' && <p className="err-text">{error}</p>}
          {data === null && error === '' && <p className="muted">加载中…</p>}
          {data !== null && !data.hasEvents && (
            <p className="muted kb-log-empty">
              该文档在事件记录启用前导入，无历史日志。点击「重解析」可产生新轮次的完整事件。
            </p>
          )}
          {events.length > 0 && (
            <ol className="kb-log-timeline">
              {events.map((e) => (
                <li key={`${e.seq}-${e.atMs}`} className={e.stage === 'failed' ? 'kb-log-ev failed' : 'kb-log-ev'}>
                  <span className={`kb-log-stage ${STAGE_CLS[e.stage] ?? 'lg-grey'}`}>{e.stage}</span>
                  <span className="kb-log-msg">{e.message ?? ''}</span>
                  <span className="kb-log-time">
                    +{fmtMs(e.atMs - startAt)}
                    {e.durationMs !== null && e.durationMs !== undefined && e.durationMs > 0 ? ` · 耗时 ${fmtMs(e.durationMs)}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  )
}
