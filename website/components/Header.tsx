'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Brand } from './Brand'
import { Arrow } from './Icons'
import { loginUrl, text, type Locale } from '@/lib/site'

export function Header({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const other = locale === 'en' ? 'zh' : 'en'
  const otherPath = pathname.replace(/^\/(en|zh)(?=\/|$)/, `/${other}`)
  const nav = [
    ['methodology', text(locale, 'Our approach', '研究方法')],
    ['demo', text(locale, 'Research demo', '研究演示')],
    ['guides', text(locale, 'Field notes', '使用指南')],
  ]
  return <header className="site-header">
    <div className="header-inner">
      <a className="brand-link" href={`/${locale}`} aria-label="Biance Vision"><Brand /></a>
      <button className="menu-toggle" aria-expanded={open} aria-controls="main-navigation" onClick={() => setOpen(!open)} aria-label={text(locale, 'Toggle navigation', '展开或收起导航')}><span /><span /></button>
      <nav id="main-navigation" className={`navigation ${open ? 'is-open' : ''}`} aria-label={text(locale, 'Main navigation', '主导航')}>
        <div className="nav-links">{nav.map(([path, label]) => <a key={path} href={`/${locale}/${path}`} aria-current={pathname.startsWith(`/${locale}/${path}`) ? 'page' : undefined} onClick={() => setOpen(false)}>{label}</a>)}</div>
        <div className="nav-actions">
          <a className="language-switch" href={otherPath} lang={other === 'zh' ? 'zh-CN' : 'en'} hrefLang={other === 'zh' ? 'zh-CN' : 'en'} aria-label={text(locale, '切换到中文', 'Switch to English')}>{other === 'zh' ? '中文' : 'EN'}</a>
          <a className="login-link" href={loginUrl(locale)}>{text(locale, 'Log in', '已有账号登录')} <Arrow diagonal /></a>
          <a className="button button-small button-outline" href={`/${locale}/contact`}>{text(locale, 'Request access', '申请开通')}</a>
        </div>
      </nav>
    </div>
  </header>
}
