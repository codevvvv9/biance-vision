import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Header from './components/Header'
import TickerTape from './components/TickerTape'
import Toasts from './components/Toasts'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { MarketProvider } from './market/MarketContext'
import { AiProvider } from './ai/AiContext'
import AiAssistant from './ai/AiAssistant'
import AlertsPage from './pages/AlertsPage'
import BrooksPage from './pages/BrooksPage'
import Dashboard from './pages/Dashboard'
import LoginPage from './pages/LoginPage'
import MoversPage from './pages/MoversPage'
import RegisterPage from './pages/RegisterPage'
import ResearchPage from './research/ResearchPage'

// 管理后台整体懒加载：独立 chunk，守卫集中在 admin/AdminLayout
const AdminApp = lazy(() => import('./admin'))

/** 登录后才挂载行情应用（WebSocket / 行情接口都要求会话） */
function AuthedApp(): JSX.Element {
  return (
    <MarketProvider>
      <AiProvider>
        <Header />
        <TickerTape />
        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/movers" element={<MoversPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/brooks" element={<BrooksPage />} />
            <Route path="/research" element={<ResearchPage />} />
            <Route
              path="/admin/*"
              element={
                <Suspense
                  fallback={
                    <div className="auth-wrap">
                      <div className="auth-loading">正在加载管理后台…</div>
                    </div>
                  }
                >
                  <AdminApp />
                </Suspense>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <footer className="footer">
          数据来源：Binance 公开行情接口（REST + WebSocket，1s 推送） · 本工具仅供学习研究，不构成投资建议
        </footer>
        <Toasts />
        <AiAssistant />
      </AiProvider>
    </MarketProvider>
  )
}

function Shell(): JSX.Element {
  const { user, loading } = useAuth()

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <div className="bg-fx" aria-hidden>
        <div className="bg-grid" />
        <div className="bg-glow glow-a" />
        <div className="bg-glow glow-b" />
      </div>
      {loading ? (
        <div className="auth-wrap">
          <div className="auth-loading">正在验证登录状态…</div>
        </div>
      ) : user ? (
        <AuthedApp />
      ) : (
        <main className="main">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </main>
      )}
    </BrowserRouter>
  )
}

export default function App(): JSX.Element {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
