import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import AuthFx from '../components/AuthFx'
import { Logo } from '../components/Header'

/** 登录页：未开放自助注册，账号由超级管理员通过脚本开通 */
export default function LoginPage(): JSX.Element {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    if (!username.trim() || !password) {
      setError('请输入用户名和密码')
      return
    }
    setBusy(true)
    setError('')
    try {
      await login(username, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError((err as Error).message || '登录失败，请稍后再试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <AuthFx />
      <div className="auth-card">
        <div className="auth-brand">
          <Logo />
          <div className="auth-brand-text">
            <span className="auth-title">BIANCE VISION</span>
            <span className="auth-sub">币安大盘监控终端</span>
          </div>
        </div>

        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          <label className="auth-field">
            <span>用户名</span>
            <input
              autoComplete="username"
              autoFocus
              placeholder="请输入用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="auth-field">
            <span>密码</span>
            <input
              autoComplete="current-password"
              placeholder="请输入密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button className="btn btn-primary auth-submit" disabled={busy} type="submit">
            {busy ? '登录中…' : '登 录'}
          </button>
        </form>

        <div className="auth-foot">
          还没有账号？
          <Link to="/register">联系管理员开通</Link>
        </div>
      </div>
    </div>
  )
}
