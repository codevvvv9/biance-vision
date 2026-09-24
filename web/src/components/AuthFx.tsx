import AuthCanvas from './AuthCanvas'

/** 登录 / 注册页的科技感动效背景：星点视差 + 行情曲线/粒子网络 + 透视网格 + 光晕呼吸 */
export default function AuthFx(): JSX.Element {
  return (
    <div className="auth-fx" aria-hidden>
      <div className="fx-stars" />
      <div className="fx-stars alt" />
      <AuthCanvas />
      <div className="fx-glow cyan" />
      <div className="fx-glow purple" />
      <div className="fx-floor">
        <div className="fx-floor-grid">
          <div className="fx-floor-move" />
        </div>
      </div>
      <div className="fx-horizon" />
      <div className="fx-vignette" />
    </div>
  )
}
