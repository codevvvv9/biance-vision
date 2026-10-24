/**
 * 聊天引用角标（2026-10-24，聊天侧引用角标化）：
 * 数据驱动的通用组件——assistant 消息携带 citations（结构化引用数组）时渲染角标行，
 * 点击展开冻结片段；kind 分支展示（知识块=标题+页码 / 网页=外链）。
 * 零侵入：无 citations 的消息不渲染任何内容，MiniMarkdown 渲染管线不变；
 * 文本版「来源」行由服务端保留（旧形态兼容），有角标时前端隐藏文本来源行由
 * 调用方决定（本组件不接管正文）。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageCitation } from 'biance-vision-brooks'

export default function CitationBadges({ citations }: { citations: MessageCitation[] }): JSX.Element | null {
  const { t } = useTranslation('research')
  const [open, setOpen] = useState<number | null>(null)
  if (citations.length === 0) return null

  return (
    <div className="cite-badges">
      {citations.map((c) => (
        <div key={c.n} className="cite-badge-item">
          <button
            className={`cite-badge c-${c.kind}`}
            aria-expanded={open === c.n}
            onClick={() => setOpen(open === c.n ? null : c.n)}
            title={c.kind === 'web_page' && c.url !== undefined && c.url !== null ? c.url : c.title}
          >
            [{c.n}] {c.title}
            {c.kind === 'knowledge_chunk' && c.pageNo !== null && c.pageNo !== undefined
              ? t('result.pageNoTitle', { page: c.pageNo })
              : ''}
          </button>
          {open === c.n && (
            <div className="cite-badge-popover" role="note">
              <p className="cite-badge-snippet">{c.snippet}</p>
              {c.kind === 'web_page' && c.url !== undefined && c.url !== null && c.url !== '' && (
                <a href={c.url} target="_blank" rel="noreferrer noopener">{t('result.citationOpenSource')}</a>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
