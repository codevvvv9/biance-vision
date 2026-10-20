/**
 * 会话内持仓确认卡（confirm_position）：未经确认不落库，内联在消息流中。
 * 研究工作台右栏与悬浮 AI 助手共用（同一 /api/conversations 链路）。
 */
import { useTranslation } from 'react-i18next'
import type { PositionDraftCard } from './useResearchConversation'

interface Props {
  card: PositionDraftCard
  /** 另一张卡正在写入时禁用（逐个防抖） */
  busy: boolean
  onResolve: (confirm: boolean) => void
}

export function PositionConfirmCard({ card, busy, onResolve }: Props): JSX.Element {
  const { t } = useTranslation()
  const d = card.draft
  return (
    <div className={`confirm-card cc-${card.state}`} role="group" aria-label={t('research:confirm.aria')}>
      <dl className="confirm-card-fields">
        <div><dt>{t('research:confirm.symbol')}</dt><dd>{typeof d.symbol === 'string' ? d.symbol : '—'}</dd></div>
        <div><dt>{t('research:confirm.side')}</dt><dd>{d.side === 'long' ? t('research:confirm.long') : d.side === 'short' ? t('research:confirm.short') : '—'}</dd></div>
        <div><dt>{t('research:confirm.qty')}</dt><dd>{d.qty !== undefined ? String(d.qty) : '—'}</dd></div>
        <div><dt>{t('research:confirm.entryPrice')}</dt><dd>{d.entryPrice !== undefined ? String(d.entryPrice) : '—'}</dd></div>
        <div><dt>{t('research:confirm.leverage')}</dt><dd>{d.leverage !== undefined ? `${String(d.leverage)}x` : '—'}</dd></div>
        <div><dt>{t('research:confirm.marginMode')}</dt><dd>{d.marginMode === 'cross' ? t('research:confirm.cross') : d.marginMode === 'isolated' ? t('research:confirm.isolated') : '—'}</dd></div>
        <div><dt>{t('research:confirm.riskBudget')}</dt><dd>{d.riskBudget !== undefined ? String(d.riskBudget) : '—'}</dd></div>
      </dl>
      {card.state === 'pending' && card.complete === false && (
        <p className="muted confirm-card-missing">
          {t('research:confirm.incomplete', {
            fields: (card.missingFields ?? []).join('、') || t('research:confirm.missingRequired'),
          })}
        </p>
      )}
      {card.state === 'pending' ? (
        <div className="confirm-card-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || card.complete === false}
            aria-label={t('research:confirm.writeAria')}
            onClick={() => onResolve(true)}
          >
            {busy ? t('research:confirm.writing') : card.complete === false ? t('research:confirm.awaitFields') : t('research:confirm.confirmWrite')}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={busy} aria-label={t('research:confirm.cancelAria')} onClick={() => onResolve(false)}>
            {t('research:confirm.cancel')}
          </button>
        </div>
      ) : (
        <p className="muted confirm-card-state">
          {card.state === 'confirmed' ? t('research:confirm.confirmed') : card.state === 'cancelled' ? t('research:confirm.cancelled') : t('research:confirm.historic')}
        </p>
      )}
    </div>
  )
}
