import { useMarket } from '../market/MarketContext'

export default function Toasts(): JSX.Element {
  const { toasts, dismissToast } = useMarket()
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'alert' ? 'toast-alert' : 'toast-info'}`}>
          <div className="toast-title">
            <span className="toast-icon">{t.kind === 'alert' ? '⚡' : '✦'}</span>
            {t.title}
          </div>
          {t.body && <div className="toast-body">{t.body}</div>}
          <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="关闭">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
