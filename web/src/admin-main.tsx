/**
 * W3-S1 管理端独立入口（admin-web，docs/admin-isolation-plan.md §3.1）：
 * 与用户端 main.tsx 平行的最小 Provider 栈——认证上下文（会话探测/401 回登录）+
 * i18n + 全局样式 + BrowserRouter(basename /admin)。不带用户端壳
 * （MarketProvider/Header/行情流/AI 悬浮助手均不进管理端包）。
 * AiProvider 仅为 AiSettingsModal（配置后刷新状态）提供上下文。
 */
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ErrorBoundary, AuthProvider } from '@biance/shared-ui'
import { AiProvider } from './ai/AiContext'
import AdminGate from './admin/AdminGate'
import { applyUpColor, readUpColor } from './utils'
import './i18n'
import './styles/index.css'

// 与用户端同款：挂载前应用涨跌配色偏好，避免首屏闪默认色
applyUpColor(readUpColor())

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root 元素不存在')

createRoot(rootEl).render(
  <ErrorBoundary>
    <AuthProvider>
      <BrowserRouter basename="/admin" future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AiProvider>
          <AdminGate />
        </AiProvider>
      </BrowserRouter>
    </AuthProvider>
  </ErrorBoundary>,
)
