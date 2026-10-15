import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import AuthFx from '../components/AuthFx'
import { Logo } from '../components/Header'
import SplitText from '../components/fx/SplitText'

/** 注册页：暂不开放注册，仅提示联系超级管理员 */
export default function RegisterPage(): JSX.Element {
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

        <div className="auth-notice fx-in" style={{ '--fx-i': 3 } as CSSProperties}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <h2>暂未开放注册</h2>
          <p>
            本系统不开放自助注册。
            <br />
            如需开通账号，请联系超级管理员<span className="mono auth-admin">admin</span>，
            由管理员在服务端执行 <code>pnpm user:add</code> 为您创建账号。
          </p>
        </div>

        <div className="auth-foot center">
          <Link to="/login" className="btn btn-ghost">
            ← 返回登录
          </Link>
        </div>
      </div>
    </div>
  )
}
