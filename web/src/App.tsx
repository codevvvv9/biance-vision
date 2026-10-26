import { MembershipProvider, MembershipCard } from './membership/Membership'
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ErrorBoundary from './components/ErrorBoundary'
import Header from './components/Header'
import TickerTape from './components/TickerTape'
import Toasts from './components/Toasts'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { MarketProvider } from './market/MarketContext'
import { AiProvider } from './ai/AiContext'
import AuroraBg from './components/fx/AuroraBg'
import Dashboard from './pages/Dashboard'
// 登录/注册是未登录用户的第一屏，保持静态 import（不进懒加载列表）
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import { pendingAuthReturnTo as authReturnTo, authUrl, researchUiMode } from './research/uiMode'

// 重页面全部懒加载：登录后的首屏只有大盘，K 线/研究/价格行为按需取 chunk
// （W3-S1 起管理端为独立构建 admin.html/admin-main.tsx，用户端包不再含 admin 子应用）
const AlertsPage = lazy(() => import('./pages/AlertsPage'))
const BrooksPage = lazy(() => import('./pages/BrooksPage'))
const MoversPage = lazy(() => import('./pages/MoversPage'))
const ResearchPage = lazy(() => import('./research/ResearchPage'))
const WorkbenchPage = lazy(() => import('./research/WorkbenchPage'))
// 悬浮 AI 助手懒加载：它经 RunBubble→MiniMarkdown 拉进 react-markdown/katex 全家桶，
// 静态挂载会把 433KB 的 markdown chunk 拖进首屏关键路径；后台异步加载即可
const AiAssistant = lazy(() => import('./ai/AiAssistant'))

/** 页面级懒加载兜底（图表/研究台首挂拉 chunk 的间隙） */
function PageFallback(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="page-loading" role="status" aria-label={t('app.pageLoading')}>
      <span className="page-loading-bar" />
    </div>
  )
}

/** 登录后才挂载行情应用（WebSocket / 行情接口都要求会话） */
function AuthedApp(): JSX.Element {
  const { t } = useTranslation()
  return (
    <MarketProvider>
      <AiProvider>
        <Header />
        <TickerTape />
        <main className="main">
          <MembershipCard />
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route
              path="/movers"
              element={
                <ErrorBoundary>
                  <Suspense fallback={<PageFallback />}>
                    <MoversPage />
                  </Suspense>
                </ErrorBoundary>
              }
            />
            <Route
              path="/alerts"
              element={
                <ErrorBoundary>
                  <Suspense fallback={<PageFallback />}>
                    <AlertsPage />
                  </Suspense>
                </ErrorBoundary>
              }
            />
            <Route
              path="/brooks"
              element={
                <ErrorBoundary>
                  <Suspense fallback={<PageFallback />}>
                    <BrooksPage />
                  </Suspense>
                </ErrorBoundary>
              }
            />
            <Route
              path="/research"
              element={
                <ErrorBoundary>
                  <Suspense fallback={<PageFallback />}>
                    <ResearchPage />
                  </Suspense>
                </ErrorBoundary>
              }
            />
            {/* W3-S1：管理端已独立构建（admin.html → dist-admin，经 /admin 前缀托管），
                用户端产物不再包含 admin 子应用；主域名 /admin 由 Caddy 与 user-api 物理隔离 */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
        <footer className="footer">{t('footer.disclaimer')}</footer>
        <Toasts />
        <Suspense fallback={null}>
          <AiAssistant />
        </Suspense>
      </AiProvider>
    </MarketProvider>
  )
}

function Shell(): JSX.Element {
  const { user, loading } = useAuth()
  const location = useLocation()
  const { t, i18n } = useTranslation()
  useEffect(() => { const lang = new URLSearchParams(location.search).get('lang'); if (lang === 'zh-CN' || lang === 'en-US') void i18n.changeLanguage(lang) }, [location.search, i18n])
  const dev = location.pathname === '/research' && researchUiMode(location.search) === 'dev'
  const workbench = <ErrorBoundary><Suspense fallback={<PageFallback />}><WorkbenchPage key={user?.username ?? 'guest'} /></Suspense></ErrorBoundary>

  return (
    <>
      <div className="bg-fx" aria-hidden>
        <div className="bg-grid" />
        {user && !dev ? <AuroraBg /> : null}
        <div className="bg-glow glow-a" />
        <div className="bg-glow glow-b" />
      </div>
      {loading ? (
        <div className="auth-wrap">
          <div className="auth-loading">{t('app.verifying')}</div>
        </div>
      ) : dev ? (
        user ? <MarketProvider>{workbench}<Toasts /></MarketProvider> : workbench
      ) : user && (location.pathname === '/login' || location.pathname === '/register') ? (
        <Navigate to={authReturnTo(location.search, location.state as { from?: string } | null)} replace />
      ) : user ? (
        <AuthedApp />
      ) : (
        <main className="main">
          <MembershipCard />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<Navigate to={authUrl('/login', `${location.pathname}${location.search}${location.hash}`, researchUiMode(location.search))} replace />} />
          </Routes>
        </main>
      )}
    </>
  )
}

export default function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <AuthProvider><MembershipProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Shell /></BrowserRouter>
      </MembershipProvider></AuthProvider>
    </ErrorBoundary>
  )
}
