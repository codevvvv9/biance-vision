/**
 * 文档预览抽屉（侧滑）：
 * - 「分块」页签：切块卡片列表（MiniMarkdown 渲染，不再裸 pre），逐块可拉全文
 * - 「原文」页签：PDF/HTML 走浏览器原生渲染（blob URL + iframe），MD 按 Markdown 展示，
 *   TXT 纯文本，DOCX 提示下载（浏览器无法原生预览）；URL/manifest 导入无本地文件时如实提示
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import type { KnowledgeDocument } from 'biance-vision-brooks'
import MiniMarkdown from '../../components/MiniMarkdown'
import { FileIcon, StatusBadge, TierBadge } from './ui'

interface PreviewChunk {
  chunkId: string
  pageNo?: number
  figureId?: string
  kind: string
  text: string
}

interface DocPreview {
  document: KnowledgeDocument
  parseMeta: Record<string, unknown>
  chunks: PreviewChunk[]
  vector: { support: string; note: string }
}

/** 预览接口把 text 截到 400 字符；恰好等长视为可能截断，提供拉全文入口 */
const TRUNCATED_LEN = 400

interface RawLoad {
  state: 'loading' | 'iframe' | 'markdown' | 'text' | 'unsupported' | 'missing' | 'error'
  url?: string
  text?: string
  message?: string
}

