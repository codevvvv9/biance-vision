import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useMarket } from '../market/MarketContext'
import { useAi } from '../ai/AiContext'
import AiSettingsModal from '../ai/AiSettingsModal'
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

export function Logo(): JSX.Element {
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

/** 涨跌配色切换图标：左右两个箭头直接使用当前 --up/--down，所见即当前含义 */
function PaletteIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 20V6.5M7 6.5 3.8 9.7M7 6.5l3.2 3.2" stroke="var(--up)" />
      <path d="M17 4v13.5m0 0 3.2-3.2M17 17.5l-3.2-3.2" stroke="var(--down)" />
    </svg>
  )
}

function GearIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function RobotIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="10" width="16" height="10" rx="2.5" />
      <circle cx="9" cy="15" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1" fill="currentColor" stroke="none" />
      <path d="M12 10V7" />
      <circle cx="12" cy="5" r="2" />
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

function LogoutIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

export default function Header(): JSX.Element {
  const { status, soundOn, toggleSound, upColor, toggleUpColor } = useMarket()
  const ai = useAi()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [perm, setPerm] = useState<NotificationPermissionState>(notificationState())
  const [now, setNow] = useState<Date>(() => new Date())
  const [menuOpen, setMenuOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // 下拉菜单：点击外部 / Escape 关闭
  useEffect(() => {
    if (!menuOpen) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

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
        {user?.role === 'superadmin' && (
          <NavLink to="/admin" className={({ isActive }) => (isActive ? 'on' : '')}>
            操作日志
          </NavLink>
        )}
      </nav>

      <div className="header-right">
        <div className="quick-quotes">
          {QUICK.map((s) => (
            <QuickQuote key={s} symbol={s} />
          ))}
        </div>
        <span className={`conn ${status}`} title={STATUS_LABEL[status] ?? status}>
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
        {user && (
          <div className={`user-menu ${menuOpen ? 'open' : ''}`} ref={menuRef}>
            <button
              className="user-chip"
              title={user.role === 'superadmin' ? '超级管理员' : '普通用户'}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <i className={`user-role-dot ${user.role}`} />
              <span className="user-name">{user.username}</span>
              {user.role === 'superadmin' && <em className="user-role-tag">超管</em>}
              <svg
                className="caret"
                width="10"
                height="10"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M2.5 4.5 6 8l3.5-3.5" />
              </svg>
            </button>
            {menuOpen && (
              <div className="user-menu-panel" role="menu">
                {user.role === 'superadmin' && (
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      setAiOpen(true)
                    }}
                  >
                    <GearIcon />
                    <span>AI 设置</span>
                    <em className="menu-hint">{ai.status.configured ? ai.status.model || '已配置' : '未配置'}</em>
                  </button>
                )}
                {ai.status.configured && (
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      ai.showRobot()
                      ai.setChatOpen(true)
                    }}
                  >
                    <RobotIcon />
                    <span>AI 助手</span>
                    <em className="menu-hint">{ai.robotVisible ? '对话中' : '唤起'}</em>
                  </button>
                )}
                <div className="menu-sep" />
                <button className="menu-item" role="menuitem" onClick={toggleUpColor}>
                  <PaletteIcon />
                  <span>涨跌配色</span>
                  <em className="menu-hint">{upColor === 'green' ? '绿涨红跌' : '红涨绿跌'}</em>
                </button>
                <button
                  className="menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void logout().then(() => navigate('/login', { replace: true }))
                  }}
                >
                  <LogoutIcon />
                  <span>退出登录</span>
                </button>
              </div>
            )}
          </div>
        )}
        <span className="clock mono">{now.toLocaleTimeString('zh-CN', { hour12: false })}</span>
        {aiOpen && <AiSettingsModal onClose={() => setAiOpen(false)} />}
      </div>
    </header>
  )
}
