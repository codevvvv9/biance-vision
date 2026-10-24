/**
 * 知识库管理页共享 UI 元件：文档状态徽章、来源/权限徽章、按文件类型的彩色图标。
 * 状态色语义：uploaded 灰 → parsing 蓝（脉冲）→ parsed/chunked 琥珀 → indexed 待发布 → published 绿 → failed 红。
 */
import { useTranslation } from 'react-i18next'
import type { KnowledgeDocument } from 'biance-vision-brooks'

export const STATUS_META: Record<string, { label: string; cls: string; hint: string }> = {
  uploaded: { label: '待解析', cls: 'st-uploaded', hint: '已上传，排队解析' },
  parsing: { label: '解析中', cls: 'st-parsing', hint: 'Docling/原生解析进行中' },
  parsed: { label: '已解析', cls: 'st-parsed', hint: '解析完成，待切分索引' },
  chunked: { label: '已切分', cls: 'st-parsed', hint: '切分完成，待向量化索引' },
  indexed: { label: '待发布', cls: 'st-indexed', hint: '索引完成，可发布上线' },
  published: { label: '已发布', cls: 'st-published', hint: '已进入当前知识版本，检索可见' },
  failed: { label: '失败', cls: 'st-failed', hint: '解析/索引失败，可重解析' },
}

export function StatusBadge({ status, error }: { status: string; error?: string }): JSX.Element {
  const { t } = useTranslation('admin')
  const meta = STATUS_META[status] ?? { label: status, cls: 'st-uploaded', hint: '' }
  return (
    <span className={`kb-status ${meta.cls}`} title={error !== undefined && error !== '' ? t('失败原因：{{msg}}', { msg: error }) : t(meta.hint)}>
      <i />
      {t(meta.label)}
    </span>
  )
}

export const TIER_LABEL: Record<string, string> = {
  official: '官方',
  official_derivative: '官方衍生',
  community: '社区',
}

const ACCESS_LABEL: Record<string, string> = { public: '公开', purchase: '购买', member: '会员' }

export function TierBadge({ tier, access }: { tier: string; access?: string }): JSX.Element {
  const { t } = useTranslation('admin')
  return (
    <span className="kb-badge" title={t('来源等级 {{tier}}{{access}}', { tier, access: access !== undefined ? ` · ${t('权限')} ${access}` : '' })}>
      {t(TIER_LABEL[tier] ?? tier)}
      {access !== undefined && access !== 'public' ? t(' · {{a}}', { a: ACCESS_LABEL[access] ?? access }) : ''}
    </span>
  )
}

interface FileIconMeta {
  label: string
  cls: string
}

/** 按扩展名/来源选图标底色（纯 CSS 字母块，零图片依赖） */
export function fileIconMeta(doc: Pick<KnowledgeDocument, 'sourceType' | 'title'>): FileIconMeta {
  if (doc.sourceType === 'url') return { label: 'URL', cls: 'fi-url' }
  if (doc.sourceType === 'manifest') return { label: 'MAN', cls: 'fi-manifest' }
  const ext = (doc.title.split('.').pop() ?? '').toLowerCase()
  if (ext === 'pdf') return { label: 'PDF', cls: 'fi-pdf' }
  if (ext === 'docx' || ext === 'doc') return { label: 'DOC', cls: 'fi-doc' }
  if (ext === 'md' || ext === 'markdown') return { label: 'MD', cls: 'fi-md' }
  if (ext === 'html' || ext === 'htm') return { label: 'HTML', cls: 'fi-html' }
  return { label: 'TXT', cls: 'fi-txt' }
}

export function FileIcon({ doc, size = 'md' }: { doc: Pick<KnowledgeDocument, 'sourceType' | 'title'>; size?: 'md' | 'lg' }): JSX.Element {
  const meta = fileIconMeta(doc)
  return <span className={`kb-file-icon ${meta.cls} ${size === 'lg' ? 'lg' : ''}`}>{meta.label}</span>
}
