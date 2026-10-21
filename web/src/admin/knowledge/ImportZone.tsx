import type { CSSProperties } from 'react'
/**
 * 资料导入区：拖拽/点击多文件上传（逐文件状态条）+ URL 导入 + manifest 批量导入。
 * 上传约束与后端一致：.pdf/.docx/.txt/.md/.html，单文件 ≤50MB；
 * sourceTier/access 默认 community/public，商业资料走有权限文件上传（spec 纪律）。
 */
import { useRef, useState } from 'react'
import defaultManifest from './default-manifest.json'

const ACCEPT = '.pdf,.docx,.txt,.md,.html'
const MAX_BYTES = 50 * 1024 * 1024

/** 默认清单条目（default-manifest.json 是 docs/references/knowledge-source-manifest.json 的构建副本） */
interface ManifestEntry {
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

const MANIFEST_ENTRIES = (defaultManifest as { entries: ManifestEntry[] }).entries
const MANIFEST_ENABLED = MANIFEST_ENTRIES.filter((e) => e.enabled)

export interface UploadItem {
  name: string
  size: number
  state: 'uploading' | 'done' | 'duplicate' | 'error'
  message?: string
}

interface UploadOutcome {
  status: string
  message?: string
}

async function uploadOne(file: File): Promise<UploadOutcome> {
  const form = new FormData()
  form.append('file', file)
  form.append('title', file.name)
  form.append('sourceTier', 'community')
  form.append('access', 'public')
  const res = await fetch('/api/admin/knowledge/documents', { method: 'POST', body: form })
  const data = (await res.json().catch(() => ({}))) as UploadOutcome
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`)
  return data
}

export default function ImportZone({ onDone }: { onDone: () => void }): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [items, setItems] = useState<UploadItem[]>([])
  const [url, setUrl] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const [urlMsg, setUrlMsg] = useState('')
  const [manifestBusy, setManifestBusy] = useState(false)
  const [manifestMsg, setManifestMsg] = useState('')
  const [manifestOpen, setManifestOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleFiles = (files: FileList | File[]): void => {
    const list = Array.from(files).filter((f) => f.size <= MAX_BYTES)
    const oversize = Array.from(files).length - list.length
    const base: UploadItem[] = list.map((f) => ({ name: f.name, size: f.size, state: 'uploading' as const }))
    if (oversize > 0) base.push({ name: `${oversize} 个文件超过 50MB 已跳过`, size: 0, state: 'error' })
    setItems((prev) => [...base, ...prev].slice(0, 12))
    // 串行上传：multipart 单文件端点，避免并发挤占解析队列
    void (async () => {
      for (let i = 0; i < list.length; i += 1) {
        const f = list[i]
        try {
          const r = await uploadOne(f)
          setItems((prev) =>
            prev.map((it) => (it.name === f.name && it.state === 'uploading' ? { ...it, state: r.status === 'duplicate' ? 'duplicate' : 'done' } : it)),
          )
        } catch (e) {
          setItems((prev) =>
            prev.map((it) => (it.name === f.name && it.state === 'uploading' ? { ...it, state: 'error', message: (e as Error).message } : it)),
          )
        }
      }
      onDone()
    })()
  }

  const importUrl = async (): Promise<void> => {
    setUrlBusy(true)
    setUrlMsg('')
    try {
      const res = await fetch('/api/admin/knowledge/documents/import-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, sourceTier: 'official', access: 'public' }),
      })
      const data = (await res.json().catch(() => ({}))) as UploadOutcome
      if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`)
      setUrlMsg(data.status === 'duplicate' ? '重复资料，未新建' : '已导入并入队解析')
      setUrl('')
      onDone()
    } catch (e) {
      setUrlMsg((e as Error).message)
    } finally {
      setUrlBusy(false)
    }
  }

  const importManifest = async (): Promise<void> => {
    if (MANIFEST_ENABLED.length === 0) {
      setManifestMsg('清单没有启用中的条目')
      return
    }
    setManifestBusy(true)
    setManifestMsg('')
    try {
      const res = await fetch('/api/admin/knowledge/documents/import-manifest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 提交启用条目的完整字段（url_fetch 自动抓取；user_upload/非 public 由后端
        // 归为 pendingUpload/skipped，提示走有使用权文件上传）
        body: JSON.stringify({ entries: MANIFEST_ENABLED }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        summary?: { imported: number; duplicates: number; failed: number; pendingUpload: number }
        message?: string
      }
      if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`)
      const s = data.summary
      setManifestMsg(`新 ${s?.imported ?? 0} · 重复 ${s?.duplicates ?? 0} · 失败 ${s?.failed ?? 0} · 待上传 ${s?.pendingUpload ?? 0}`)
      onDone()
    } catch (e) {
      setManifestMsg((e as Error).message)
    } finally {
      setManifestBusy(false)
    }
  }

  return (
    <div className="kb-import fx-in" style={{ '--fx-i': 1 } as CSSProperties}>
      <div
        className={`kb-dropzone${dragging ? ' drag' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="上传知识库文件"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files)
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files !== null && e.target.files.length > 0) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <svg className="kb-drop-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 16V4m0 0 4 4m-4-4-4 4" strokeLinecap="round" strokeLinejoin="round" stroke="currentColor" strokeWidth="1.6" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <div className="kb-drop-main">拖拽文件到此处，或点击选择</div>
        <div className="kb-drop-sub">支持 PDF / DOCX / TXT / MD / HTML，单文件 ≤50MB，可多选；商业书籍仅上传有使用权的文件</div>
        {items.length > 0 && (
          <ul className="kb-upload-list" onClick={(e) => e.stopPropagation()}>
            {items.map((it, i) => (
              <li key={`${it.name}-${i}`} className={`u-${it.state}`}>
                <span className="kb-upload-name" title={it.name}>{it.name}</span>
                {it.state === 'uploading' && <span className="kb-upload-state">上传中…</span>}
                {it.state === 'done' && <span className="kb-upload-state">✓ 已入队解析</span>}
                {it.state === 'duplicate' && <span className="kb-upload-state">重复，未新建</span>}
                {it.state === 'error' && <span className="kb-upload-state" title={it.message ?? ''}>✕ {it.message ?? '失败'}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="kb-import-side">
        <div className="kb-side-card">
          <h5>URL 导入</h5>
          <div className="kb-side-row">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…（官方公开资料）"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url !== '' && !urlBusy) void importUrl()
              }}
            />
            <button className="btn btn-primary" disabled={urlBusy || url === ''} onClick={() => void importUrl()}>
              {urlBusy ? '抓取中…' : '导入'}
            </button>
          </div>
          {urlMsg !== '' && <p className="kb-side-msg">{urlMsg}</p>}
          <p className="muted">遇访问限制如实失败，不绕过</p>
        </div>
        <div className="kb-side-card">
          <h5>清单批量导入</h5>
          <div className="kb-side-row">
            <button className="btn" disabled={manifestBusy} onClick={() => setManifestOpen((v) => !v)}>
              {manifestOpen ? '收起清单' : `查看默认清单（${MANIFEST_ENTRIES.length} 条）`}
            </button>
            <button
              className="btn btn-primary"
              disabled={manifestBusy || MANIFEST_ENABLED.length === 0}
              onClick={() => void importManifest()}
            >
              {manifestBusy ? '导入中…' : `导入 ${MANIFEST_ENABLED.length} 条启用条目`}
            </button>
          </div>
          {manifestOpen && (
            <ul className="kb-manifest-list" onClick={(e) => e.stopPropagation()}>
              {MANIFEST_ENTRIES.map((e) => (
                <li key={e.id} className={e.enabled ? '' : 'disabled'}>
                  <span className="kb-manifest-title" title={e.url}>{e.title}</span>
                  <span className="kb-manifest-meta">
                    {e.sourceTier}/{e.access} · {e.importMethod === 'url_fetch' ? '自动抓取' : '需手动上传'}
                    {!e.enabled && ' · 未启用'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {manifestMsg !== '' && <p className="kb-side-msg">{manifestMsg}</p>}
          <p className="muted">维护 docs/references/knowledge-source-manifest.json（与构建副本 default-manifest.json 同步）</p>
        </div>
      </div>
    </div>
  )
}
