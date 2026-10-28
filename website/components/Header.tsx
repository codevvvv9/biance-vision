'use client'

import { brand } from '@biance/brand/identity'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Brand } from './Brand'
import { Arrow } from './Icons'
import { localeMeta, locales, loginUrl, text, type Locale } from '@/lib/site'

const LANG_LABELS: Record<Locale, string> = { en: 'English', zh: '简体中文', 'zh-TW': '繁體中文' }

export function Header({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const swapLocale = (target: Locale) => pathname.replace(/^\/(?:en|zh(?:-TW)?)(?=\/|$)/, `/${target}`)
  const nav = [
    ['pricing', text(locale, 'Membership', '会员套餐', '會員套餐')],
    ['methodology', text(locale, 'Our approach', '研究方法', '研究方法')],
    ['demo', text(locale, 'Research demo', '研究演示', '研究演示')],
    ['guides', text(locale, 'Field notes', '使用指南', '使用指南')],
  ]
  return <header className="site-header">
    <div className="header-inner">
      <a className="brand-link" href={`/${locale}`} aria-label={brand.name}><Brand /></a>
      <button className="menu-toggle" aria-expanded={open} aria-controls="main-navigation" onClick={() => setOpen(!open)} aria-label={text(locale, 'Toggle navigation', '展开或收起导航', '展開或收起導航')}><span /><span /></button>
      <nav id="main-navigation" className={`navigation ${open ? 'is-open' : ''}`} aria-label={text(locale, 'Main navigation', '主导航', '主導航')}>
        <div className="nav-links">{nav.map(([path, label]) => <a key={path} href={`/${locale}/${path}`} className={path === 'demo' ? 'nav-demo' : undefined} aria-current={pathname.startsWith(`/${locale}/${path}`) ? 'page' : undefined} onClick={() => setOpen(false)}>{label}</a>)}</div>
        <div className="nav-actions">
          <details className="lang-menu">
            <summary className="language-switch" aria-label={text(locale, 'Switch language', '切换语言', '切換語言')}>{LANG_LABELS[locale]}<span className="lang-caret" aria-hidden="true">▾</span></summary>
            <div className="lang-options">{locales.filter(item => item !== locale).map(item => <a key={item} href={swapLocale(item)} lang={localeMeta[item].htmlLang} hrefLang={localeMeta[item].htmlLang}>{LANG_LABELS[item]}</a>)}</div>
          </details>
          <a className="login-link" href={loginUrl(locale)}>{text(locale, 'Log in', '已有账号登录', '已有帳號登入')} <Arrow diagonal /></a>
          <a className="button button-small button-outline" href={`/${locale}/contact`}>{text(locale, 'Request access', '申请开通', '申請開通')}</a>
        </div>
      </nav>
    </div>
  </header>
}
