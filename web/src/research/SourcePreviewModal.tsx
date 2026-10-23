/**
 * 用户侧证据原文只读预览（W2 流程 7，docs/knowledge-ui-redesign-plan.md）：
 * - fileUrl 是服务端按当前 access 判权后的鉴权读取端点（受限/清除时服务端不给或 403/404）；
 * - PDF 定位到冻结页码（#page=N）；docUpdated（文档已重发布/归档/清除）时不定位并提示
 *   「文档已更新，定位可能失效」（M6 可信降级：坐标陈旧宁可不高亮）；
 * - HTML 原文 iframe 加 sandbox（无 allow-scripts）+ 服务端 CSP sandbox 双层防线，隔离注入面；
 * - MD 按既定 MiniMarkdown 管线渲染、TXT 纯文本、DOCX 下载降级。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import MiniMarkdown from '../components/MiniMarkdown'

export interface SourcePreviewTarget {
  evidenceId: string
  docTitle: string
  pageNo: number | null
  fileUrl: string
  docUpdated: boolean
}

interface RawLoad {
  state: 'loading' | 'iframe' | 'markdown' | 'text' | 'unsupported' | 'unavailable' | 'error'
  url?: string
  text?: string
  message?: string
}

export default function SourcePreviewModal({ target, onClose }: { target: SourcePreviewTarget; onClose: () => void }): JSX.Element | null {
  const { t } = useTranslation()
  const [raw, setRaw] = useState<RawLoad | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    setRaw({ state: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(target.fileUrl)
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string }
          if (!alive) return
          setRaw(
            res.status === 403 || res.status === 404
              ? { state: 'unavailable', message: data.message ?? t('research:result.sourceUnavailable') }
              : { state: 'error', message: data.message ?? `HTTP ${res.status}` },
          )
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
        } else if (alive) {
          setRaw({ state: 'unsupported' })
        }
      } catch (e) {
        if (alive) setRaw({ state: 'error', message: (e as Error).message })
      }
    })()
    return () => {
      alive = false
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [target, t])

  // docUpdated 时不带页码定位（陈旧坐标宁可不高亮，M6）
  const iframeSrc =
    raw?.url !== undefined && !target.docUpdated && target.pageNo !== null ? `${raw.url}#page=${target.pageNo}` : raw?.url

  return (
    <div className="src-preview-overlay" onClick={onClose} role="presentation">
      <div className="src-preview" role="dialog" aria-label={t('research:result.sourcePreview')} onClick={(e) => e.stopPropagation()}>
        <div className="src-preview-head">
          <strong>{target.docTitle !== '' ? target.docTitle : t('research:result.sourcePreview')}</strong>
          {target.pageNo !== null && !target.docUpdated && (
            <span className="src-preview-page">{t('research:result.pageNoTitle', { page: target.pageNo })}</span>
          )}
          <button className="icon-btn" onClick={onClose} aria-label={t('common:toast.close')}>✕</button>
        </div>
        {target.docUpdated && <div className="src-preview-warn" role="status">{t('research:result.sourceUpdated')}</div>}
        <div className="src-preview-body">
          {raw?.state === 'loading' && <p className="muted" role="status">{t('research:result.sourceLoading')}</p>}
          {raw?.state === 'iframe' && iframeSrc !== undefined && (
            <iframe
              className="src-preview-frame"
              // sandbox 不加 allow-scripts：HTML 原文禁脚本（服务端另有 CSP sandbox 双层防线）
              sandbox=""
              src={iframeSrc}
              title={t('research:result.sourcePreview')}
            />
          )}
          {raw?.state === 'markdown' && <MiniMarkdown text={raw.text ?? ''} className="src-preview-md" />}
          {raw?.state === 'text' && <pre className="src-preview-text">{raw.text}</pre>}
          {raw?.state === 'unsupported' && (
            <div className="src-preview-fallback">
              <p>{t('research:result.sourceUnsupported')}</p>
              <a className="btn" href={target.fileUrl} download>{t('research:result.sourceDownload')}</a>
            </div>
          )}
          {raw?.state === 'unavailable' && <div className="src-preview-fallback"><p>{raw.message}</p></div>}
          {raw?.state === 'error' && <p className="err-text">{raw.message}</p>}
        </div>
      </div>
    </div>
  )
}
