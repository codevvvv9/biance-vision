/**
 * W2 上传队列对话框（docs/knowledge-ui-redesign-plan.md 流程 1，重构替代 ImportZone 的文件区）：
 * - 入队三道校验（各自报错、带文件名）：格式 / 大小 ≤50MB / name+size 队列内重复
 *   + contentHash 服务端预检（POST documents/precheck，重复标黄不入队上传）；
 * - 队列区逐文件行：类型角标+文件名+大小+状态+单文件移除；串行上传（XHR 进度百分比），
 *   上传中行自动滚动进入视野；
 * - 元数据区：sourceTier × access 下拉（自绘 Dropdown，修 G3；受限级别带警示旁注）；
 * - 底部三钮：取消（= 回滚：abort 进行中 + purge 清本次已传文档）/ 开始上传（有就绪项才可用）/
 *   完成（有成功且无失败无进行中才可用）；
 * - URL 导入与清单批量导入在第二/三个 Tab（清单明细走 ManifestDialog 独立弹窗，流程 6）。
 */
import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { api } from '../../api'
import { Dropdown } from '../../research/Dropdown'
import { FileIcon } from './ui'

const ACCEPT = '.pdf,.docx,.txt,.md,.html'
const ALLOWED_EXT = ['pdf', 'docx', 'txt', 'md', 'html']
const MAX_BYTES = 50 * 1024 * 1024

type ItemState = 'checking' | 'ready' | 'duplicate' | 'invalid' | 'uploading' | 'done' | 'error'

interface QueueItem {
  key: string
  file: File
  state: ItemState
  message?: string
  progress: number
  /** 本次会话新建的文档 id（取消回滚只清这些，不动服务端判重的既有文档） */
  docId?: string
}

