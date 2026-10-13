/**
 * /admin/knowledge 知识库管理（超管）：
 * 文档列表与状态机、文件上传 / URL 导入 / manifest 批量导入、预览、重解析、发布、检索调试。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { KnowledgeDocument, SearchDebugResult } from 'biance-vision-brooks'

const STATUS_LABEL: Record<string, string> = {
  uploaded: '已上传',
  parsing: '解析中',
  parsed: '已解析',
  chunked: '已切分',
  indexed: '已索引（待发布）',
  published: '已发布',
  failed: '失败',
}

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

export default function AdminKnowledgePage(): JSX.Element {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<DocPreview | null>(null)
  const [debug, setDebug] = useState<SearchDebugResult | null>(null)
  const [debugQuery, setDebugQuery] = useState('H2 是什么')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ documents: KnowledgeDocument[] }>('/admin/knowledge/documents')
      setDocs(r.documents)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const upload = async (): Promise<void> => {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setError('先选择文件')
      return
    }
    const form = new FormData()
    form.append('file', file)
    form.append('title', file.name)
    form.append('sourceTier', 'community')
    form.append('access', 'public')
    setError('')
    setMessage('')
    try {
      const res = await fetch('/api/admin/knowledge/documents', { method: 'POST', body: form })
      const data = (await res.json()) as { status?: string; message?: string }
      if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`)
      setMessage(data.status === 'duplicate' ? '重复资料（contentHash 命中，未新建）' : '已上传并入队解析')
      if (fileRef.current) fileRef.current.value = ''
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const importUrl = async (url: string): Promise<void> => {
    setError('')
    setMessage('')
    try {
      const res = await api<{ status: string }>('/admin/knowledge/documents/import-url', {
        method: 'POST',
        body: { url, sourceTier: 'official', access: 'public' },
      })
      setMessage(res.status === 'duplicate' ? '重复资料' : '已导入入队')
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const importManifest = async (): Promise<void> => {
    setError('')
    setMessage('')
    try {
      const r = await api<{ summary: { imported: number; duplicates: number; failed: number; pendingUpload: number } }>(
        '/admin/knowledge/documents/import-manifest',
        { method: 'POST', body: { entries: [] } },
      ).catch(() => null)
      if (r === null) {
        setError('manifest 导入需要条目清单（docs/references/knowledge-source-manifest.json 的 entries）')
        return
      }
      setMessage(`清单导入：新 ${r.summary.imported} / 重复 ${r.summary.duplicates} / 失败 ${r.summary.failed} / 待上传 ${r.summary.pendingUpload}`)
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const runDebug = async (): Promise<void> => {
    setError('')
    try {
      const r = await api<SearchDebugResult>(`/admin/knowledge/search-debug?query=${encodeURIComponent(debugQuery)}`)
      setDebug(r)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="admin-page">
      <h3>知识库管理</h3>
      {error && <p className="err-text">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      <div className="admin-row">
        <div className="panel">
          <h4>文件上传</h4>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.html" />
          <button className="btn btn-primary" onClick={() => void upload()}>上传</button>
          <p className="muted">商业书籍/会员资料仅上传有使用权的文件</p>
        </div>
        <UrlImport onImport={importUrl} />
        <div className="panel">
          <h4>清单批量导入</h4>
          <button className="btn" onClick={() => void importManifest()}>从默认清单导入</button>
          <p className="muted">条目来自 docs/references/knowledge-source-manifest.json</p>
        </div>
      </div>

      <div className="panel">
        <h4>文档（{docs.length}）</h4>
        <table className="mini-table">
          <thead>
            <tr><th>标题</th><th>来源</th><th>状态</th><th>版本</th><th>操作</th></tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td title={d.error ?? ''}>{d.title}{d.error ? ' ⚠' : ''}</td>
                <td>{d.sourceType}/{d.sourceTier}</td>
                <td>{STATUS_LABEL[d.status] ?? d.status}</td>
                <td>#{d.version}</td>
                <td className="actions">
                  <button onClick={() => void api(`/admin/knowledge/documents/${d.id}/preview`).then((p) => setPreview(p as DocPreview)).catch((e: Error) => setError(e.message))}>预览</button>
                  {d.status !== 'parsing' && (
                    <button onClick={() => void api(`/admin/knowledge/documents/${d.id}/reparse`, { method: 'POST' }).then(() => refresh()).catch((e: Error) => setError(e.message))}>重解析</button>
                  )}
                  {d.status === 'indexed' && (
                    <button className="btn-primary" onClick={() => void api(`/admin/knowledge/documents/${d.id}/publish`, { method: 'POST', body: {} }).then(() => refresh()).catch((e: Error) => setError(e.message))}>发布</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h4>检索调试</h4>
        <div className="admin-row">
          <input value={debugQuery} onChange={(e) => setDebugQuery(e.target.value)} placeholder="H2 是什么" />
          <button className="btn btn-primary" onClick={() => void runDebug()}>查询</button>
        </div>
        {debug && (
          <div className="debug-result">
            <p>变体：{debug.variants.join(' | ') || '（无）'}</p>
            <p>词项命中 {debug.termHits.length} · 向量命中 {debug.vectorHits.length} · 融合 {debug.fused.length} · 精排 {debug.reranked.length}</p>
            <ul>
              {debug.hits.map((h) => (
                <li key={h.chunkId}>
                  <strong>{h.docTitle}</strong>
                  {h.pageNo !== null && h.pageNo !== undefined ? ` · 第 ${h.pageNo} 页` : ''}
                  {h.figureId ? ` · 图 ${h.figureId.slice(0, 8)}` : ''} · {h.kind} · {h.sourceTier}
                  <pre>{h.snippet}</pre>
                </li>
              ))}
            </ul>
            {debug.notes.map((n) => (
              <p key={n} className="muted">· {n}</p>
            ))}
          </div>
        )}
      </div>

      <RuleCardsPanel onError={setError} />
      <CasesPanel onError={setError} />

      {preview && (
        <div className="panel">
          <div className="drawer-head">
            <h4>预览：{preview.document.title}（{STATUS_LABEL[preview.document.status]}，切块 {preview.chunks.length}）</h4>
            <button className="icon-btn" onClick={() => setPreview(null)} aria-label="关闭">✕</button>
          </div>
          <p className="muted">向量：{preview.vector.note}</p>
          <ul className="evidence-list">
            {preview.chunks.slice(0, 50).map((c) => (
              <li key={c.chunkId}>
                <span className="loc">#{c.chunkId.slice(0, 6)} {c.pageNo ? `· 第 ${c.pageNo} 页` : ''} {c.kind}</span>
                <pre className="evidence-text">{c.text}</pre>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function UrlImport({ onImport }: { onImport: (url: string) => Promise<void> }): JSX.Element {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="panel">
      <h4>URL 导入</h4>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
      <button
        className="btn"
        disabled={busy || url === ''}
        onClick={() => {
          setBusy(true)
          void onImport(url).finally(() => setBusy(false))
        }}
      >
        {busy ? '抓取中…' : '导入'}
      </button>
      <p className="muted">遇访问限制如实失败，不绕过</p>
    </div>
  )
}

interface RuleCard {
  id: string
  concept: string
  status: string
  version: number
  draftedBy: string
  content: { definition?: string; conditions?: string[]; context?: string; invalidation?: string; confusable?: string[]; counterExamples?: string[]; ruleId?: string; sourceNote?: string }
}

function RuleCardsPanel({ onError }: { onError: (msg: string) => void }): JSX.Element {
  const [cards, setCards] = useState<RuleCard[]>([])
  const [concept, setConcept] = useState('')
  const [editing, setEditing] = useState<RuleCard | null>(null)
  const [definition, setDefinition] = useState('')
  const [conditions, setConditions] = useState('')
  const [invalidation, setInvalidation] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ cards: RuleCard[] }>('/admin/knowledge/rule-cards')
      setCards(r.cards)
    } catch (e) {
      onError((e as Error).message)
    }
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const draft = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api<{ card: RuleCard }>('/admin/knowledge/rule-cards/draft', { method: 'POST', body: { concept } })
      setConcept('')
      await refresh()
      setEditing(r.card)
      setDefinition(r.card.content.definition ?? '')
      setConditions((r.card.content.conditions ?? []).join('；'))
      setInvalidation(r.card.content.invalidation ?? '')
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (editing === null) return
    try {
      await api(`/admin/knowledge/rule-cards/${editing.id}`, {
        method: 'PUT',
        body: {
          content: {
            definition,
            conditions: conditions.split(/[；;\n]/).map((x) => x.trim()).filter((x) => x !== ''),
            context: editing.content.context ?? '',
            invalidation,
            confusable: editing.content.confusable ?? [],
            counterExamples: editing.content.counterExamples ?? [],
            ruleId: editing.content.ruleId ?? '',
            sourceNote: '人工补全',
          },
        },
      })
      setEditing(null)
      await refresh()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const act = async (id: string, actName: 'publish' | 'delete'): Promise<void> => {
    try {
      await api(`/admin/knowledge/rule-cards/${id}/${actName === 'delete' ? '' : actName}`, {
        method: actName === 'delete' ? 'DELETE' : 'POST',
      })
      await refresh()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <div className="panel">
      <h4>规则卡（一概念一卡：草拟 → 人工审核 → 发布）</h4>
      <div className="admin-row">
        <input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="概念，如 h2 / barbwire / mtr" />
        <button className="btn btn-primary" disabled={busy || concept === ''} onClick={() => void draft()}>
          {busy ? '草拟中…' : '草拟（LLM/模板）'}
        </button>
      </div>
      <table className="mini-table">
        <thead><tr><th>概念</th><th>状态</th><th>版本</th><th>草拟来源</th><th>操作</th></tr></thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.id}>
              <td>{c.concept}</td>
              <td>{c.status}</td>
              <td>v{c.version}</td>
              <td>{c.draftedBy}</td>
              <td className="actions">
                {c.status === 'draft' && (
                  <button onClick={() => {
                    setEditing(c)
                    setDefinition(c.content.definition ?? '')
                    setConditions((c.content.conditions ?? []).join('；'))
                    setInvalidation(c.content.invalidation ?? '')
                  }}>编辑</button>
                )}
                {c.status === 'draft' && <button className="btn-primary" onClick={() => void act(c.id, 'publish')}>发布</button>}
                {c.status === 'draft' && <button onClick={() => void act(c.id, 'delete')}>删除</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing !== null && (
        <div className="rulecard-editor">
          <h5>审核「{editing.concept}」</h5>
          <label className="field"><span className="field-label">定义</span>
            <textarea value={definition} onChange={(e) => setDefinition(e.target.value)} rows={2} /></label>
          <label className="field"><span className="field-label">成立条件（；分隔）</span>
            <input value={conditions} onChange={(e) => setConditions(e.target.value)} /></label>
          <label className="field"><span className="field-label">失效条件</span>
            <input value={invalidation} onChange={(e) => setInvalidation(e.target.value)} /></label>
          <div className="admin-row">
            <button className="btn btn-primary" onClick={() => void saveDraft()}>保存草稿</button>
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

interface CaseWindow {
  id: string
  symbol: string
  interval: string
  atTime: number
  published: boolean
  annotation: string
  visibleContext: { regime?: string; alwaysIn?: string }
}

function CasesPanel({ onError }: { onError: (msg: string) => void }): JSX.Element {
  const [cases, setCases] = useState<CaseWindow[]>([])
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [interval, setIntervalStr] = useState('15m')
  const [annotation, setAnnotation] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ cases: CaseWindow[] }>('/admin/knowledge/cases?all=1')
      setCases(r.cases)
    } catch (e) {
      onError((e as Error).message)
    }
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const build = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('/admin/knowledge/cases', {
        method: 'POST',
        body: { symbol, marketType: 'usdm_perp', interval, annotation },
      })
      await refresh()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <h4>案例窗（可见上下文与未来结果分列；检索只返回可见字段）</h4>
      <div className="admin-row">
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="交易对" />
        <select value={interval} onChange={(e) => setIntervalStr(e.target.value)}>
          <option value="5m">5m</option>
          <option value="15m">15m</option>
          <option value="1h">1h</option>
          <option value="4h">4h</option>
        </select>
        <input value={annotation} onChange={(e) => setAnnotation(e.target.value)} placeholder="人工结构标注，如：多头回调 H2 二次进场" />
        <button className="btn btn-primary" disabled={busy} onClick={() => void build()}>{busy ? '构建中…' : '构建案例窗'}</button>
      </div>
      <table className="mini-table">
        <thead><tr><th>序列</th><th>决策时</th><th>状态</th><th>决策时结构</th><th>操作</th></tr></thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td>{c.symbol} {c.interval}</td>
              <td>{new Date(c.atTime).toLocaleString()}</td>
              <td>{c.published ? '已发布' : '待审核'}</td>
              <td>{c.visibleContext.regime ?? '-'} / {c.visibleContext.alwaysIn ?? '-'}</td>
              <td className="actions">
                {!c.published && (
                  <button className="btn-primary" onClick={() => void api(`/admin/knowledge/cases/${c.id}/publish`, { method: 'POST' }).then(() => refresh()).catch((e: Error) => onError(e.message))}>
                    发布
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
