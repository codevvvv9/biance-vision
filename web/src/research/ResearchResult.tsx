/**
 * 研究结果卡与证据抽屉：
 * - 决策徽章 / 声明（事实 vs 解读）/ 条件情景 / 概率块（不可用时明示原因）
 * - productPayload：perp 计划盈亏矩阵与费用情景；event EV/盈亏平衡/倒计时
 * - 证据抽屉：冻结片段（支持/反证），点击定位（页码/图号/原文）
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import type { FollowUpAction, ResearchResult } from 'biance-vision-brooks'
import MiniMarkdown from '../components/MiniMarkdown'
import SourcePreviewModal, { type SourcePreviewTarget } from './SourcePreviewModal'

/** 决策 → research:result.decision.* 词典 key */
const DECISION_KEYS: Record<string, string> = {
  wait: 'research:result.decision.wait',
  hold: 'research:result.decision.hold',
  conditional_entry: 'research:result.decision.conditional_entry',
  reduce: 'research:result.decision.reduce',
  exit: 'research:result.decision.exit',
  long: 'research:result.decision.long',
  short: 'research:result.decision.short',
  insufficient_evidence: 'research:result.decision.insufficient_evidence',
  request_reconfirm: 'research:result.decision.request_reconfirm',
  monitor: 'research:result.decision.monitor',
  await_settlement: 'research:result.decision.await_settlement',
  settled: 'research:result.decision.settled',
}

// ---- P1-8 免责文案（红线 #10：服务端下发，前端只渲染不内置）----
// 模块级单次拉取（GET /api/config/research-ui），失败静默不显示（不硬编码文案兜底）。
let disclaimerCache: Record<string, string> | null = null
let disclaimerFetching: Promise<Record<string, string>> | null = null
function fetchDisclaimers(): Promise<Record<string, string>> {
  if (disclaimerCache !== null) return Promise.resolve(disclaimerCache)
  if (disclaimerFetching !== null) return disclaimerFetching
  disclaimerFetching = api<{ disclaimers?: Record<string, string> }>('/config/research-ui')
    .then((d) => {
      disclaimerCache = d.disclaimers ?? {}
      return disclaimerCache
    })
    .catch(() => {
      disclaimerFetching = null
      return {} as Record<string, string>
    })
  return disclaimerFetching
}

interface EvidenceItem {
  id: string
  stance: 'support' | 'counter'
  kind: string
  docTitle?: string
  pageNo: number | null
  figureId: string | null
  sourceTier: string | null
  text: string
  /** W2 流程 7（只增字段）：证据源投影——fileUrl 在且仅当源文档当前可读 */
  docId?: string | null
  contentHash?: string | null
  fileUrl?: string | null
  docUpdated?: boolean
}

interface StructureEventItem {
  id: string
  kind: string
  direction: string | null
  atTime: number
  knownAtTime: number | null
  provisional: boolean
  ruleId: string
  note: string
}

/**
 * 事件结果卡倒计时：唯一数据源是契约字段 quote.expiryAt（冻结的到期时刻），
 * 剩余时间为纯时钟换算（非数值估算），30s 自刷新一次
 */
function ExpiryCountdown({ expiryAt, asOfRemainingMs }: { expiryAt: number; asOfRemainingMs?: number }): JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const ms = expiryAt - now
  const frozen = asOfRemainingMs !== undefined ? t('research:result.asOfRemaining', { mins: Math.floor(asOfRemainingMs / 60000) }) : ''
  if (ms <= 0) return <>{t('research:result.expired', { time: new Date(expiryAt).toLocaleString() })}{frozen}</>
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return (
    <>
      {t('research:result.countdown', { mins, secs, time: new Date(expiryAt).toLocaleString() })}{frozen}
    </>
  )
}

