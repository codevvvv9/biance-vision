import type { CSSProperties } from 'react'
/**
 * 规则卡（一概念一卡：LLM 草拟 → 人工审核 → 发布）。
 * 卡片栅格展示；草稿卡点击展开行内审核表单（定义/成立条件/失效条件）。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'

interface RuleCard {
  id: string
  concept: string
  status: string
  version: number
  draftedBy: string
  content: { definition?: string; conditions?: string[]; context?: string; invalidation?: string; confusable?: string[]; counterExamples?: string[]; ruleId?: string; sourceNote?: string }
}

export default function RuleCardsPanel({ onError }: { onError: (msg: string) => void }): JSX.Element {
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

  const startEdit = (c: RuleCard): void => {
    setEditing(c)
    setDefinition(c.content.definition ?? '')
    setConditions((c.content.conditions ?? []).join('；'))
    setInvalidation(c.content.invalidation ?? '')
  }

  const draft = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api<{ card: RuleCard }>('/admin/knowledge/rule-cards/draft', { method: 'POST', body: { concept } })
      setConcept('')
      await refresh()
      startEdit(r.card)
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
    <div className="panel fx-in" style={{ '--fx-i': 4 } as CSSProperties}>
      <h4>规则卡（一概念一卡：草拟 → 人工审核 → 发布）</h4>
      <div className="kb-rule-bar">
        <input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="概念，如 h2 / barbwire / mtr" />
        <button className="btn btn-primary" disabled={busy || concept === ''} onClick={() => void draft()}>
          {busy ? '草拟中…' : '草拟（LLM/模板）'}
        </button>
      </div>
      {cards.length === 0 ? (
        <p className="muted kb-empty">暂无规则卡——输入概念生成草稿，审核后发布供检索引用</p>
      ) : (
        <div className="kb-rule-grid">
          {cards.map((c) => (
            <div key={c.id} className={`kb-rule-card rc-${c.status}`}>
              <div className="kb-rule-head">
                <strong>{c.concept}</strong>
                <span className={`kb-badge ${c.status === 'published' ? 'ok' : c.status === 'draft' ? 'warn' : ''}`}>
                  {c.status === 'published' ? '已发布' : c.status === 'draft' ? '草稿' : c.status}
                </span>
              </div>
              <p className="kb-rule-def" title={c.content.definition ?? ''}>
                {c.content.definition ?? '（定义待补全）'}
              </p>
              {(c.content.conditions ?? []).length > 0 && (
                <p className="kb-rule-cond">条件：{(c.content.conditions ?? []).join('；')}</p>
              )}
              <div className="kb-rule-acts">
                <span className="kb-rule-meta">v{c.version} · {c.draftedBy}</span>
                {c.status === 'draft' && (
                  <>
                    <button onClick={() => startEdit(c)}>编辑</button>
                    <button className="btn-primary" onClick={() => void act(c.id, 'publish')}>发布</button>
                    <button onClick={() => void act(c.id, 'delete')}>删除</button>
                  </>
                )}
              </div>
              {editing !== null && editing.id === c.id && (
                <div className="kb-rule-editor">
                  <label className="field"><span className="field-label">定义</span>
                    <textarea value={definition} onChange={(e) => setDefinition(e.target.value)} rows={3} /></label>
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
          ))}
        </div>
      )}
    </div>
  )
}
