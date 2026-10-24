/**
 * W3-S1 管理端独立门卫（admin-main 入口专用）：
 * - 会话探测中 → 加载态；未登录 → 极简登录表单（与用户登录同一端点/上下文，
 *   服务端 v0.9.5 登录入口分离策略不变）；
 * - 已登录非超管 → 禁入提示 + 退出登录（服务端 /api/admin/* 另有 403 拦截，双保险）；
 * - 超管 → AdminApp 六页子应用。
 * AdminLayout 内原有的 superadmin Navigate 守卫保留作兜底。
 */
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useAuth } from '@biance/shared-ui'
import AdminApp from './'

export default function AdminGate(): JSX.Element {
  const { t } = useTranslation('admin')
  const { user, loading, login, logout } = useAuth()

  if (loading) {
    return (
      <div className="auth-wrap">
        <div className="auth-loading">{t('gate.verifying')}</div>
      </div>
    )
  }

  if (user === null) return <AdminLoginForm login={login} />

  if (user.role !== 'superadmin') {
    return (
      <div className="auth-wrap">
        <div className="auth-card admin-gate-card">
          <h2 className="admin-gate-title">{t('gate.forbidden')}</h2>
          <p className="admin-gate-hint">{t('gate.forbiddenHint', { user: user.username })}</p>
          <button className="btn" onClick={() => void logout()}>{t('gate.logout')}</button>
        </div>
      </div>
    )
  }

  return <AdminApp />
}

function AdminLoginForm({ login }: { login: (username: string, password: string) => Promise<void> }): JSX.Element {
  const { t } = useTranslation('admin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    if (username.trim() === '' || password === '') {
      setError(t('gate.required'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await login(username, password)
    } catch (err) {
      setError((err as Error).message || t('gate.loginFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card admin-gate-card" onSubmit={(e) => void submit(e)}>
        <h2 className="admin-gate-title">{t('layout.title')}</h2>
        <label className="admin-gate-field">
          {t('gate.user')}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label className="admin-gate-field">
          {t('gate.password')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error !== '' && <p className="err-text">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? t('gate.busy') : t('gate.submit')}
        </button>
      </form>
    </div>
  )
}