export function ResultCard({ result, horizon, runId, onCitation, onFollowUp }: { result: ResearchResult; horizon?: string; runId?: string; onCitation?: (evidenceId: string) => void; onFollowUp?: (action: FollowUpAction) => void }): JSX.Element {
  const { t } = useTranslation()
  // 论断引用定位（P2）：evidenceIds → 可点击标记，展开冻结原文（页码/来源/文档）
  const [evidenceMap, setEvidenceMap] = useState<Map<string, EvidenceItem> | null>(null)
  const [openEvidence, setOpenEvidence] = useState<string | null>(null)
  // W2 流程 7：引用定位 → 只读原文预览（fileUrl 由服务端按当前 access 判权给出）
  const [sourceTarget, setSourceTarget] = useState<SourcePreviewTarget | null>(null)
  // P1-8 免责文案（服务端配置，按产品；失败静默）
  const [disclaimer, setDisclaimer] = useState('')
  useEffect(() => {
    let alive = true
    void fetchDisclaimers().then((d) => {
      if (!alive) return
      const kind = (result as unknown as { payload?: { kind?: string } }).payload?.kind
      setDisclaimer(kind === 'perp' ? d.perp ?? '' : kind === 'event' ? d.event ?? '' : d.common ?? '')
    })
    return () => { alive = false }
  }, [result])
  const hasCitations = result.claims.some((c) => c.evidenceIds.length > 0)
  const citationIds = [...new Set(result.claims.flatMap((c) => c.evidenceIds))]
  useEffect(() => {
    setEvidenceMap(null)
    setOpenEvidence(null)
    if (!runId || !hasCitations || onCitation) return
    let alive = true
    api<{ evidence: EvidenceItem[] }>(`/research/runs/${runId}/evidence`)
      .then((r) => {
        if (alive) setEvidenceMap(new Map(r.evidence.map((e) => [e.id, e])))
      })
      .catch(() => {
        /* 引用拉取失败时标记降级为编号，不阻塞结果展示 */
      })
    return () => {
      alive = false
    }
  }, [runId, hasCitations, onCitation])
  const r2 = result as unknown as {
    schemaVersion?: number
    decision: string
    reasons?: string[]
    side?: string | null
    probability: { probabilityUp: number; probabilityTie: number | null; modelVersion: string } | null
    unavailableCode?: string | null
    /** P0-5 受控降级：修复耗尽后仅保留代码计算内容发布 */
    degraded?: boolean
    degradedReasons?: string[]
    /** P1-2 受约束综合解释（回应原问题） */
    synthesis?: { text: string; source: 'llm' | 'template'; degraded?: boolean } | null
    /** P1-3 结构化追问动作集 */
    followUpActions?: FollowUpAction[]
    payload: Record<string, unknown>
  }
  const pp = r2?.payload ?? {}
  const decisionLabel = DECISION_KEYS[result.decision] !== undefined ? t(DECISION_KEYS[result.decision]) : result.decision
  return (
    <div className="result-card fx-in">
      <div className="result-head">
        <span className={`decision-badge d-${result.decision}`}>{decisionLabel}{r2?.side !== null && r2?.side !== undefined && r2.decision === 'conditional_entry' ? `（${t(r2.side === 'long' ? 'research:result.sideLong' : 'research:result.sideShort')}）` : ''}</span>
        <span className={`quality q-${result.evidenceQuality}`}>
          {result.evidenceQuality === 'complete' ? t('research:result.evidenceComplete') : result.evidenceQuality === 'partial' ? t('research:result.evidencePartial') : t('research:result.evidenceStale')}
        </span>
        {(pp.researchMode === true || horizon === '1w') && (
          <span className="mode-tag" role="note">
            {t('research:result.researchModeTag')}
          </span>
        )}
        {r2?.degraded === true && (
          <span className="mode-tag degraded-tag" role="note" aria-label={t('research:result.degradedTagAria')}>
            {t('research:result.degradedTag')}
          </span>
        )}
      </div>
      {r2?.degraded === true && (r2?.degradedReasons ?? []).length > 0 && (
        <ul className="missing-list">
          <li>{t('research:result.degradedReason')}</li>
          {(r2?.degradedReasons ?? []).slice(0, 5).map((x) => (
            <li key={x}>· {x}</li>
          ))}
        </ul>
      )}
      {r2?.synthesis != null && r2.synthesis.text !== '' && (
        <div className="synthesis-block" aria-label={t('research:result.synthesisAria')}>
          <div className="synthesis-head">
            <span>{t('research:result.synthesisTitle')}</span>
            <span className="synthesis-src">{r2.synthesis.source === 'llm' ? (r2.synthesis.degraded === true ? t('research:result.synthesisLlmDegraded') : t('research:result.synthesisLlm')) : t('research:result.synthesisCode')}</span>
          </div>
          <MiniMarkdown text={r2.synthesis.text} className="synthesis-md" />
        </div>
      )}
      {r2?.probability === null || r2?.probability === undefined ? (
        <p className="prob-note">{t('research:result.probUnavailable', { code: r2?.unavailableCode ?? 'model_not_published' })}</p>
      ) : (
        <p className="prob-note">
          {t('research:result.probLine', { version: r2.probability.modelVersion, up: (r2.probability.probabilityUp * 100).toFixed(1), tie: r2.probability.probabilityTie !== null ? t('research:result.probTie', { pct: (r2.probability.probabilityTie * 100).toFixed(1) }) : t('research:result.probTieUnknown') })}
        </p>
      )}
      {Array.isArray(pp.unavailableGuidance) && (pp.unavailableGuidance as string[]).length > 0 && (
        <ul className="guidance-list" aria-label={t('research:result.guidanceAria')}>
          {(pp.unavailableGuidance as string[]).map((g) => (
            <li key={g}>· {g}</li>
          ))}
        </ul>
      )}
      {(r2?.reasons ?? []).length > 0 && (
        <ul className="missing-list">{(r2?.reasons ?? []).map((x) => <li key={x}>{t('research:result.reason', { reason: x })}</li>)}</ul>
      )}
      {result.missingInputs.length > 0 && (
        <ul className="missing-list">
          {result.missingInputs.map((m) => (
            <li key={m}>{t('research:result.missingInput', { field: m })}</li>
          ))}
        </ul>
      )}
      <h5>{t('research:result.claimsTitle')}</h5>
      <ul className="claim-list">
        {result.claims.map((c, i) => (
          <li key={i} className={c.kind}>
            <em>{c.kind === 'fact' ? t('research:result.claimFact') : t('research:result.claimInterpretation')}</em>
            {c.text}
            {c.evidenceIds.map((eid, j) => {
              const ev = evidenceMap?.get(eid)
              return (
                <span key={eid} className="cite-wrap">
                  <button
                    className={`cite-mark c-${ev?.stance ?? 'unknown'}`}
                    onClick={() => onCitation ? onCitation(eid) : setOpenEvidence(openEvidence === `${i}:${eid}` ? null : `${i}:${eid}`)}
                    aria-label={onCitation ? t('research:result.viewCitation', { n: citationIds.indexOf(eid) + 1 }) : ev ? t('research:result.viewCitationDetail', { n: j + 1, title: ev.docTitle ?? ev.kind, page: ev.pageNo !== null ? t('research:result.pageNo', { page: ev.pageNo }) : '' }) : t('research:result.citationNotLoaded', { n: j + 1 })}
                    title={ev ? `${ev.docTitle ?? ev.kind}${ev.pageNo !== null ? t('research:result.pageNoTitle', { page: ev.pageNo }) : ''}${ev.sourceTier !== null ? ` · ${ev.sourceTier}` : ''}` : t('research:result.citationMissing')}
                  >
                    [{onCitation ? citationIds.indexOf(eid) + 1 : j + 1}]
                  </button>
                  {openEvidence === `${i}:${eid}` && ev !== undefined && (
                    <span className="cite-popover" role="note">
                      <span className="cite-pop-head">
                        <span className={`stance s-${ev.stance}`}>{ev.stance === 'support' ? t('research:result.support') : t('research:result.counter')}</span>
                        <span className="loc">
                          {ev.docTitle !== '' && ev.docTitle !== undefined ? `${ev.docTitle}` : ev.kind === 'knowledge_chunk' ? t('research:result.knowledgeChunk') : ev.kind}
                          {ev.pageNo !== null ? t('research:result.pageNoTitle', { page: ev.pageNo }) : ''}
                          {ev.figureId !== null ? t('research:result.figureShort', { id: ev.figureId.slice(0, 8) }) : ''}
                          {ev.sourceTier !== null ? ` · ${ev.sourceTier}` : ''}
                        </span>
                      </span>
                      <MiniMarkdown text={ev.text} className="evidence-md" />
                      {ev.fileUrl != null && ev.fileUrl !== '' && (
                        <button
                          className="cite-source-btn"
                          onClick={() =>
                            setSourceTarget({
                              evidenceId: ev.id,
                              docTitle: ev.docTitle ?? '',
                              pageNo: ev.pageNo,
                              fileUrl: ev.fileUrl ?? '',
                              docUpdated: ev.docUpdated === true,
                            })
                          }
                        >
                          {t('research:result.viewSource')}
                        </button>
                      )}
                    </span>
                  )}
                </span>
              )
            })}
          </li>
        ))}
      </ul>
      {result.scenarios.length > 0 && (
        <>
          <h5>{t('research:result.scenariosTitle')}</h5>
          <div className="scenario-list">
            {result.scenarios.map((s, i) => (
              <div key={i} className="scenario">
                <p><strong>{t('research:result.condition')}</strong>：{s.condition}</p>
                <p><strong>{t('research:result.response')}</strong>：{s.response}</p>
                <p><strong>{t('research:result.invalidation')}</strong>：{s.invalidation}</p>
              </div>
            ))}
          </div>
        </>
      )}
      {onFollowUp !== undefined && (r2?.followUpActions ?? []).length > 0 && (
        <div className="follow-up-chips" aria-label={t('research:result.nextStepsAria')}>
          {(r2?.followUpActions ?? []).map((a) => (
            <button key={`${a.action}:${a.label}`} className="follow-up-chip" onClick={() => onFollowUp(a)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {pp.kind === 'perp' && Array.isArray(pp.pnlPoints) && (
        <>
          <h5>
            {t('research:result.plTitle')}
            {pp.feeLegs !== null && pp.feeLegs !== undefined && (
              <span className="muted fee-legs-note"> — {(pp.feeLegs as { note: string }).note}</span>
            )}
          </h5>
          {pp.fundingStale === true && (
            <p className="liq-note stale-warn" role="note">{t('research:result.fundingStaleNote')}</p>
          )}
          {pp.riskCap !== null && pp.riskCap !== undefined && (
            <p className="liq-note">
              {(pp.riskCap as { ok: boolean; maxQty: number | null; reason: string | null; bindingConstraint?: string | null }).ok
                ? t('research:result.riskCapOk', { max: (pp.riskCap as { maxQty: number | null }).maxQty ?? t('research:result.riskCapUnknown') })
                : t('research:result.riskCapUnavailable', { reason: (pp.riskCap as { reason: string | null }).reason ?? t('research:result.riskCapUnknownReason') })}
              {(pp.riskCap as { bindingConstraint?: string | null }).bindingConstraint != null &&
                t('research:result.bindingConstraint', { constraint: (pp.riskCap as { bindingConstraint?: string | null }).bindingConstraint })}
            </p>
          )}
          <table className="mini-table">
            <thead>
              <tr><th>{t('research:result.colPrice')}</th><th>{t('research:result.colNetPnl')}</th><th>{t('research:result.colIncPnl')}</th><th>ROE</th></tr>
            </thead>
            <tbody>
              {(pp.pnlPoints as { price: number; tradeNetPnl: number; incrementalPnl: number; roe: number }[]).map((r) => (
                <tr key={r.price}>
                  <td>{r.price.toFixed(1)}</td>
                  <td className={r.tradeNetPnl >= 0 ? 'up' : 'down'}>{r.tradeNetPnl.toFixed(2)}</td>
                  <td>{r.incrementalPnl.toFixed(2)}</td>
                  <td>{(r.roe * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pp.liquidation !== undefined && pp.liquidation !== null && (
            <p className="liq-note">{t('research:result.liqPrice', { price: (pp.liquidation as { price: number | null }).price ?? t('research:result.riskCapUnknown'), note: (pp.liquidation as { note: string }).note })}</p>
          )}
          {pp.reducePlan !== undefined && (pp.reducePlan as { needed: boolean }).needed === true && (
            <p className="liq-note">{t('research:result.reducePlan', { keep: (pp.reducePlan as { keepQty: number | null }).keepQty, reduce: (pp.reducePlan as { reduceQty: number | null }).reduceQty, reason: (pp.reducePlan as { reason: string }).reason })}</p>
          )}
          {Array.isArray(pp.fundingScenarios) && (pp.fundingScenarios as unknown[]).length > 0 && (
            <p className="liq-note">{t('research:result.funding', { items: (pp.fundingScenarios as { label: string; cost24h: number }[]).map((f) => `${f.label}≈${f.cost24h}/24h`).join('；'), note: String(pp.fundingNote ?? '') })}</p>
          )}
        </>
      )}
      {pp.kind === 'event' && pp.quote !== null && pp.quote !== undefined && (
        <>
          <h5>{t('research:result.eventTitle')}</h5>
          <table className="mini-table">
            <tbody>
              <tr><td>{t('research:result.orderState')}</td><td>{(pp.quote as { orderState: string }).orderState === 'submitted' ? t('research:result.orderSubmitted') : t('research:result.orderPreview', { expired: (pp.quote as { previewExpired: boolean }).previewExpired ? t('research:result.orderPreviewExpired') : '' })}</td></tr>
              <tr>
                <td>{t('research:result.countdownRow')}</td>
                <td>
                  <ExpiryCountdown
                    expiryAt={(pp.quote as { expiryAt: number }).expiryAt}
                    asOfRemainingMs={(pp.quote as { remainingMs?: number }).remainingMs}
                  />
                </td>
              </tr>
              <tr><td>{t('research:result.breakevenRow')}</td><td>{((pp.breakevenWinRate as number) * 100).toFixed(1)}%{t('research:result.breakevenNote')}</td></tr>
              <tr><td>{t('research:result.winLoseRow')}</td><td>{String(pp.winAmount)} / {String(pp.loseAmount)}</td></tr>
              <tr><td>{t('research:result.pWinRow')}</td><td>{pp.pWin === null || pp.pWin === undefined ? t('research:result.evUnavailable') : `${((pp.pWin as number) * 100).toFixed(1)}%`}{pp.pTie === null || pp.pTie === undefined ? t('research:result.pTieNote') : ` / ${((pp.pTie as number) * 100).toFixed(1)}%`}</td></tr>
              <tr><td>{t('research:result.evRow')}</td><td>{pp.expectedNet === null || pp.expectedNet === undefined ? t('research:result.evUnavailable') : String(pp.expectedNet)}</td></tr>
              {typeof pp.unavailableCode === 'string' && (
                <tr><td>{t('research:result.unavailableRow')}</td><td>{String(pp.unavailableCode)}：{String(pp.unavailableDetail ?? '')}</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
      {disclaimer !== '' && <p className="disclaimer-line" role="note">{disclaimer}</p>}
      {sourceTarget !== null && <SourcePreviewModal target={sourceTarget} onClose={() => setSourceTarget(null)} />}
    </div>
  )
}

export function EvidenceDrawer({ runId, open, onClose, onLocateBar, embedded = false, selectedEvidenceId, citationIds = [] }: { runId: string; open: boolean; onClose: () => void; onLocateBar?: (atTime: number) => void; embedded?: boolean; selectedEvidenceId?: string | null; citationIds?: string[] }): JSX.Element {
  const { t } = useTranslation()
  const [items, setItems] = useState<EvidenceItem[] | null>(null)
  const [structures, setStructures] = useState<StructureEventItem[]>([])
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sourceTarget, setSourceTarget] = useState<SourcePreviewTarget | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!open || !selectedEvidenceId || items === null) return
    setExpanded(selectedEvidenceId)
    const el = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-evidence-id]') ?? []).find((item) => item.dataset.evidenceId === selectedEvidenceId)
    el?.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior })
  }, [items, selectedEvidenceId, open])

  // 拉取按 runId 键控：切换 run 时先清空再重取，杜绝展示上一个 run 的缓存证据
  useEffect(() => {
    setItems(null)
    setStructures([])
    setError('')
    setExpanded(null)
    if (!open) return
    let alive = true
    api<{ evidence: EvidenceItem[]; structures?: StructureEventItem[] }>(`/research/runs/${runId}/evidence`)
      .then((r) => {
        if (!alive) return
        setItems(r.evidence)
        setStructures(r.structures ?? [])
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [open, runId])

  if (!open) return <></>
  return (
    <div className={embedded ? 'wb-evidence-content' : 'evidence-drawer'} role={embedded ? undefined : 'dialog'} aria-label={t('research:result.evidenceDrawerAria')}>
      <div className="drawer-head">
        <strong>{t('research:result.evidenceTitle', { count: items?.length ?? '…' })}</strong>
        {!embedded && <button className="icon-btn" onClick={onClose} aria-label={t('common:toast.close')}>✕</button>}
      </div>
      {error && <p className="err-text">{error}</p>}
      {items !== null && items.length === 0 && <p className="muted">{t('research:result.evidenceEmpty')}</p>}
      {items === null && !error && <p className="dim" role="status">{t('research:result.evidenceLoading')}</p>}
      {selectedEvidenceId && items && !items.some((e) => e.id === selectedEvidenceId) && <p className="err-text">{t('research:result.citationNotInRun')}</p>}
      <ul className="evidence-list" ref={listRef}>
        {(items ?? []).map((e) => (
          <li key={e.id} data-evidence-id={e.id} className={`${e.stance}${e.id === selectedEvidenceId ? ' selected' : ''}`}>
            <button className="evidence-toggle" aria-expanded={expanded === e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
              {citationIds.includes(e.id) && <span className="wb-cite-number">[{citationIds.indexOf(e.id) + 1}]</span>}
              <span className={`stance s-${e.stance}`}>{e.stance === 'support' ? t('research:result.support') : t('research:result.counter')}</span>
              <span className="loc">
                {e.docTitle !== undefined && e.docTitle !== '' ? e.docTitle : e.kind === 'knowledge_chunk' ? t('research:result.knowledgeChunk') : e.kind}
                {e.pageNo !== null ? t('research:result.pageNoTitle', { page: e.pageNo }) : ''}
                {e.figureId !== null ? t('research:result.figureShort', { id: e.figureId.slice(0, 8) }) : ''}
                {e.sourceTier !== null ? ` · ${e.sourceTier}` : ''}
              </span>
            </button>
            {expanded === e.id && (
              <div className="evidence-card-body">
                <MiniMarkdown text={e.text} className="evidence-md" />
                {e.fileUrl != null && e.fileUrl !== '' && (
                  <button
                    className="cite-source-btn"
                    onClick={() =>
                      setSourceTarget({
                        evidenceId: e.id,
                        docTitle: e.docTitle ?? '',
                        pageNo: e.pageNo,
                        fileUrl: e.fileUrl ?? '',
                        docUpdated: e.docUpdated === true,
                      })
                    }
                  >
                    {t('research:result.viewSource')}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {structures.length > 0 && (
        <>
          <div className="drawer-head">
            <strong>{t('research:result.structuresTitle', { count: structures.length })}</strong>
          </div>
          <ul className="evidence-list">
            {structures.map((s) => (
              <li key={s.id}>
                <button
                  className="evidence-toggle"
                  onClick={() => onLocateBar?.(s.atTime)}
                  aria-label={t('research:result.locateAria', { kind: s.kind })}
                >
                  <span className={`stance ${s.provisional ? 's-counter' : 's-support'}`}>{s.provisional ? t('research:result.pending') : t('research:result.confirmedTag')}</span>
                  <span className="loc">
                    {s.kind}
                    {s.direction !== null ? ` · ${s.direction === 'long' ? t('research:result.sideLong') : s.direction === 'short' ? t('research:result.sideShort') : s.direction}` : ''}
                    {' · '}{new Date(s.atTime).toLocaleTimeString()}
                    {s.knownAtTime !== null ? t('research:result.confirmedAt', { time: new Date(s.knownAtTime).toLocaleTimeString() }) : ''}
                  </span>
                </button>
                {s.note !== '' && (
                  <div className="evidence-card-body">
                    <MiniMarkdown text={s.note} className="evidence-md" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {sourceTarget !== null && <SourcePreviewModal target={sourceTarget} onClose={() => setSourceTarget(null)} />}
    </div>
  )
}
