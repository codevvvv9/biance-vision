import { useState } from 'react'
import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import AiSettingsModal from '../ai/AiSettingsModal'
import { ADMIN_MENU } from './menu'

/** 管理后台统一布局：superadmin 守卫 + 页头导航 + 子页面出口 */
export default function AdminLayout(): JSX.Element {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [aiOpen, setAiOpen] = useState(false)

  // 普通用户直接输入 /admin/* 时跳回首页；接口侧同样有 403 拦截
  if (user?.role !== 'superadmin') return <Navigate to="/" replace />

  return (
    <div className="admin-shell">
      <div className="admin-head">
        <div className="admin-head-side">
          <span className="admin-head-title">{t('admin:layout.title')}</span>
          <NavLink to="/" className="admin-back">
            ← {t('admin:layout.back')}
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
              {t(item.labelKey)}
            </NavLink>
          ))}
          {/* AI 档案配置（多档案/用户绑定，仅超管）：主站 Header 的入口已随 admin 域名隔离移除，只在此处提供 */}
          <button type="button" className="admin-nav-action" onClick={() => setAiOpen(true)}>
            {t('header.aiSettings')}
          </button>
        </nav>
      </div>
      <Outlet />
      {aiOpen && <AiSettingsModal onClose={() => setAiOpen(false)} />}
    </div>
  )
}
