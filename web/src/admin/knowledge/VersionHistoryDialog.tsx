/**
 * W2 版本历史弹窗（docs/knowledge-ui-redesign-plan.md 流程 5，修 G5）：
 * 列出全部 knowledge_versions（版本号/时间/包含文档数/触发人/备注）；
 * 当前版本标记「生效中」；历史版本「切回此版本」→ 以旧集合发布新版本
 * （POST versions/:id/restore，红线 2：不修改历史记录）。
 */
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { KnowledgeVersionSummary } from 'biance-vision-brooks'

export default function VersionHistoryDialog({
  onClose,
  onRestored,
}: {
  onClose: () => void
  onRestored: () => void
}): JSX.Element | null {
  const [versions, setVersions] = useState<KnowledgeVersionSummary[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    api<{ versions: KnowledgeVersionSummary[] }>('/admin/knowledge/versions')
      .then((r) => {
        if (alive) setVersions(r.versions)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])

  const restore = async (v: KnowledgeVersionSummary): Promise<void> => {
    if (
      !window.confirm(
        `切回 ${v.label}？\n\n将以旧集合发布一个新版本（不修改历史记录），\n当前版本之后产生的变更不会自动丢失（仍可再切回）。`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await api(`/admin/knowledge/versions/${v.id}/restore`, { method: 'POST', body: {} })
      onRestored()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kb-modal-overlay" onClick={onClose} role="presentation">
      <div className="kb-modal" role="dialog" aria-label="版本历史" onClick={(e) => e.stopPropagation()}>
        <div className="kb-modal-head">
          <strong>版本历史</strong>
          <button onClick={onClose}>关闭</button>
        </div>
        {error !== '' && <p className="err-text">{error}</p>}
        {versions === null && error === '' && <p className="muted">加载中…</p>}
        {versions !== null && versions.length === 0 && <p className="muted">尚无发布版本（发布第一份资料后生成）</p>}
        {versions !== null && versions.length > 0 && (
          <table className="kb-ver-table">
            <thead>
              <tr>
                <th>版本</th>
                <th>时间</th>
                <th>文档数</th>
                <th>触发人</th>
                <th>备注</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v, i) => (
                <tr key={v.id}>
                  <td>
                    {v.label}
                    {i === 0 && <span className="kb-ver-live">生效中</span>}
                  </td>
                  <td>{new Date(v.createdAt).toLocaleString()}</td>
                  <td>{v.docCount}</td>
                  <td>{v.createdBy}</td>
                  <td className="kb-ver-note" title={v.note ?? ''}>{v.note ?? '—'}</td>
                  <td>
                    {i !== 0 && (
                      <button disabled={busy} onClick={() => void restore(v)}>
                        切回此版本
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="kb-modal-note">回滚语义：以旧集合发布新版本，历史记录不可变；旧引用始终指向原版本切块。</p>
      </div>
    </div>
  )
}