export default function PreviewDrawer({ docId, onClose, onChanged }: { docId: string; onClose: () => void; onChanged: () => void }): JSX.Element | null {
  const [preview, setPreview] = useState<DocPreview | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'chunks' | 'raw'>('chunks')
  const [full, setFull] = useState<Record<string, string>>({})
  const [raw, setRaw] = useState<RawLoad | null>(null)
  /** 原文是否已发起过加载（ref 不触发 effect 重跑，避免清掉 in-flight 请求的 alive 标记） */
  const rawRequestedRef = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    setPreview(null)
    setError('')
    setTab('chunks')
    setFull({})
    setRaw(null)
    rawRequestedRef.current = false
    let alive = true
    api<DocPreview>(`/admin/knowledge/documents/${docId}/preview`)
      .then((p) => {
        if (alive) setPreview(p)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [docId])

  // 原文页签按需加载（首次切入时拉取一次），按响应 content-type 选渲染方式；blob URL 卸载时回收
  useEffect(() => {
    if (tab !== 'raw' || rawRequestedRef.current) return
    rawRequestedRef.current = true
    let alive = true
    let objectUrl: string | null = null
    setRaw({ state: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(`/api/admin/knowledge/documents/${docId}/file`)
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string }
          if (!alive) return
          setRaw(res.status === 404 ? { state: 'missing', message: data.message ?? '原始文件不存在' } : { state: 'error', message: data.message ?? `HTTP ${res.status}` })
          return
        }
        const ct = res.headers.get('content-type') ?? ''
        if (ct.startsWith('application/pdf') || ct.startsWith('text/html')) {
          objectUrl = URL.createObjectURL(await res.blob())
          if (alive) setRaw({ state: 'iframe', url: objectUrl })
        } else if (ct.startsWith('text/markdown')) {
          if (alive) setRaw({ state: 'markdown', text: await res.text() })
        } else if (ct.startsWith('text/plain')) {
          if (alive) setRaw({ state: 'text', text: await res.text() })
        } else {
          if (alive) setRaw({ state: 'unsupported' })
        }
      } catch (e) {
        if (alive) setRaw({ state: 'error', message: (e as Error).message })
      }
    })()
    return () => {
      alive = false
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [tab, docId])

  const loadFull = async (chunkId: string): Promise<void> => {
    try {
      const r = await api<{ chunk: { text: string } }>(`/admin/knowledge/chunks/${chunkId}`)
      setFull((prev) => ({ ...prev, [chunkId]: r.chunk.text }))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const doc = preview?.document
  const reparse = async (): Promise<void> => {
    setError('')
    try {
      await api(`/admin/knowledge/documents/${docId}/reparse`, { method: 'POST' })
      onChanged()
      const p = await api<DocPreview>(`/admin/knowledge/documents/${docId}/preview`)
      setPreview(p)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const publish = async (): Promise<void> => {
    setError('')
    try {
      await api(`/admin/knowledge/documents/${docId}/publish`, { method: 'POST', body: {} })
      onChanged()
      const p = await api<DocPreview>(`/admin/knowledge/documents/${docId}/preview`)
      setPreview(p)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="kb-drawer-overlay" onClick={onClose} role="presentation">
      <aside className="kb-drawer" role="dialog" aria-label={`预览 ${doc?.title ?? ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="kb-drawer-head">
          {doc !== null && doc !== undefined && <FileIcon doc={doc} size="lg" />}
          <div className="kb-drawer-title">
            <strong>{doc?.title ?? '加载中…'}</strong>
            <span className="kb-drawer-meta">
              {doc !== null && doc !== undefined && (
                <>
                  <StatusBadge status={doc.status} error={doc.error} />
                  <TierBadge tier={doc.sourceTier} access={doc.access} />
                  <span className="kb-badge">版本 #{doc.version}</span>
                  <span className="kb-badge">{doc.sourceType === 'file' ? '文件上传' : doc.sourceType === 'url' ? 'URL 导入' : '清单导入'}</span>
                </>
              )}
            </span>
          </div>
          <div className="kb-drawer-actions">
            {doc !== null && doc !== undefined && doc.status !== 'parsing' && (
              <button className="btn btn-ghost" onClick={() => void reparse()}>重解析</button>
            )}
            {doc?.status === 'indexed' && (
              <button className="btn btn-primary" onClick={() => void publish()}>发布上线</button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="关闭预览">✕</button>
          </div>
        </div>
        {error !== '' && <p className="err-text">{error}</p>}
        <div className="kb-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'chunks'} className={tab === 'chunks' ? 'on' : ''} onClick={() => setTab('chunks')}>
            分块（{preview?.chunks.length ?? '…'}）
          </button>
          <button role="tab" aria-selected={tab === 'raw'} className={tab === 'raw' ? 'on' : ''} onClick={() => setTab('raw')}>
            原文
          </button>
        </div>
        <div className="kb-drawer-body">
          {tab === 'chunks' && (
            <>
              {preview !== null && (
                <div className="kb-drawer-note">
                  向量索引：{preview.vector.note} · 解析元数据
                  <details className="kb-meta-details">
                    <summary>查看</summary>
                    <pre>{JSON.stringify(preview.parseMeta, null, 2)}</pre>
                  </details>
                </div>
              )}
              {(preview?.chunks ?? []).map((c) => {
                const fullText = full[c.chunkId]
                const truncated = fullText === undefined && c.text.length >= TRUNCATED_LEN
                return (
                  <div key={c.chunkId} className="kb-chunk">
                    <div className="kb-chunk-loc">
                      <span className="kb-badge mono">#{c.chunkId.slice(0, 8)}</span>
                      {c.pageNo !== undefined && c.pageNo !== null && <span className="kb-badge">第 {c.pageNo} 页</span>}
                      {c.figureId !== undefined && c.figureId !== null && c.figureId !== '' && <span className="kb-badge">图 {c.figureId.slice(0, 8)}</span>}
                      <span className="kb-badge">{c.kind === 'text' ? '正文' : c.kind === 'figure' ? '图示' : '表格'}</span>
                    </div>
                    <MiniMarkdown text={fullText ?? c.text} className="kb-chunk-text" />
                    {truncated && (
                      <button className="kb-chunk-more" onClick={() => void loadFull(c.chunkId)}>展开全文（含邻接上下文入口）</button>
                    )}
                  </div>
                )
              })}
              {preview !== null && preview.chunks.length === 0 && (
                <p className="muted">暂无切块（文档可能仍在解析，或解析失败）</p>
              )}
            </>
          )}
          {tab === 'raw' && (
            <>
              {raw?.state === 'loading' && <p className="muted">加载原文…</p>}
              {raw?.state === 'iframe' && raw.url !== undefined && <iframe className="kb-raw-frame" src={raw.url} title="原文预览" />}
              {raw?.state === 'markdown' && <MiniMarkdown text={raw.text ?? ''} className="kb-raw-md" />}
              {raw?.state === 'text' && <pre className="kb-raw-text">{raw.text}</pre>}
              {raw?.state === 'unsupported' && (
                <div className="kb-raw-fallback">
                  <p>DOCX 无浏览器原生预览，可下载后查看；切到「分块」页签查看解析结果。</p>
                  <a className="btn" href={`/api/admin/knowledge/documents/${docId}/file`} download>下载文件</a>
                </div>
              )}
              {raw?.state === 'missing' && (
                <div className="kb-raw-fallback">
                  <p>{raw.message ?? '原始文件不存在'}——切到「分块」页签查看解析结果。</p>
                </div>
              )}
              {raw?.state === 'error' && <p className="err-text">{raw.message}</p>}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
