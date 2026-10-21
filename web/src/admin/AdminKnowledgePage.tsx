/**
 * /admin/knowledge 知识库管理（超管）：
 * 导入（拖拽多文件 / URL / manifest）→ 文档卡片栅格（状态机流转）→ 预览抽屉（分块 md / 原文原生渲染）
 * → 检索调试（流水线打点 + 命中卡片）→ 规则卡 / 案例窗。
 * 有文档处于解析中时每 3s 轮询刷新，解析完成后自动停止。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { KnowledgeDocument } from 'biance-vision-brooks'
import CasesPanel from './knowledge/CasesPanel'
import DocGrid from './knowledge/DocGrid'
import ImportZone from './knowledge/ImportZone'
import PreviewDrawer from './knowledge/PreviewDrawer'
import RuleCardsPanel from './knowledge/RuleCardsPanel'
import SearchDebugPanel from './knowledge/SearchDebugPanel'

export default function AdminKnowledgePage(): JSX.Element {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ documents: KnowledgeDocument[] }>('/admin/knowledge/documents')
      setDocs(r.documents)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 排队中的文档（uploaded=已入队未被 worker 领取 / parsing=解析中）都要轮询：
  // 只盯 parsing 会让上传后读到的 uploaded 停在原状态，任务开始与完成都不再刷新
  const pending = docs.some((d) => d.status === 'uploaded' || d.status === 'parsing')
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [pending, refresh])

  const stats = useMemo(() => {
    const by = (s: string): number => docs.filter((d) => d.status === s).length
    return [
      { label: '资料', value: docs.length, cls: '' },
      { label: '已发布', value: by('published'), cls: 'ok' },
      { label: '待发布', value: by('indexed'), cls: 'warn' },
      { label: '解析中', value: by('parsing'), cls: 'info' },
      { label: '失败', value: by('failed'), cls: 'bad' },
    ]
  }, [docs])

  const reparse = async (id: string): Promise<void> => {
    try {
      await api(`/admin/knowledge/documents/${id}/reparse`, { method: 'POST' })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const publish = async (id: string): Promise<void> => {
    try {
      await api(`/admin/knowledge/documents/${id}/publish`, { method: 'POST', body: {} })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const shown = statusFilter === '' ? docs : docs.filter((d) => d.status === statusFilter)

  return (
    <div className="admin-page">
      <div className="admin-head fx-in">
        <div className="admin-head-side">
          <span className="admin-head-title">知识库管理</span>
          <div className="kb-stats">
            {stats.map((s) => (
              <span key={s.label} className={`kb-stat ${s.cls}`}>
                <b>{s.value}</b> {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {error !== '' && <p className="err-text">{error}</p>}

      <ImportZone onDone={() => void refresh()} />

      <DocGrid
        docs={shown}
        statusFilter={statusFilter}
        onFilter={setStatusFilter}
        onPreview={setPreviewId}
        onReparse={(id) => void reparse(id)}
        onPublish={(id) => void publish(id)}
      />

      <SearchDebugPanel onError={setError} />
      <RuleCardsPanel onError={setError} />
      <CasesPanel onError={setError} />

      {previewId !== null && (
        <PreviewDrawer docId={previewId} onClose={() => setPreviewId(null)} onChanged={() => void refresh()} />
      )}
    </div>
  )
}
