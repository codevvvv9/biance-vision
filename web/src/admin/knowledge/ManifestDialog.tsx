/**
 * W2 清单批量导入弹窗（docs/knowledge-ui-redesign-plan.md 流程 6，修 G1）：
 * - 展示 knowledge_manifest_entries 全部条目（标题/URL/导入状态/最近错误）——
 *   状态来自 DB（GET manifest-entries），不再只看构建副本；
 * - 「从默认清单重新同步」：把 default-manifest.json upsert 入库（仅同步条目，不抓取）；
 * - 勾选条目提交导入（POST import-manifest——修 entries 传参即修 400 坏死）；
 *   仅 enabled + url_fetch + public 的条目可勾选/单条重试（受限资料走文件上传，不绕过）；
 * - 导入结果部分失败汇报（新/重复/失败/待上传 + 失败明细）。
 */
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { KnowledgeManifestEntryStatus } from 'biance-vision-brooks'
import defaultManifest from './default-manifest.json'

interface ManifestEntryInput {
  id: string
  url: string
  type: string
  title: string
  topics: string[]
  access: string
  sourceTier: string
  importMethod: string
  enabled: boolean
  notes?: string
}

const DEFAULT_ENTRIES = (defaultManifest as { entries: ManifestEntryInput[] }).entries

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '待导入', cls: 'st-uploaded' },
  imported: { label: '已导入', cls: 'st-published' },
  skipped: { label: '跳过', cls: 'st-parsed' },
  failed: { label: '失败', cls: 'st-failed' },
}

/** 可导入判定：启用 + 自动抓取 + 公开（与后端 import-manifest 的放行分支一致） */
function importable(e: KnowledgeManifestEntryStatus): boolean {
  return e.enabled && e.importMethod === 'url_fetch' && e.access === 'public'
}

export default function ManifestDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }): JSX.Element | null {
  const [entries, setEntries] = useState<KnowledgeManifestEntryStatus[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [summaryMsg, setSummaryMsg] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  useEffect(() => {
    let alive = true
    api<{ entries: KnowledgeManifestEntryStatus[] }>('/admin/knowledge/manifest-entries')
      .then((r) => {
        if (!alive) return
        setEntries(r.entries)
        setSelected(new Set(r.entries.filter(importable).filter((e) => e.status !== 'imported').map((e) => e.id)))
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])

  const reload = async (): Promise<void> => {
    const r = await api<{ entries: KnowledgeManifestEntryStatus[] }>('/admin/knowledge/manifest-entries')
    setEntries(r.entries)
  }

  const syncFromDefault = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const r = await api<{ synced: number; entries: KnowledgeManifestEntryStatus[] }>('/admin/knowledge/manifest-entries/sync', {
        method: 'POST',
        body: { entries: DEFAULT_ENTRIES },
      })
      setEntries(r.entries)
      setSummaryMsg(`已从默认清单同步 ${r.synced} 条（仅更新条目，未抓取内容）`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const importEntries = async (targets: KnowledgeManifestEntryStatus[]): Promise<void> => {
    if (targets.length === 0) return
    setBusy(true)
    setError('')
    setSummaryMsg('导入中（逐条抓取，可能较慢）…')
    try {
      // 提交勾选条目的完整字段（与 default-manifest 同构；url_fetch 自动抓取）——DB 行即真源
      const payload = targets.map((e) => ({
        id: e.id,
        url: e.url,
        type: e.type,
        title: e.title,
        topics: e.topics,
        access: e.access,
        sourceTier: e.sourceTier,
        importMethod: e.importMethod,
        enabled: e.enabled,
        ...(e.notes !== null && e.notes !== '' ? { notes: e.notes } : {}),
      }))
      const r = await api<{ summary: { imported: number; duplicates: number; failed: number; pendingUpload: number }; failures: { id: string; error: string }[] }>(
        '/admin/knowledge/documents/import-manifest',
        { method: 'POST', body: { entries: payload } },
      )
      const s = r.summary
      setSummaryMsg(
        `新 ${s.imported} · 重复 ${s.duplicates} · 失败 ${s.failed} · 待上传 ${s.pendingUpload}`
        + (r.failures.length > 0 ? `；失败明细：${r.failures.map((f) => `${f.id}（${f.error.slice(0, 80)}）`).join('；')}` : ''),
      )
      await reload()
      onImported()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const importableEntries = (entries ?? []).filter(importable)
  const selectedEntries = importableEntries.filter((e) => selected.has(e.id))

  return (
    <div className="kb-modal-overlay" onClick={busy ? undefined : onClose} role="presentation">
      <div className="kb-modal kb-manifest-modal" role="dialog" aria-label="清单批量导入" onClick={(e) => e.stopPropagation()}>
        <div className="kb-modal-head">
          <strong>清单批量导入</strong>
          <div className="kb-side-row">
            <button className="btn" disabled={busy} onClick={() => void syncFromDefault()}>从默认清单重新同步</button>
            <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
          </div>
        </div>
        {error !== '' && <p className="err-text">{error}</p>}
        {summaryMsg !== '' && <p className="kb-side-msg">{summaryMsg}</p>}
        {entries === null && error === '' && <p className="muted">加载中…</p>}
        {entries !== null && entries.length === 0 && (
          <p className="muted">清单为空——先「从默认清单重新同步」入库（维护 docs/references/knowledge-source-manifest.json）。</p>
        )}
        {entries !== null && entries.length > 0 && (
          <table className="kb-ver-table kb-manifest-table">
            <thead>
              <tr>
                <th />
                <th>条目</th>
                <th>方式/级别</th>
                <th>状态</th>
                <th>最近错误</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const meta = STATUS_META[e.status] ?? { label: e.status, cls: 'st-uploaded' }
                const can = importable(e)
                return (
                  <tr key={e.id} className={!e.enabled ? 'kb-row-disabled' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        disabled={!can || busy}
                        onChange={() => toggle(e.id)}
                        aria-label={`选择 ${e.title}`}
                      />
                    </td>
                    <td className="kb-manifest-cell-title">
                      <span className="kb-manifest-title" title={e.url}>{e.title}</span>
                      <span className="kb-manifest-meta">{e.url}</span>
                    </td>
                    <td>
                      {e.importMethod === 'url_fetch' ? '自动抓取' : '需手动上传'} · {e.access}
                      {!e.enabled && ' · 未启用'}
                    </td>
                    <td>
                      <span className={`kb-status ${meta.cls}`}><i />{meta.label}</span>
                    </td>
                    <td className="kb-manifest-cell-err" title={e.lastError ?? ''}>{e.lastError ?? '—'}</td>
                    <td>
                      {can && (e.status === 'failed' || e.status === 'skipped') && (
                        <button disabled={busy} onClick={() => void importEntries([e])}>重试</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <div className="kb-upload-footer">
          <span className="muted">已选 {selectedEntries.length} / 可导入 {importableEntries.length} 条（受限资料走文件上传，不在此列）</span>
          <button
            className="btn btn-primary"
            disabled={busy || selectedEntries.length === 0}
            onClick={() => void importEntries(selectedEntries)}
          >
            {busy ? '导入中…' : `导入勾选条目（${selectedEntries.length}）`}
          </button>
        </div>
        <p className="kb-modal-note">导入即逐条抓取 URL（服务端判重/失败落状态）；user_upload 与非 public 条目保持跳过——商业资料仅上传有使用权的文件。</p>
      </div>
    </div>
  )
}
