/**
 * 检索调试：查询 → 流水线各阶段打点（变体/词项/向量/融合/精排）→ 命中卡片。
 * 命中片段用 MiniMarkdown 渲染（书摘原文多为 md），页码/图号/来源等级做徽章。
 */
import { useTranslation } from 'react-i18next'
import { useState, type CSSProperties } from 'react'
import { api } from '../../api'
import type { SearchDebugResult } from 'biance-vision-brooks'
import MiniMarkdown from '../../components/MiniMarkdown'
import { TIER_LABEL } from './ui'

export default function SearchDebugPanel({ onError }: { onError: (msg: string) => void }): JSX.Element {
  const { t } = useTranslation('admin')
  const [query, setQuery] = useState(t('H2 是什么'))
  const [mode, setMode] = useState<'support' | 'counter'>('support')
  const [busy, setBusy] = useState(false)
  const [debug, setDebug] = useState<SearchDebugResult | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api<SearchDebugResult>(
        `/admin/knowledge/search-debug?query=${encodeURIComponent(query)}&mode=${mode}`,
      )
      setDebug(r)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel fx-in" style={{ '--fx-i': 3 } as CSSProperties}>
      <h4>{t('检索调试')}</h4>
      <div className="kb-debug-bar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("测试查询，如：H2 是什么 / barbwire 特征")}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim() !== '' && !busy) void run()
          }}
        />
        <div className="kb-seg" role="radiogroup" aria-label={t("检索方向")}>
          <button role="radio" aria-checked={mode === 'support'} className={mode === 'support' ? 'on' : ''} onClick={() => setMode('support')}>{t('支持依据')}</button>
          <button role="radio" aria-checked={mode === 'counter'} className={mode === 'counter' ? 'on' : ''} onClick={() => setMode('counter')}>{t('反例')}</button>
        </div>
        <button className="btn btn-primary" disabled={busy || query.trim() === ''} onClick={() => void run()}>
          {busy ? t('检索中…') : t('查询')}
        </button>
      </div>
      {debug !== null && (
        <>
          <div className="kb-pipe" aria-label={t("检索流水线各阶段命中数")}>
            <span className="kb-pipe-step" title={t('原问题之外的改写变体：{{list}}', { list: debug.variants.join(' | ') || t('无') })}>
              {t('变体')}<b>{debug.variants.length}</b>
            </span>
            <span className="kb-pipe-arrow">→</span>
            <span className="kb-pipe-step" title={t("词项召回（精确/同义词）")}>{t("词项")}<b>{debug.termHits.length}</b></span>
            <span className="kb-pipe-arrow">→</span>
            <span className="kb-pipe-step" title={t("向量召回（pgvector）")}>{t("向量")}<b>{debug.vectorHits.length}</b></span>
            <span className="kb-pipe-arrow">→</span>
            <span className="kb-pipe-step" title={t("RRF 融合")}>{t("融合")}<b>{debug.fused.length}</b></span>
            <span className="kb-pipe-arrow">→</span>
            <span className="kb-pipe-step" title={debug.reranked.length === 0 ? t('未配置 rerank 能力，流水线跳过') : t('精排')}>{t('精排')}<b>{debug.reranked.length}</b></span>
            <span className="kb-pipe-arrow">→</span>
            <span className="kb-pipe-step final" title={t("最终命中（含邻接扩展）")}>{t("命中")}<b>{debug.hits.length}</b></span>
          </div>
          {debug.variants.length > 0 && (
            <p className="kb-variants">{t('改写变体：{{list}}', { list: debug.variants.map((v) => `「${v}」`).join(' ') })}</p>
          )}
          {debug.hits.length === 0 ? (
            <p className="muted">{t('无命中（知识库未发布资料或查询不相关时为空，不编造结果）')}</p>
          ) : (
            <div className="kb-hit-list">
              {debug.hits.map((h, i) => (
                <div key={h.chunkId} className="kb-hit">
                  <div className="kb-hit-head">
                    <span className="kb-hit-no">{i + 1}</span>
                    <strong className="kb-hit-title" title={h.docTitle}>{h.docTitle}</strong>
                    {h.pageNo !== null && h.pageNo !== undefined && <span className="kb-badge">{t('第 {{n}} 页', { n: h.pageNo })}</span>}
                    {h.figureId !== null && h.figureId !== undefined && h.figureId !== '' && <span className="kb-badge">{t('图 {{id}}', { id: h.figureId.slice(0, 8) })}</span>}
                    <span className="kb-badge">{h.kind === 'text' ? t('正文') : h.kind === 'figure' ? t('图示') : t('表格')}</span>
                    <span className="kb-badge">{TIER_LABEL[h.sourceTier] ?? h.sourceTier}</span>
                  </div>
                  <MiniMarkdown text={h.snippet} className="kb-hit-snippet" />
                </div>
              ))}
            </div>
          )}
          {[...debug.adjacencyNotes, ...debug.notes].map((n, i) => (
            <p key={i} className="muted kb-pipe-note">· {n}</p>
          ))}
        </>
      )}
    </div>
  )
}
