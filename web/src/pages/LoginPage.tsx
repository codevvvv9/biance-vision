import { useState, type CSSProperties } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import AuthFx from '../components/AuthFx'
import { Logo } from '../components/Header'
import Magnet from '../components/fx/Magnet'
import SplitText from '../components/fx/SplitText'

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
      <div className="auth-card fx-beam" style={{ '--fx-beam-t': '5.2s' } as CSSProperties}>
        <div className="auth-brand fx-in">
          <Logo />
          <div className="auth-brand-text">
            <span className="auth-title">
              <SplitText text="BIANCE VISION" delay={0.12} gradient={['#00e5ff', '#a78bfa']} />
            </span>
            <span className="auth-sub fx-in" style={{ '--fx-i': 8 } as CSSProperties}>币安大盘监控终端</span>
          </div>
        </div>

        <form className="auth-form fx-in" style={{ '--fx-i': 3 } as CSSProperties} onSubmit={(e) => void submit(e)}>
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

          {error && <p className="auth-error fx-in">{error}</p>}

          <Magnet className="auth-submit-wrap">
            <button className="btn btn-primary auth-submit" disabled={busy} type="submit">
              {busy ? '登录中…' : '登 录'}
            </button>
          </Magnet>
        </form>

        <div className="auth-foot">
          还没有账号？
          <Link to="/register">联系管理员开通</Link>
        </div>
      </div>
    </div>
  )
}
