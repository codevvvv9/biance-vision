/**
 * W2 差异轮询（docs/knowledge-ui-redesign-plan.md 流程 2，替换 3s 全量轮询）：
 * - 存在非终态文档时每 2s 调轻量端点 documents/statuses（只传 id，只回投影）；
 * - 任一 status 与基线快照不同（含 gone=被删）才触发一次全量 refresh；
 * - 全部终态自动停（effect 依赖 pending 集合）；请求失败静默待下轮；
 * - worker 心跳缺失 + 存在 uploaded 排队 → workerDead=true，页面渲染黄条（G6）。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../../../api'
import type { KnowledgeDocument, KnowledgeStatusesResponse } from 'biance-vision-brooks'

const TERMINAL = new Set(['indexed', 'published', 'failed'])
const POLL_MS = 2_000
/** uploaded 停留阈值（statuses 的 ageMs；方案要求 60s） */
const UPLOADED_STUCK_MS = 60_000

export function useDocPolling(
  docs: KnowledgeDocument[],
  refresh: () => void,
): { workerDead: boolean } {
  const [workerDead, setWorkerDead] = useState(false)
  /** 基线快照：id → status（refresh 后由 docs 同步，轮询 diff 由此判定） */
  const baselineRef = useRef<Map<string, string>>(new Map())
  /** refresh 引用 latest，避免轮询 effect 因闭包陈旧而刷旧数据 */
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // pending 集合（触发轮询的面）与快照同步都在这里：docs 每次全量刷新后重建基线
  const pendingIds = docs.filter((d) => !TERMINAL.has(d.status)).map((d) => d.id)
  const pendingKey = pendingIds.join(',')
  useEffect(() => {
    const next = new Map<string, string>()
    for (const d of docs) if (!TERMINAL.has(d.status)) next.set(d.id, d.status)
    baselineRef.current = next
  }, [docs])

  useEffect(() => {
    if (pendingKey === '') {
      setWorkerDead(false)
      return
    }
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const ids = pendingKey.split(',').slice(0, 100).join(',')
        const r = await api<KnowledgeStatusesResponse>(`/admin/knowledge/documents/statuses?ids=${encodeURIComponent(ids)}`)
        if (!alive) return
        // 心跳黄条：worker 不活 + 有 uploaded 排队且停留超阈值（另一入口：本地 dev 未起 worker）
        const stuck = r.statuses.some((s) => s.status === 'uploaded' && s.ageMs > UPLOADED_STUCK_MS)
        setWorkerDead(!r.worker.alive && stuck)
        const base = baselineRef.current
        const flipped = r.statuses.some((s) => base.get(s.id) !== s.status)
        if (flipped) refreshRef.current()
      } catch {
        /* 轮询失败静默待下轮（流程 2） */
      }
    }
    const t = setInterval(() => void tick(), POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [pendingKey])

  return { workerDead }
}
