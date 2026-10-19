/**
 * 研究结果卡与证据抽屉：
 * - 决策徽章 / 声明（事实 vs 解读）/ 条件情景 / 概率块（不可用时明示原因）
 * - productPayload：perp 计划盈亏矩阵与费用情景；event EV/盈亏平衡/倒计时
 * - 证据抽屉：冻结片段（支持/反证），点击定位（页码/图号/原文）
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ResearchResult } from 'biance-vision-brooks'
import MiniMarkdown from '../components/MiniMarkdown'

const DECISION_LABEL: Record<string, string> = {
  wait: '等待',
  hold: '持有',
  conditional_entry: '条件参与',
  reduce: '减仓',
  exit: '退出',
  long: '做多',
  short: '做空',
  insufficient_evidence: '证据不足',
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
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const ms = expiryAt - now
  const frozen = asOfRemainingMs !== undefined ? `（运行 asOf 时剩 ${Math.floor(asOfRemainingMs / 60000)} 分）` : ''
  if (ms <= 0) return <>已到期（{new Date(expiryAt).toLocaleString()}）{frozen}</>
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return (
    <>
      剩 {mins} 分 {secs} 秒（到期 {new Date(expiryAt).toLocaleString()}）{frozen}
    </>
  )
}

export function ResultCard({ result, horizon, runId, onCitation }: { result: ResearchResult; horizon?: string; runId?: string; onCitation?: (evidenceId: string) => void }): JSX.Element {
  // 论断引用定位（P2）：evidenceIds → 可点击标记，展开冻结原文（页码/来源/文档）
  const [evidenceMap, setEvidenceMap] = useState<Map<string, EvidenceItem> | null>(null)
  const [openEvidence, setOpenEvidence] = useState<string | null>(null)
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
    payload: Record<string, unknown>
  }
  const pp = r2?.payload ?? {}
  const DECISION_LABEL_V2: Record<string, string> = { ...DECISION_LABEL, request_reconfirm: '请重新确认持仓', monitor: '监控订单', await_settlement: '等待结算', settled: '已结算' }
  return (
    <div className="result-card fx-in">
      <div className="result-head">
        <span className={`decision-badge d-${result.decision}`}>{(DECISION_LABEL_V2[result.decision] ?? DECISION_LABEL[result.decision]) ?? result.decision}{r2?.side !== null && r2?.side !== undefined && r2.decision === 'conditional_entry' ? `（${r2.side === 'long' ? '多' : '空'}）` : ''}</span>
        <span className={`quality q-${result.evidenceQuality}`}>
          证据{result.evidenceQuality === 'complete' ? '完整' : result.evidenceQuality === 'partial' ? '部分' : '过期/不足'}
        </span>
        {(pp.researchMode === true || horizon === '1w') && (
          <span className="mode-tag" role="note">
            研究模式（非币安事件合约产品）
          </span>
        )}
        {r2?.degraded === true && (
          <span className="mode-tag degraded-tag" role="note" aria-label="降级发布">
            降级发布
          </span>
        )}
      </div>
      {r2?.degraded === true && (r2?.degradedReasons ?? []).length > 0 && (
        <ul className="missing-list">
          <li>降级原因（已剔除未经校验的归纳内容，仅保留代码计算结论）：</li>
          {(r2?.degradedReasons ?? []).slice(0, 5).map((x) => (
            <li key={x}>· {x}</li>
          ))}
        </ul>
      )}
      {r2?.probability === null || r2?.probability === undefined ? (
        <p className="prob-note">概率：不可用（{r2?.unavailableCode ?? 'model_not_published'}；不由 AI 编造）</p>
      ) : (
        <p className="prob-note">
          模型 {r2.probability.modelVersion}：P(高于执行价) = {(r2.probability.probabilityUp * 100).toFixed(1)}%{r2.probability.probabilityTie !== null ? `，平价 ${(r2.probability.probabilityTie * 100).toFixed(1)}%` : '（平价精度未知）'}
        </p>
      )}
      {(r2?.reasons ?? []).length > 0 && (
        <ul className="missing-list">{(r2?.reasons ?? []).map((x) => <li key={x}>理由：{x}</li>)}</ul>
      )}
      {result.missingInputs.length > 0 && (
        <ul className="missing-list">
          {result.missingInputs.map((m) => (
            <li key={m}>缺少输入：{m}</li>
          ))}
        </ul>
      )}
      <h5>论断</h5>
      <ul className="claim-list">
        {result.claims.map((c, i) => (
          <li key={i} className={c.kind}>
            <em>{c.kind === 'fact' ? '事实' : '解读'}</em>
            {c.text}
            {c.evidenceIds.map((eid, j) => {
              const ev = evidenceMap?.get(eid)
              return (
                <span key={eid} className="cite-wrap">
                  <button
                    className={`cite-mark c-${ev?.stance ?? 'unknown'}`}
                    onClick={() => onCitation ? onCitation(eid) : setOpenEvidence(openEvidence === `${i}:${eid}` ? null : `${i}:${eid}`)}
                    aria-label={onCitation ? `查看引用 ${citationIds.indexOf(eid) + 1}` : ev ? `查看引用 ${j + 1}：${ev.docTitle ?? ev.kind}${ev.pageNo !== null ? ` 第${ev.pageNo}页` : ''}` : `引用 ${j + 1}（详情未加载）`}
                    title={ev ? `${ev.docTitle ?? ev.kind}${ev.pageNo !== null ? ` · 第 ${ev.pageNo} 页` : ''}${ev.sourceTier !== null ? ` · ${ev.sourceTier}` : ''}` : '引用详情未加载'}
                  >
                    [{onCitation ? citationIds.indexOf(eid) + 1 : j + 1}]
                  </button>
                  {openEvidence === `${i}:${eid}` && ev !== undefined && (
                    <span className="cite-popover" role="note">
                      <span className="cite-pop-head">
                        <span className={`stance s-${ev.stance}`}>{ev.stance === 'support' ? '支持' : '反证'}</span>
                        <span className="loc">
                          {ev.docTitle !== '' && ev.docTitle !== undefined ? `${ev.docTitle}` : ev.kind === 'knowledge_chunk' ? '知识片段' : ev.kind}
                          {ev.pageNo !== null ? ` · 第 ${ev.pageNo} 页` : ''}
                          {ev.figureId !== null ? ` · 图 ${ev.figureId.slice(0, 8)}` : ''}
                          {ev.sourceTier !== null ? ` · ${ev.sourceTier}` : ''}
                        </span>
                      </span>
                      <MiniMarkdown text={ev.text} className="evidence-md" />
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
          <h5>条件情景</h5>
          <div className="scenario-list">
            {result.scenarios.map((s, i) => (
              <div key={i} className="scenario">
                <p><strong>条件</strong>：{s.condition}</p>
                <p><strong>应对</strong>：{s.response}</p>
                <p><strong>失效</strong>：{s.invalidation}</p>
              </div>
            ))}
          </div>
        </>
      )}
      {pp.kind === 'perp' && Array.isArray(pp.pnlPoints) && (
        <>
          <h5>
            计划盈亏矩阵（taker 双边费用）
            {pp.feeLegs !== null && pp.feeLegs !== undefined && (
              <span className="muted fee-legs-note"> — {(pp.feeLegs as { note: string }).note}</span>
            )}
          </h5>
          {pp.fundingStale === true && (
            <p className="liq-note stale-warn" role="note">资金费率数据过期（funding_stale）：不提供情景估算，不以旧数据伪装实际统计</p>
          )}
          {pp.riskCap !== null && pp.riskCap !== undefined && (
            <p className="liq-note">
              仓位上限：{(pp.riskCap as { ok: boolean; maxQty: number | null; reason: string | null; bindingConstraint?: string | null }).ok
                ? `≤ ${(pp.riskCap as { maxQty: number | null }).maxQty ?? '未知'}`
                : `不可用（${(pp.riskCap as { reason: string | null }).reason ?? '未知原因'}）`}
              {(pp.riskCap as { bindingConstraint?: string | null }).bindingConstraint != null &&
                `；触发约束：${(pp.riskCap as { bindingConstraint?: string | null }).bindingConstraint}`}
            </p>
          )}
          <table className="mini-table">
            <thead>
              <tr><th>价格</th><th>整笔净盈亏</th><th>增量盈亏</th><th>ROE</th></tr>
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
            <p className="liq-note">强平价：{(pp.liquidation as { price: number | null }).price ?? '未知'}（{(pp.liquidation as { note: string }).note}）</p>
          )}
          {pp.reducePlan !== undefined && (pp.reducePlan as { needed: boolean }).needed === true && (
            <p className="liq-note">减仓计划：保留 ≤{(pp.reducePlan as { keepQty: number | null }).keepQty}，减 {(pp.reducePlan as { reduceQty: number | null }).reduceQty}（{(pp.reducePlan as { reason: string }).reason}）</p>
          )}
          {Array.isArray(pp.fundingScenarios) && (pp.fundingScenarios as unknown[]).length > 0 && (
            <p className="liq-note">资金费率（实际数据）：{(pp.fundingScenarios as { label: string; cost24h: number }[]).map((f) => `${f.label}≈${f.cost24h}/24h`).join('；')}——{String(pp.fundingNote ?? '')}</p>
          )}
        </>
      )}
      {pp.kind === 'event' && pp.quote !== null && pp.quote !== undefined && (
        <>
          <h5>事件合约评估</h5>
          <table className="mini-table">
            <tbody>
              <tr><td>订单状态</td><td>{(pp.quote as { orderState: string }).orderState === 'submitted' ? '已提交（固定值；不建议提前平仓）' : `参与前预览${(pp.quote as { previewExpired: boolean }).previewExpired ? '（预览已过期请刷新）' : ''}`}</td></tr>
              <tr>
                <td>倒计时</td>
                <td>
                  <ExpiryCountdown
                    expiryAt={(pp.quote as { expiryAt: number }).expiryAt}
                    asOfRemainingMs={(pp.quote as { remainingMs?: number }).remainingMs}
                  />
                </td>
              </tr>
              <tr><td>盈亏平衡胜率</td><td>{((pp.breakevenWinRate as number) * 100).toFixed(1)}%（非平价条件）</td></tr>
              <tr><td>赢净得 / 输损失</td><td>{String(pp.winAmount)} / {String(pp.loseAmount)}</td></tr>
              <tr><td>P(赢)/平价</td><td>{pp.pWin === null || pp.pWin === undefined ? '不可用' : `${((pp.pWin as number) * 100).toFixed(1)}%`}{pp.pTie === null || pp.pTie === undefined ? '（平价精度未知→EV 不可用）' : ` / ${((pp.pTie as number) * 100).toFixed(1)}%`}</td></tr>
              <tr><td>期望净收益 EV</td><td>{pp.expectedNet === null || pp.expectedNet === undefined ? '不可用' : String(pp.expectedNet)}</td></tr>
              {typeof pp.unavailableCode === 'string' && (
                <tr><td>不可用</td><td>{String(pp.unavailableCode)}：{String(pp.unavailableDetail ?? '')}</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

export function EvidenceDrawer({ runId, open, onClose, onLocateBar, embedded = false, selectedEvidenceId, citationIds = [] }: { runId: string; open: boolean; onClose: () => void; onLocateBar?: (atTime: number) => void; embedded?: boolean; selectedEvidenceId?: string | null; citationIds?: string[] }): JSX.Element {
  const [items, setItems] = useState<EvidenceItem[] | null>(null)
  const [structures, setStructures] = useState<StructureEventItem[]>([])
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
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
    <div className={embedded ? 'wb-evidence-content' : 'evidence-drawer'} role={embedded ? undefined : 'dialog'} aria-label="证据抽屉">
      <div className="drawer-head">
        <strong>证据（{items?.length ?? '…'}）</strong>
        {!embedded && <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>}
      </div>
      {error && <p className="err-text">{error}</p>}
      {items !== null && items.length === 0 && <p className="muted">无冻结证据（知识库未发布资料时检索为空，不编造引用）</p>}
      {items === null && !error && <p className="dim" role="status">正在读取冻结证据…</p>}
      {selectedEvidenceId && items && !items.some((e) => e.id === selectedEvidenceId) && <p className="err-text">该引用不在本次冻结证据中。</p>}
      <ul className="evidence-list" ref={listRef}>
        {(items ?? []).map((e) => (
          <li key={e.id} data-evidence-id={e.id} className={`${e.stance}${e.id === selectedEvidenceId ? ' selected' : ''}`}>
            <button className="evidence-toggle" aria-expanded={expanded === e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
              {citationIds.includes(e.id) && <span className="wb-cite-number">[{citationIds.indexOf(e.id) + 1}]</span>}
              <span className={`stance s-${e.stance}`}>{e.stance === 'support' ? '支持' : '反证'}</span>
              <span className="loc">
                {e.docTitle !== undefined && e.docTitle !== '' ? e.docTitle : e.kind === 'knowledge_chunk' ? '知识片段' : e.kind}
                {e.pageNo !== null ? ` · 第 ${e.pageNo} 页` : ''}
                {e.figureId !== null ? ` · 图 ${e.figureId.slice(0, 8)}` : ''}
                {e.sourceTier !== null ? ` · ${e.sourceTier}` : ''}
              </span>
            </button>
            {expanded === e.id && (
              <div className="evidence-card-body">
                <MiniMarkdown text={e.text} className="evidence-md" />
              </div>
            )}
          </li>
        ))}
      </ul>
      {structures.length > 0 && (
        <>
          <div className="drawer-head">
            <strong>结构事件（{structures.length}）</strong>
          </div>
          <ul className="evidence-list">
            {structures.map((s) => (
              <li key={s.id}>
                <button
                  className="evidence-toggle"
                  onClick={() => onLocateBar?.(s.atTime)}
                  aria-label={`定位 ${s.kind} 到 K 线`}
                >
                  <span className={`stance ${s.provisional ? 's-counter' : 's-support'}`}>{s.provisional ? '待确认' : '已确认'}</span>
                  <span className="loc">
                    {s.kind}
                    {s.direction !== null ? ` · ${s.direction === 'long' ? '多' : s.direction === 'short' ? '空' : s.direction}` : ''}
                    {' · '}{new Date(s.atTime).toLocaleTimeString()}
                    {s.knownAtTime !== null ? `（确认于 ${new Date(s.knownAtTime).toLocaleTimeString()}）` : ''}
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
    </div>
  )
}
