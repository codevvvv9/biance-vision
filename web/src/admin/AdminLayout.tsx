import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '@biance/shared-ui'
import AiSettingsModal from './AiSettingsModal'
import { ADMIN_MENU } from './menu'

/** 独立 admin 入口标记（vite.admin.config define；用户端构建恒为 "0"） */
const STANDALONE = import.meta.env.ADMIN_ENTRY === '1'

/** 管理后台统一布局：superadmin 守卫 + 页头导航 + 子页面出口 */
export default function AdminLayout(): JSX.Element {
  const { t } = useTranslation('admin')
  const { user } = useAuth()
  const [aiOpen, setAiOpen] = useState(false)

  // 普通用户直接输入 /admin/* 时跳回首页；接口侧同样有 403 拦截
  // （独立入口下 AdminGate 已先行拦截，此守卫为嵌入态/兜底保留）
  if (user?.role !== 'superadmin') return <Navigate to="/" replace />

  return (
    <div className="admin-shell">
      <div className="admin-head">
        <div className="admin-head-side">
          <span className="admin-head-title">{t('layout.title')}</span>
          {/* 嵌入态（用户端构建）保留返回主站；独立 admin 入口下无主站可返 */}
          {!STANDALONE && (
            <NavLink to="/" className="admin-back">
              ← {t('layout.back')}
            </NavLink>
          )}
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
            {t('common:header.aiSettings')}
          </button>
        </nav>
      </div>
      <Outlet />
      {aiOpen && <AiSettingsModal onClose={() => setAiOpen(false)} />}
    </div>
  )
}
