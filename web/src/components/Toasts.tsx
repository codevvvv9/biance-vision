import { useTranslation } from 'react-i18next'
import { useMarket } from '../market/MarketContext'

export default function Toasts(): JSX.Element {
  const { t } = useTranslation()
  const { toasts, dismissToast } = useMarket()
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind === 'alert' ? 'toast-alert' : 'toast-info'}`}>
          <div className="toast-title">
            <span className="toast-icon">{toast.kind === 'alert' ? '⚡' : '✦'}</span>
            {toast.title}
          </div>
          {toast.body && <div className="toast-body">{toast.body}</div>}
          <button className="toast-close" onClick={() => dismissToast(toast.id)} aria-label={t('common:toast.close')}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
