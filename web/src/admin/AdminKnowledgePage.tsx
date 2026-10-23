/**
 * /admin/knowledge 知识库管理（超管）：
 * 上传队列弹窗（W2 第三批：三道校验/串行/放弃回滚；URL/清单同窗 Tab）→ 文档卡片栅格
 * （状态机流转）→ 预览抽屉（分块 md / 原文原生渲染）→ 解析日志抽屉（stage 时间线失败下钻）
 * → 检索调试 → 规则卡 / 案例窗 → 版本历史弹窗 + 清单批量导入弹窗（条目状态/重试/勾选导入）。
 * W2 第二批：3s 全量轮询替换为差异轮询（useDocPolling——2s 轻量 statuses，
 * 状态翻转才全量刷新，全终态自动停；worker 心跳缺失时顶部黄条）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { KnowledgeDocument } from 'biance-vision-brooks'
import CasesPanel from './knowledge/CasesPanel'
import DocGrid from './knowledge/DocGrid'
import ManifestDialog from './knowledge/ManifestDialog'
import ParseLogDrawer from './knowledge/ParseLogDrawer'
import PreviewDrawer from './knowledge/PreviewDrawer'
import RuleCardsPanel from './knowledge/RuleCardsPanel'
import SearchDebugPanel from './knowledge/SearchDebugPanel'
import UploadDialog from './knowledge/UploadDialog'
import VersionHistoryDialog from './knowledge/VersionHistoryDialog'
import { useDocPolling } from './knowledge/hooks/useDocPolling'

export default function AdminKnowledgePage(): JSX.Element {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [logsId, setLogsId] = useState<string | null>(null)
  const [showVersions, setShowVersions] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [showManifest, setShowManifest] = useState(false)

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

  // W2 差异轮询（流程 2）：轻量 statuses 检测翻转；全终态自动停；worker 失联黄条
  const { workerDead } = useDocPolling(docs, () => void refresh())

  /** 操作后 1.5s 补刷一次（覆盖 pending→parsing 亚秒窗口，流程 2） */
  const refreshSoon = useCallback((): void => {
    setTimeout(() => void refresh(), 1500)
  }, [refresh])

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
      refreshSoon()
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

  const deleteDoc = async (id: string, purge = false): Promise<void> => {
    try {
      await api(`/admin/knowledge/documents/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const batchAction = async (action: 'publish' | 'reparse' | 'delete', ids: string[]): Promise<void> => {
    try {
      const r = await api<{ succeeded: string[]; failed: { id: string; error: string }[] }>('/admin/knowledge/documents/batch', {
        method: 'POST',
        body: { action, ids },
      })
      const msg = `成功 ${r.succeeded.length}` + (r.failed.length > 0 ? `，失败 ${r.failed.length}（${r.failed[0]?.error.slice(0, 100)}）` : '')
      setError(msg)
      await refresh()
      if (action === 'reparse') refreshSoon()
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
        <div className="admin-head-actions">
          <button className="btn btn-primary" onClick={() => setShowUpload(true)}>+ 上传资料</button>
          <button className="btn" onClick={() => setShowManifest(true)}>清单导入</button>
        </div>
      </div>
      {error !== '' && <p className="err-text">{error}</p>}
      {workerDead && (
        <div className="kb-warn-bar" role="alert">
          解析队列不可用：worker 未运行（心跳缺失）。新上传的文档会停留在「待解析」，请启动 worker 后自动恢复。
        </div>
      )}

      <DocGrid
        docs={shown}
        statusFilter={statusFilter}
        onFilter={setStatusFilter}
        onPreview={setPreviewId}
        onReparse={(id) => void reparse(id)}
        onPublish={(id) => void publish(id)}
        onDelete={(id, purge) => void deleteDoc(id, purge)}
        onBatch={(action, ids) => void batchAction(action, ids)}
        onLogs={setLogsId}
        onVersions={() => setShowVersions(true)}
      />

      <SearchDebugPanel onError={setError} />
      <RuleCardsPanel onError={setError} />
      <CasesPanel onError={setError} />

      {previewId !== null && (
        <PreviewDrawer docId={previewId} onClose={() => setPreviewId(null)} onChanged={() => void refresh()} />
      )}
      {logsId !== null && <ParseLogDrawer docId={logsId} onClose={() => setLogsId(null)} />}
      {showVersions && (
        <VersionHistoryDialog
          onClose={() => setShowVersions(false)}
          onRestored={() => {
            setError('已切回旧版本（以旧集合生成了新版本）')
            void refresh()
          }}
        />
      )}
      {showUpload && (
        <UploadDialog
          onClose={() => setShowUpload(false)}
          onDone={() => {
            void refresh()
            refreshSoon()
          }}
          onOpenManifest={() => {
            setShowUpload(false)
            setShowManifest(true)
          }}
        />
      )}
      {showManifest && (
        <ManifestDialog
          onClose={() => setShowManifest(false)}
          onImported={() => {
            void refresh()
            refreshSoon()
          }}
        />
      )}
    </div>
  )
}
