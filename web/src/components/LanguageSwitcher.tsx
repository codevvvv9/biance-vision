import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppLocale } from '../i18n'

const LANGS: { code: AppLocale; labelKey: string }[] = [
  { code: 'zh-CN', labelKey: 'lang.zh' },
  { code: 'en-US', labelKey: 'lang.en' },
]

function GlobeIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

export default function LanguageSwitcher(): JSX.Element {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // 与用户菜单一致：点击外部 / Escape 关闭
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`lang-menu ${open ? 'open' : ''}`} ref={menuRef}>
      <button
        className={`icon-btn ${open ? 'active' : ''}`}
        title={t('lang.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon />
      </button>
      {open && (
        <div className="lang-menu-panel" role="menu">
          {LANGS.map((l) => (
            <button
              key={l.code}
              className={`menu-item lang-item ${i18n.language === l.code ? 'on' : ''}`}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                void i18n.changeLanguage(l.code)
              }}
            >
              <span>{t(l.labelKey)}</span>
              {i18n.language === l.code && <em className="menu-hint">✓</em>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
