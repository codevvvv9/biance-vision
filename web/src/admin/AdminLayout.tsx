import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { ADMIN_MENU } from './menu'

/** 管理后台统一布局：superadmin 守卫 + 页头导航 + 子页面出口 */
export default function AdminLayout(): JSX.Element {
  const { user } = useAuth()

  // 普通用户直接输入 /admin/* 时跳回首页；接口侧同样有 403 拦截
  if (user?.role !== 'superadmin') return <Navigate to="/" replace />

  return (
    <div className="admin-shell">
      <div className="admin-head">
        <div className="admin-head-side">
          <span className="admin-head-title">管理后台</span>
          <NavLink to="/" className="admin-back">
            ← 返回主站
          </NavLink>
        </div>
        <nav className="admin-nav">
          {ADMIN_MENU.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/admin'}
              className={({ isActive }) => (isActive ? 'on' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </div>
  )
}
