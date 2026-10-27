import mark from '@biance/brand/mark.svg'
import { brand } from '@biance/brand/identity'
import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { useMarket } from '../market/MarketContext'
import { useAi } from '../ai/AiContext'
import { useResearchAccess } from '../membership/access'
import { fmtPct, fmtPrice } from '../utils'
import { currentLocale } from '../i18n'
import { notificationState, requestNotifications } from '../notify'
import type { NotificationPermissionState } from '../notify'
import LanguageSwitcher from './LanguageSwitcher'

interface Tab {
  to: string
  labelKey: string
  end?: boolean
  /** 声明式可见性谓词（OCP：按属性控显的 tab 注册自己的谓词，渲染逻辑通用）；
   * 不注册（缺省）对所有登录用户可见。返回 false 时数据未到也不渲染（先隐藏后出现）。 */
  visible?: (researchAccess: { allowed: boolean }) => boolean
}

const TABS: Tab[] = [
  { to: '/dashboard', labelKey: 'nav.overview', end: true },
  // 异动榜/预警中心入口暂时隐藏（聚焦研究 agent 三场景建议）；路由保留，直达链接仍可用
  { to: '/brooks', labelKey: 'nav.priceAction' },
  // 研究终端为会员能力（docs/specs/membership.md）：仅当前有效套餐 research 特性可用时显示入口
  { to: '/research', labelKey: 'nav.research', visible: (a) => a.allowed },
]

const QUICK = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']

export function Logo(): JSX.Element {
  return <img src={mark} width="32" height="32" alt="" aria-hidden="true" />
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

const STATUS_LABEL_KEYS: Record<string, string> = {
  connected: 'status.connected',
  connecting: 'status.connecting',
  offline: 'status.offline',
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
  const researchAccess = useResearchAccess()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [perm, setPerm] = useState<NotificationPermissionState>(notificationState())
  const [now, setNow] = useState<Date>(() => new Date())
  const [menuOpen, setMenuOpen] = useState(false)
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
    perm === 'granted' ? t('header.notifyOn') : perm === 'default' ? t('header.notifyEnable') : t('header.notifyBlocked')
  const statusLabel = STATUS_LABEL_KEYS[status] ? t(STATUS_LABEL_KEYS[status]) : status

  return (
    <header className="header">
      <div className="brand">
        <Logo />
        <div className="brand-text">
          <span className="brand-name">{brand.name}</span>
          <span className="brand-sub">{t('brand.sub')}</span>
        </div>
      </div>

      <nav className="nav">
        {TABS.filter((tab) => !tab.visible || tab.visible(researchAccess)).map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? 'on' : '')}>
            {t(tab.labelKey)}
          </NavLink>
        ))}
        <a href={currentLocale().startsWith('zh') ? '/zh' : '/en'}>{currentLocale().startsWith('zh') ? '官网' : 'Website'}</a>
      </nav>

      <div className="header-right">
        <div className="quick-quotes">
          {QUICK.map((s) => (
            <QuickQuote key={s} symbol={s} />
          ))}
        </div>
        <span className={`conn ${status}`} title={statusLabel}>
          <i className="conn-dot" />
          {statusLabel}
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
          title={soundOn ? t('header.soundOn') : t('header.soundOff')}
          onClick={toggleSound}
        >
          <SoundIcon off={!soundOn} />
        </button>
        <LanguageSwitcher />
        {user && (
          <div className={`user-menu ${menuOpen ? 'open' : ''}`} ref={menuRef}>
            <button
              className="user-chip"
              title={user.role === 'superadmin' ? t('header.roleSuper') : t('header.roleUser')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <i className={`user-role-dot ${user.role}`} />
              <span className="user-name">{user.username}</span>
              {user.role === 'superadmin' && <em className="user-role-tag">{t('header.superTag')}</em>}
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
                {/* 管理入口已随 admin 域名隔离全部移入 admin.duckstrat.com 独立域名（主域名 /admin 双层 404） */}
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
                    <span>{t('header.aiAssistant')}</span>
                    <em className="menu-hint">{ai.robotVisible ? t('header.aiChatting') : t('header.aiSummon')}</em>
                  </button>
                )}
                <div className="menu-sep" />
                <button className="menu-item" role="menuitem" onClick={toggleUpColor}>
                  <PaletteIcon />
                  <span>{t('header.upColor')}</span>
                  <em className="menu-hint">{upColor === 'green' ? t('header.upColorGreen') : t('header.upColorRed')}</em>
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
                  <span>{t('header.logout')}</span>
                </button>
              </div>
            )}
          </div>
        )}
        <span className="clock mono">{now.toLocaleTimeString(currentLocale(), { hour12: false })}</span>
      </div>
    </header>
  )
}
