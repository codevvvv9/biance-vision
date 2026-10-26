'use client'

import { brand } from '@biance/brand/identity'

import { useState } from 'react'
import { demos, demoPaths } from '@/lib/demo-content'
import { text, type Locale } from '@/lib/site'
import { Chart } from './Chart'
import { Arrow } from './Icons'

export function ResearchDemo({ locale, compact = false }: { locale: Locale; compact?: boolean }) {
  const cases = demos(locale)
  const [selected, setSelected] = useState(0)
  const [active, setActive] = useState(0)
  const [mobileTab, setMobileTab] = useState('chart')
  const d = cases[selected]
  return <div className={`demo-shell ${compact ? 'compact-demo' : ''}`}>
    <div className="demo-topbar"><span className="demo-brand"><img src="/site-assets/mark.svg" width="18" height="18" alt="" /> {brand.name} <span className="muted">/ {text(locale, 'RESEARCH', '研究')}</span></span><span className="demo-label"><span />{text(locale, 'ILLUSTRATIVE DEMO · NOT LIVE', '教学演示 · 非实时研究')}</span></div>
    <div className="demo-case-tabs" role="tablist" onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? cases.length - 1 : (selected + (event.key === 'ArrowRight' ? 1 : cases.length - 1)) % cases.length; setSelected(next); setActive(0); document.getElementById(`case-tab-${cases[next].id}`)?.focus() }} aria-label={text(locale, 'Teaching cases', '教学案例')}>{cases.map((c, i) => <button key={c.id} role="tab" tabIndex={i === selected ? 0 : -1} aria-selected={i === selected} aria-controls="case-panel" id={`case-tab-${c.id}`} onClick={() => { setSelected(i); setActive(0) }}><span>{c.number}</span>{c.label}</button>)}</div>
    <div className="demo-case-content" id="case-panel" role="tabpanel" aria-labelledby={`case-tab-${d.id}`}>
      <div className="mobile-demo-tabs" role="group" aria-label={text(locale, 'Demo view', '演示视图')}>{[['chart', text(locale, 'Chart', '图表')], ['conclusion', text(locale, 'Conclusion', '结论')], ['evidence', text(locale, 'Evidence', '证据')]].map(([id, label]) => <button key={id} aria-pressed={mobileTab === id} onClick={() => setMobileTab(id)}>{label}</button>)}</div>
      <div className="demo-grid" data-mobile-tab={mobileTab}>
        <div className="demo-chart-pane"><div className="chart-heading"><span>BTC <span className="muted">/ USDT</span></span><span className="chart-timeframe">{text(locale, 'TEACHING SNAPSHOT', '教学快照')}</span><span>1H</span></div><Chart locale={locale} demo={d.id} active={active} hero={compact} /><div className="chart-caption"><span className="status-dot" />{text(locale, 'Frozen context. Traceable reasoning.', '冻结上下文，追溯每一步推理。')}</div></div>
        <div className="demo-result-pane">
          <div className="demo-conclusion"><div className="eyebrow">{text(locale, 'THE RESEARCH VIEW', '研究结论')}</div><div className="waiting-badge">{text(locale, 'WAIT FOR CONFIRMATION', '等待确认')}</div><h3>{d.conclusion}</h3><p>{d.context}</p></div>
          <div className="demo-evidence"><span className="eyebrow">{text(locale, 'FOLLOW THE EVIDENCE', '沿证据阅读')}</span>{d.evidence.map((e, i) => <button className={`evidence-item ${active === i ? 'selected' : ''}`} key={e} onClick={() => setActive(i)} aria-pressed={active === i}><span className="evidence-number">0{i + 1}</span><span>{e}</span><Arrow diagonal /></button>)}<button className={`evidence-item counter ${active === 2 ? 'selected' : ''}`} onClick={() => setActive(2)} aria-pressed={active === 2}><span className="evidence-number">↔</span><span>{d.counter}</span><Arrow diagonal /></button></div>
        </div>
      </div>
      <details className="invalidation"><summary><span className="condition-symbol">⊘</span>{text(locale, 'What would change this view?', '什么会改变这个判断？')}<span className="details-plus">+</span></summary><p>{d.invalidation}</p></details>
    </div>
    <details className="case-transcripts"><summary>{text(locale, 'Explore the three complete case studies', '查看三个完整教学案例')}</summary><div className="no-script-cases">{cases.map(c => <article key={c.id}><h3><a href={`/${locale}/demo/${demoPaths[c.id]}`}>{c.label} ↗</a></h3><p>{c.context}</p></article>)}</div></details>
    <div className="demo-bottom"><span>{text(locale, 'Your next question deserves this level of clarity.', '让你的下一个问题，也拥有这样的清晰度。')}</span><a href={`/${locale}/contact`}>{text(locale, 'Request access', '申请开通')} <Arrow /></a></div>
  </div>
}
