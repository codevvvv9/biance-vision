import type { CSSProperties } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import AuthFx from '../components/AuthFx'
import { Logo } from '../components/Header'
import LanguageSwitcher from '../components/LanguageSwitcher'
import SplitText from '../components/fx/SplitText'
import { authReturnTo, authUrl, researchUiMode } from '../research/uiMode'

/** 注册页：暂不开放注册，仅提示联系超级管理员 */
export default function RegisterPage(): JSX.Element {
  const { search } = useLocation()
  const { t, i18n } = useTranslation('auth')
  const locale = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const { t: tc } = useTranslation('common')
  return (
    <div className="auth-wrap">
      <AuthFx />
      <div className="auth-lang">
        <LanguageSwitcher />
      </div>
      <div className="auth-card fx-beam" style={{ '--fx-beam-t': '5.2s' } as CSSProperties}>
        <div className="auth-brand fx-in">
          <Logo />
          <div className="auth-brand-text">
            <span className="auth-title">
              <SplitText text="BIANCE VISION" delay={0.12} gradient={['#00e5ff', '#a78bfa']} />
            </span>
            <span className="auth-sub fx-in" style={{ '--fx-i': 8 } as CSSProperties}>{tc('brand.sub')}</span>
          </div>
        </div>

        <div className="auth-notice fx-in" style={{ '--fx-i': 3 } as CSSProperties}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <h2>{t('register.noticeTitle')}</h2>
          <p>
            {t('register.noticeLine1')}
            <br />
            {locale === 'zh' ? '请联系团队确认使用方式与开通条件，取得账号后登录。' : 'Contact our team to confirm access conditions and receive your account.'}
          </p>
        </div>

        <div className="auth-foot center">
          <a href={`/${locale}/contact`}>{locale === 'zh' ? '联系开通' : 'Contact us for access'}</a>
          <a href={`/${locale}`}>{locale === 'zh' ? '返回官网' : 'Back to website'}</a>
          <Link to={authUrl('/login', authReturnTo(search), researchUiMode(search))} className="btn btn-ghost">
            {t('register.backToLogin')}
          </Link>
        </div>
      </div>
    </div>
  )
}
