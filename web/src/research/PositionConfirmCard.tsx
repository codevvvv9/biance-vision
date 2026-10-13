/**
 * 会话内持仓确认卡（confirm_position）：未经确认不落库，内联在消息流中。
 * 研究工作台右栏与悬浮 AI 助手共用（同一 /api/conversations 链路）。
 */
import type { PositionDraftCard } from './useResearchConversation'

interface Props {
  card: PositionDraftCard
  /** 另一张卡正在写入时禁用（逐个防抖） */
  busy: boolean
  onResolve: (confirm: boolean) => void
}

export function PositionConfirmCard({ card, busy, onResolve }: Props): JSX.Element {
  const d = card.draft
  return (
    <div className={`confirm-card cc-${card.state}`} role="group" aria-label="持仓确认卡">
      <dl className="confirm-card-fields">
        <div><dt>交易对</dt><dd>{typeof d.symbol === 'string' ? d.symbol : '—'}</dd></div>
        <div><dt>方向</dt><dd>{d.side === 'long' ? '做多 long' : d.side === 'short' ? '做空 short' : '—'}</dd></div>
        <div><dt>数量</dt><dd>{d.qty !== undefined ? String(d.qty) : '—'}</dd></div>
        <div><dt>开仓价</dt><dd>{d.entryPrice !== undefined ? String(d.entryPrice) : '—'}</dd></div>
        <div><dt>杠杆</dt><dd>{d.leverage !== undefined ? `${String(d.leverage)}x` : '—'}</dd></div>
        <div><dt>保证金模式</dt><dd>{d.marginMode === 'cross' ? '全仓 cross' : d.marginMode === 'isolated' ? '逐仓 isolated' : '—'}</dd></div>
        <div><dt>风险预算</dt><dd>{d.riskBudget !== undefined ? String(d.riskBudget) : '—'}</dd></div>
      </dl>
      {card.state === 'pending' && card.complete === false && (
        <p className="muted confirm-card-missing">
          草稿未齐（缺：{(card.missingFields ?? []).join('、') || '必填字段'}），请直接在对话里补充，例如「入场 60000，最多亏 200」；补齐后才能确认写入。
        </p>
      )}
      {card.state === 'pending' ? (
        <div className="confirm-card-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || card.complete === false}
            aria-label="确认写入持仓"
            onClick={() => onResolve(true)}
          >
            {busy ? '写入中…' : card.complete === false ? '待补齐字段' : '确认写入'}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={busy} aria-label="取消持仓确认" onClick={() => onResolve(false)}>
            取消
          </button>
        </div>
      ) : (
        <p className="muted confirm-card-state">
          {card.state === 'confirmed' ? '已确认写入持仓' : card.state === 'cancelled' ? '已取消（未写入）' : '历史会话中的确认卡（仅展示）'}
        </p>
      )}
    </div>
  )
}
