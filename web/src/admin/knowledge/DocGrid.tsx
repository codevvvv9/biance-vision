/**
 * 文档卡片栅格：每篇资料一张卡（类型图标 / 状态徽章 / 来源与版本 / 行内操作），
 * 点击卡片开预览抽屉。失败卡红边显示原因；解析中徽章脉冲。
 * 栅格容器挂一个聚光监听（useSpotlight），卡片加 .fx-spot 即获得跟随光标微光。
 */
import { useRef, useState, type CSSProperties } from 'react'
import type { KnowledgeDocument } from 'biance-vision-brooks'
import { useSpotlight } from '../../components/fx/useSpotlight'
import { FileIcon, StatusBadge, TierBadge } from './ui'

interface DocGridProps {
  docs: KnowledgeDocument[]
  statusFilter: string
  onFilter: (status: string) => void
  onPreview: (id: string) => void
  onReparse: (id: string) => void
  onPublish: (id: string) => void
  onDelete: (id: string, purge?: boolean) => void
  onBatch: (action: 'publish' | 'reparse' | 'delete', ids: string[]) => void
  /** W2：打开解析日志抽屉（失败/解析中卡可见入口） */
  onLogs: (id: string) => void
  /** W2：打开版本历史弹窗 */
  onVersions: () => void
}

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'published', label: '已发布' },
  { key: 'indexed', label: '待发布' },
  { key: 'parsing', label: '解析中' },
  { key: 'failed', label: '失败' },
]

export default function DocGrid({ docs, statusFilter, onFilter, onPreview, onReparse, onPublish, onDelete, onBatch, onLogs, onVersions }: DocGridProps): JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useSpotlight(gridRef)
  const counts = new Map<string, number>()
  for (const d of docs) counts.set(d.status, (counts.get(d.status) ?? 0) + 1)
  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const selectedIds = [...selected]
  return (
    <div className="panel kb-docs-panel fx-in" style={{ '--fx-i': 2 } as CSSProperties}>
      <div className="kb-docs-head">
        <h4>资料库（{docs.length}）</h4>
        <button className="kb-ver-entry" onClick={onVersions}>版本历史 ▾</button>
        <div className="kb-filter" role="tablist" aria-label="按状态筛选">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={statusFilter === f.key}
              className={statusFilter === f.key ? 'on' : ''}
              onClick={() => onFilter(f.key)}
            >
              {f.label}
              {f.key !== '' ? ` ${counts.get(f.key) ?? 0}` : ''}
            </button>
          ))}
        </div>
      </div>
      {selectedIds.length > 0 && (
        <div className="kb-batch-bar">
          <span>已选 {selectedIds.length} 项</span>
          <button onClick={() => { onBatch('publish', selectedIds); setSelected(new Set()) }}>批量发布</button>
          <button onClick={() => { onBatch('reparse', selectedIds); setSelected(new Set()) }}>批量重解析</button>
          <button className="danger" onClick={() => { if (window.confirm(`确认删除 ${selectedIds.length} 个文档？（归档，不影响历史引用）`)) { onBatch('delete', selectedIds); setSelected(new Set()) } }}>批量删除</button>
          <button onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      )}
      {docs.length === 0 ? (
        <p className="muted kb-empty">暂无资料——用上方导入区上传文件或导入 URL</p>
      ) : (
        <div className="kb-doc-grid" ref={gridRef}>
          {docs.map((d) => (
            <div
              key={d.id}
              className={`kb-doc-card fx-spot st-border-${d.status}${selected.has(d.id) ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`预览 ${d.title}`}
              onClick={() => onPreview(d.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onPreview(d.id)
              }}
            >
              <div className="kb-doc-top">
                <input
                  type="checkbox"
                  checked={selected.has(d.id)}
                  onChange={() => toggleSelect(d.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`选择 ${d.title}`}
                />
                <FileIcon doc={d} />
                <div className="kb-doc-title-wrap">
                  <span className="kb-doc-title" title={d.title}>{d.title}</span>
                  <span className="kb-doc-sub">
                    {new Date(d.createdAt).toLocaleDateString()} · 版本 #{d.version}
                  </span>
                </div>
                <StatusBadge status={d.status} error={d.error} />
              </div>
              <div className="kb-doc-badges">
                <TierBadge tier={d.sourceTier} access={d.access} />
                <span className="kb-badge">{d.sourceType === 'file' ? '文件' : d.sourceType === 'url' ? 'URL' : '清单'}</span>
              </div>
              {d.status === 'failed' && d.error !== undefined && d.error !== '' && (
                <p className="kb-doc-error" title={d.error}>⚠ {d.error}</p>
              )}
              <div className="kb-doc-acts" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => onPreview(d.id)}>预览</button>
                {(d.status === 'failed' || d.status === 'parsing' || d.status === 'uploaded' || d.status === 'parsed' || d.status === 'chunked') && (
                  <button className={d.status === 'failed' ? 'kb-log-btn' : ''} onClick={() => onLogs(d.id)}>日志</button>
                )}
                {d.status !== 'parsing' && <button onClick={() => onReparse(d.id)}>重解析</button>}
                {d.status === 'indexed' && (
                  <button className="btn-primary" onClick={() => onPublish(d.id)}>发布</button>
                )}
                <button
                  className="danger"
                  onClick={() => {
                    if (window.confirm(`确认删除「${d.title}」？\n\n默认归档（从当前发布集合移除，历史引用保留）。\n如需彻底清除（含切块与向量），请勾选 purge 后确认。`)) {
                      onDelete(d.id)
                    }
                  }}
                >删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