interface UploadOutcome {
  status?: string
  message?: string
  document?: { id: string } | null
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(n / 1024))}KB`
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** XHR 上传（fetch 无上传进度事件；abort 经返回的控制器外部触发） */
function xhrUpload(
  file: File,
  sourceTier: string,
  access: string,
  onProgress: (pct: number) => void,
): { promise: Promise<UploadOutcome>; abort: () => void } {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<UploadOutcome>((resolve, reject) => {
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    })
    xhr.addEventListener('load', () => {
      let data: UploadOutcome = {}
      try {
        data = JSON.parse(xhr.responseText) as UploadOutcome
      } catch {
        /* 非 JSON 响应按错误处理 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else reject(new Error(data.message ?? `HTTP ${xhr.status}`))
    })
    xhr.addEventListener('error', () => reject(Object.assign(new Error('network'), { name: 'NetworkError' })))
    xhr.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    const form = new FormData()
    form.append('file', file)
    form.append('title', file.name)
    form.append('sourceTier', sourceTier)
    form.append('access', access)
    xhr.open('POST', '/api/admin/knowledge/documents')
    xhr.send(form)
  })
  return { promise, abort: () => xhr.abort() }
}

const TIER_OPTIONS = [
  { value: 'community', label: '社区' },
  { value: 'official', label: '官方' },
  { value: 'official_derivative', label: '官方衍生' },
] as const
const ACCESS_OPTIONS = [
  { value: 'public', label: '公开' },
  { value: 'purchase', label: '购买' },
  { value: 'member', label: '会员' },
] as const

const STATE_LABEL: Record<ItemState, string> = {
  checking: '查重中…',
  ready: '待上传',
  duplicate: '重复，未上传',
  invalid: '不可上传',
  uploading: '上传中',
  done: '已入队解析',
  error: '失败',
  // ↑ 模块级常量:词典 key(渲染处经 t() 翻译)
}

export default function UploadDialog({
  onClose,
  onDone,
  onOpenManifest,
}: {
  onClose: () => void
  onDone: () => void
  onOpenManifest: () => void
}): JSX.Element | null {
  const { t } = useTranslation('admin')
  const [tab, setTab] = useState<'files' | 'url' | 'manifest'>('files')
  const [items, setItems] = useState<QueueItem[]>([])
  const [sourceTier, setSourceTier] = useState<'community' | 'official' | 'official_derivative'>('community')
  const [access, setAccess] = useState<'public' | 'purchase' | 'member'>('public')
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [url, setUrl] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const [urlMsg, setUrlMsg] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 上传进行中不允许 Esc 关闭（防半传状态）；走「取消」显式回滚
      if (e.key === 'Escape' && !uploading) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, uploading])

  /** 入队 + 三道校验（格式 / 大小 / name+size 重复）+ contentHash 服务端预检 */
  const enqueue = (files: FileList | File[]): void => {
    const incoming = Array.from(files)
    const additions: QueueItem[] = []
    const nextItems = [...items]
    for (const file of incoming) {
      const ext = (file.name.split('.').pop() ?? '').toLowerCase()
      const key = `${file.name}:${file.size}:${(seqRef.current += 1)}`
      if (!ALLOWED_EXT.includes(ext)) {
        additions.push({ key, file, state: 'invalid', progress: 0, message: t('不支持的格式 .{{ext}}（支持 {{ok}}）', { ext, ok: ACCEPT.split(',').join(' / ') }) })
        continue
      }
      if (file.size > MAX_BYTES) {
        additions.push({ key, file, state: 'invalid', progress: 0, message: t('超过 50MB（{{size}}）', { size: formatBytes(file.size) }) })
        continue
      }
      if ([...nextItems, ...additions].some((it) => it.file.name === file.name && it.file.size === file.size && it.state !== 'invalid')) {
        additions.push({ key, file, state: 'invalid', progress: 0, message: t('与队列中已有文件同名同大小') })
        continue
      }
      additions.push({ key, file, state: 'checking', progress: 0 })
    }
    const merged = [...nextItems, ...additions]
    setItems(merged)
    // contentHash 预检（第三道）：逐个算指纹 → 服务端查重
    for (const item of additions) {
      if (item.state !== 'checking') continue
      void (async () => {
        let duplicate = false
        let existingTitle: string | null = null
        try {
          const hash = await sha256Hex(item.file)
          const r = await api<{ duplicate: boolean; existingTitle: string | null }>('/admin/knowledge/documents/precheck', {
            method: 'POST',
            body: { contentHash: hash },
          })
          duplicate = r.duplicate
          existingTitle = r.existingTitle
        } catch {
          // 预检失败不阻塞：放行上传，服务端上传时仍会兜底查重
        }
        setItems((prev) =>
          prev.map((it) =>
            it.key === item.key && it.state === 'checking'
              ? { ...it, state: duplicate ? 'duplicate' : 'ready', message: duplicate ? t('已有相同内容：{{title}}', { title: existingTitle ?? '' }) : undefined }
              : it,
          ),
        )
      })()
    }
  }

  /** 串行上传就绪项；上传中行滚动进入视野 */
  const startUpload = async (): Promise<void> => {
    setUploading(true)
    try {
      for (;;) {
        const target = itemsRef.current.find((it) => it.state === 'ready')
        if (target === undefined) break
        setItems((prev) => prev.map((it) => (it.key === target.key ? { ...it, state: 'uploading', progress: 0 } : it)))
        listRef.current?.querySelector(`[data-qkey="${target.key}"]`)?.scrollIntoView({ block: 'nearest' })
        const { promise, abort } = xhrUpload(target.file, sourceTier, access, (pct) => {
          setItems((prev) => prev.map((it) => (it.key === target.key && it.state === 'uploading' ? { ...it, progress: pct } : it)))
        })
        abortRef.current = abort
        try {
          const r = await promise
          setItems((prev) =>
            prev.map((it) =>
              it.key === target.key
                ? {
                    ...it,
                    state: r.status === 'duplicate' ? 'duplicate' : 'done',
                    progress: 100,
                    docId: r.status === 'duplicate' ? undefined : (r.document?.id ?? undefined),
                    message: r.status === 'duplicate' ? t('服务端判重：已有相同内容') : undefined,
                  }
                : it,
            ),
          )        } catch (e) {
          const err = e as Error
          setItems((prev) =>
            prev.map((it) => (it.key === target.key ? { ...it, state: 'error', message: err.name === 'AbortError' ? t('已中止') : err.name === 'NetworkError' ? t('网络错误') : err.message } : it)),
          )
          if (err.name === 'AbortError') break
        } finally {
          abortRef.current = null
        }
      }
    } finally {
      setUploading(false)
      onDone()
    }
  }
  // 串行循环读最新队列：ref 镜像（items 闭包在 async 循环里会过期）
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  /** 取消 = 回滚：abort 进行中 + purge 本次已新建的文档（不动服务端判重命中的既有文档） */
  const cancelAndRollback = async (): Promise<void> => {
    abortRef.current?.()
    const created = itemsRef.current.filter((it) => it.docId !== undefined)
    for (const it of created) {
      try {
        await api(`/admin/knowledge/documents/${it.docId}?purge=1`, { method: 'DELETE' })
      } catch {
        /* 单个清理失败不阻塞关闭；文档可从列表手动删除 */
      }
    }
    if (created.length > 0) onDone()
    onClose()
  }

  const importUrl = async (): Promise<void> => {
    setUrlBusy(true)
    setUrlMsg('')
    try {
      const r = await api<{ status: string }>('/admin/knowledge/documents/import-url', {
        method: 'POST',
        body: { url, sourceTier, access },
      })
      setUrlMsg(r.status === 'duplicate' ? t('重复资料，未新建') : t('已导入并入队解析'))
      setUrl('')
      onDone()
    } catch (e) {
      setUrlMsg((e as Error).message)
    } finally {
      setUrlBusy(false)
    }
  }

  const removeItem = (key: string): void => {
    // 上传中/已完成项不可移除（前者防半传、后者已是服务端状态，走取消回滚或列表管理）
    setItems((prev) => prev.filter((it) => it.key !== key || it.state === 'uploading' || it.state === 'done'))
  }

  const readyCount = items.filter((it) => it.state === 'ready').length
  const doneCount = items.filter((it) => it.state === 'done').length
  const failedCount = items.filter((it) => it.state === 'error' || it.state === 'invalid').length
  const canFinish = doneCount > 0 && failedCount === 0 && !uploading

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length > 0) enqueue(e.dataTransfer.files)
  }

  return (
    <div className="kb-modal-overlay" onClick={uploading ? undefined : onClose} role="presentation">
      <div className="kb-modal kb-upload-modal" role="dialog" aria-label={t("上传资料")} onClick={(e) => e.stopPropagation()}>
        <div className="kb-modal-head">
          <strong>{t('上传资料')}</strong>
          <div className="kb-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>{t('文件')}</button>
            <button role="tab" aria-selected={tab === 'url'} className={tab === 'url' ? 'on' : ''} onClick={() => setTab('url')}>URL</button>
            <button role="tab" aria-selected={tab === 'manifest'} className={tab === 'manifest' ? 'on' : ''} onClick={() => setTab('manifest')}>{t('清单')}</button>
          </div>
          {!uploading && (
            <button className="icon-btn" onClick={onClose} aria-label={t("关闭")}>✕</button>
          )}
        </div>

        {tab === 'files' && (
          <>
            <div className="kb-meta-row">
              <label>
                {t('来源')}
                <Dropdown value={sourceTier} options={TIER_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onChange={setSourceTier} ariaLabel={t("来源等级")} disabled={uploading} />
              </label>
              <label>
                {t('访问')}
                <Dropdown value={access} options={ACCESS_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onChange={setAccess} ariaLabel={t("访问级别")} disabled={uploading} />
              </label>
              {access !== 'public' && (
                <span className="kb-access-note">⚠ {access === 'purchase' ? t('购买') : t('会员')}{t('资料对普通用户不可见（方案甲过滤）')}</span>
              )}
            </div>
            <div
              className={`kb-dropzone compact${dragging ? ' drag' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={t("添加文件到上传队列")}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files !== null && e.target.files.length > 0) enqueue(e.target.files)
                  e.target.value = ''
                }}
              />
              <div className="kb-drop-main">{t('拖拽文件到此处入队，或点击选择')}</div>
              <div className="kb-drop-sub">{t('PDF / DOCX / TXT / MD / HTML，单文件 ≤50MB，可多选；上传前先查重；商业书籍仅上传有使用权的文件')}</div>
            </div>
            {items.length > 0 && (
              <ul className="kb-queue-list" ref={listRef}>
                {items.map((it) => (
                  <li key={it.key} data-qkey={it.key} className={`q-${it.state}`}>
                    <FileIcon doc={{ sourceType: 'file', title: it.file.name }} />
                    <span className="kb-upload-name" title={it.file.name}>{it.file.name}</span>
                    <span className="kb-queue-size">{formatBytes(it.file.size)}</span>
                    <span className="kb-upload-state" title={it.message ?? ''}>
                      {it.state === 'uploading' ? t('上传中 {{p}}%', { p: it.progress }) : t(STATE_LABEL[it.state])}
                      {it.state === 'error' && it.message !== undefined && it.message !== '' ? ` · ${it.message}` : ''}
                    </span>
                    {it.state === 'uploading' && (
                      <span className="kb-queue-progress" aria-hidden>
                        <i style={{ width: `${it.progress}%` }} />
                      </span>
                    )}
                    {(it.state === 'checking' || it.state === 'ready' || it.state === 'duplicate' || it.state === 'invalid' || it.state === 'error') && (
                      <button className="kb-queue-remove" onClick={() => removeItem(it.key)} aria-label={t('移除 {{name}}', { name: it.file.name })}>{t('移除')}</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="kb-upload-footer">
              <button className="btn" onClick={() => void cancelAndRollback()}>
                {t('取消')}{items.some((it) => it.docId !== undefined) ? t('（回滚已传文档）') : ''}
              </button>
              <button
                className="btn btn-primary"
                disabled={uploading || readyCount === 0}
                onClick={() => void startUpload()}
              >
                {uploading ? t('上传中…') : t('开始上传{{n}}', { n: readyCount > 0 ? `（${readyCount}）` : '' })}
              </button>
              <button className="btn" disabled={!canFinish} onClick={onClose}>{t('完成')}</button>
            </div>
          </>
        )}

        {tab === 'url' && (
          <div className="kb-url-pane">
            <div className="kb-side-row">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t('https://…（官方公开资料）')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && url !== '' && !urlBusy) void importUrl()
                }}
              />
              <button className="btn btn-primary" disabled={urlBusy || url === ''} onClick={() => void importUrl()}>
                {urlBusy ? t('抓取中…') : t('导入')}
              </button>
            </div>
            {urlMsg !== '' && <p className="kb-side-msg">{urlMsg}</p>}
            <div className="kb-meta-row">
              <label>
                {t('来源')}
                <Dropdown value={sourceTier} options={TIER_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onChange={setSourceTier} ariaLabel={t('来源等级')} />
              </label>
              <label>
                {t('访问')}
                <Dropdown value={access} options={ACCESS_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onChange={setAccess} ariaLabel={t('访问级别')} />
              </label>
            </div>
            <p className="muted">{t('遇访问限制如实失败，不绕过；purchase/member 的 URL 同样不会绕过限制（自动跳过）。')}</p>
          </div>
        )}

        {tab === 'manifest' && (
          <div className="kb-url-pane">
            <p className="muted">
              {t('从维护清单批量导入（docs/references/knowledge-source-manifest.json）：查看每条状态、失败原因、单条重试与勾选导入，都在清单管理弹窗中完成。')}
            </p>
            <button className="btn btn-primary" onClick={onOpenManifest}>{t('打开清单管理')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
