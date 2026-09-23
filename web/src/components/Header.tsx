import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice } from '../utils'
import { notificationState, requestNotifications } from '../notify'
import type { NotificationPermissionState } from '../notify'

interface Tab {
  to: string
  label: string
  end?: boolean
}

const TABS: Tab[] = [
  { to: '/', label: '大盘总览', end: true },
  { to: '/movers', label: '异动榜' },
  { to: '/alerts', label: '预警中心' },
]

const QUICK = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']

function Logo(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs>
        <linearGradient id="bv-lg" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stopColor="#00e5ff" />
          <stop offset="1" stopColor="#7c5cff" />
        </linearGradient>
      </defs>
      <path d="M12 1.8 21 7v10l-9 5.2L3 17V7z" stroke="url(#bv-lg)" strokeWidth="1.6" />
      <rect x="7" y="9.5" width="2.4" height="5" rx=".5" fill="#00d68f" />
      <rect x="7.9" y="7" width=".7" height="11" fill="#00d68f" opacity=".6" />
      <rect x="13.5" y="8" width="2.4" height="6" rx=".5" fill="#ff4d6a" />
      <rect x="14.5" y="5.5" width=".7" height="13" fill="#ff4d6a" opacity=".6" />
    </svg>
  )
}

function BellIcon({ off }: { off: boolean }): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      {off && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  )
}

function SoundIcon({ off }: { off: boolean }): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {off ? (
        <>
          <line x1="22" y1="9" x2="16" y2="15" />
          <line x1="16" y1="9" x2="22" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M19 5a10 10 0 0 1 0 14" />
        </>
      )}
    </svg>
  )
}

function QuickQuote({ symbol }: { symbol: string }): JSX.Element {
  const { tickers } = useMarket()
  const t = tickers[symbol]
  if (!t) return <span className="quick-quote muted">{symbol.replace('USDT', '')} --</span>
  const up = t.changePct >= 0
  return (
    <span className="quick-quote">
      <span className="qq-sym">{symbol.replace('USDT', '')}</span>
      <span className="mono qq-price">{fmtPrice(t.last)}</span>
      <span className={`qq-chg ${up ? 'up' : 'down'}`}>{fmtPct(t.changePct)}</span>
    </span>
  )
}

const STATUS_LABEL: Record<string, string> = {
  connected: '实时连接',
  connecting: '连接中',
  offline: '已断线 · 重连中',
}

export default function Header(): JSX.Element {
  const { status, soundOn, toggleSound } = useMarket()
  const [perm, setPerm] = useState<NotificationPermissionState>(notificationState())
  const [now, setNow] = useState<Date>(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const bellLabel =
    perm === 'granted' ? '系统通知已开启' : perm === 'default' ? '开启系统通知' : '通知被浏览器拦截'

  return (
    <header className="header">
      <div className="brand">
        <Logo />
        <div className="brand-text">
          <span className="brand-name">BIANCE VISION</span>
          <span className="brand-sub">币安大盘监控终端</span>
        </div>
      </div>

      <nav className="nav">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'on' : '')}>
            {t.label}
          </NavLink>
        ))}
      </nav>

      <div className="header-right">
        <div className="quick-quotes">
          {QUICK.map((s) => (
            <QuickQuote key={s} symbol={s} />
          ))}
        </div>
        <span className={`conn ${status}`}>
          <i className="conn-dot" />
          {STATUS_LABEL[status] ?? status}
        </span>
        <button
          className={`icon-btn ${perm === 'granted' ? 'active' : ''}`}
          title={bellLabel}
          onClick={() => {
            void requestNotifications().then(setPerm)
          }}
        >
          <BellIcon off={perm !== 'granted'} />
        </button>
        <button
          className={`icon-btn ${soundOn ? 'active' : ''}`}
          title={soundOn ? '预警提示音：开' : '预警提示音：关'}
          onClick={toggleSound}
        >
          <SoundIcon off={!soundOn} />
        </button>
        <span className="clock mono">{now.toLocaleTimeString('zh-CN', { hour12: false })}</span>
      </div>
    </header>
  )
}
