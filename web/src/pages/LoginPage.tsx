import { useState, type CSSProperties } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import AuthFx from '../components/AuthFx'
import { Logo } from '../components/Header'
import LanguageSwitcher from '../components/LanguageSwitcher'
import Magnet from '../components/fx/Magnet'
import SplitText from '../components/fx/SplitText'
import { pendingAuthReturnTo as authReturnTo, rememberAuthReturn, clearAuthReturn, researchUiMode } from '../research/uiMode'

/** 登录页：未开放自助注册，账号由管理员人工开通 */
export default function LoginPage(): JSX.Element {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { t, i18n } = useTranslation('auth')
  const websiteLocale = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const { t: tc } = useTranslation('common')
  const from = authReturnTo(location.search, location.state as { from?: string } | null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    if (!username.trim() || !password) {
      setError(t('login.required'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await login(username, password)
      clearAuthReturn()
      navigate(from, { replace: true })
    } catch (err) {
      setError((err as Error).message || t('login.failed'))
    } finally {
      setBusy(false)
    }
  }

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

        <form className="auth-form fx-in" style={{ '--fx-i': 3 } as CSSProperties} onSubmit={(e) => void submit(e)}>
          <label className="auth-field">
            <span>{t('login.username')}</span>
            <input
              autoComplete="username"
              autoFocus
              placeholder={t('login.usernamePlaceholder')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="auth-field">
            <span>{t('login.password')}</span>
            <input
              autoComplete="current-password"
              placeholder={t('login.passwordPlaceholder')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="auth-error fx-in">{error}</p>}

          <Magnet className="auth-submit-wrap">
            <button className="btn btn-primary auth-submit" disabled={busy} type="submit">
              {busy ? t('login.submitting') : t('login.submit')}
            </button>
          </Magnet>
        </form>

        <div className="auth-foot">
          {t('login.noAccount')}
          <a href={`/${websiteLocale}/contact`} onClick={() => rememberAuthReturn(from)}>{t('login.contactAdmin')}</a>
          <a href={`/${websiteLocale}`} onClick={() => rememberAuthReturn(from)}>{websiteLocale === 'zh' ? '返回官网' : 'Back to website'}</a>
          {researchUiMode(location.search) === 'dev' && <Link to={from}>{t('login.backToWorkbench')}</Link>}
        </div>
      </div>
    </div>
  )
}
