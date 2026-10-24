import { createBrowserRouter, Navigate, Outlet, useMatches, useNavigate, useRouteError } from 'react-router-dom'
import { Button, Result } from 'antd'
import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@biance/shared-ui'
import { ADMIN_ROUTES, type AdminRouteDef } from './routes'
import { adminBasename } from './app/paths'
import AdminGate, { AdminSessionNotice, useSessionNotice } from './AdminGate'
import AdminShell from './AdminLayout'
const AiSettingsModal = lazy(() => import('./AiSettingsModal'))
import { DirtyForms, useConfirmDiscard } from './ui/forms'
import { useAdminText } from './ui/text'
import { LegacyBoundary } from './ui/LegacyBoundary'
function AdminFrame(): JSX.Element {
  const { user, logout } = useAuth()
  const { t } = useTranslation('admin')
  const text = useAdminText()
  const matches = useMatches()
  const active = [...matches].reverse().find(match => match.handle) ?.handle as AdminRouteDef | undefined
  const [aiOpen, setAiOpen] = useState(false)
  const confirmDiscard = useConfirmDiscard()
  const { setNotice } = useSessionNotice()
  const navigate = useNavigate()
  const signOut = async () => {
    if (!(await confirmDiscard())) return
    await logout()
    // The shared logout deliberately swallows failures. Verify server revocation
    // without changing that user-app contract or issuing a second logout request.
    try { const response = await fetch('/api/auth/me', { credentials: 'same-origin' }); setNotice(response.status === 401 ? '' : text('logoutUnconfirmed')) } catch { setNotice(text('logoutUnconfirmed')) }
    navigate('/', { replace: true })
  }
  return <AdminShell navigation={ADMIN_ROUTES.map(route => ({ id: route.id, href: route.index ? '/' : `/${route.path}`, label: t(route.labelKey), hint: t(route.hintKey), icon: route.icon }))} selected={active?.id ?? ''} title={active ? t(active.labelKey) : t('layout.title')} hint={active ? t(active.hintKey) : ''} username={user?.username ?? ''} onLogout={() => void signOut()} onAiSettings={() => setAiOpen(true)}>
    <Outlet />{aiOpen && <Suspense><AiSettingsModal onClose={() => setAiOpen(false)} /></Suspense>}
  </AdminShell>
}
function Root(): JSX.Element { return <AdminSessionNotice><DirtyForms><AdminGate /></DirtyForms></AdminSessionNotice> }
function RouteError(): JSX.Element {
  const error = useRouteError()
  const text = useAdminText()
  return <Result status="error" title={text('pageFailed')} subTitle={error instanceof Error ? error.message : undefined} extra={<Button onClick={() => window.location.reload()}>{text('retry')}</Button>} />
}
export function createAdminRouter() {
  return createBrowserRouter([{ element: <Root />, errorElement: <RouteError />, children: [{ element: <AdminFrame />, children: [
    ...ADMIN_ROUTES.map(route => ({ id: route.id, ...(route.index ? { index: true as const } : { path: route.path }), handle: route, lazy: async () => { const { default: Page } = await route.load(); return { Component: route.legacy ? () => <LegacyBoundary><Page /></LegacyBoundary> : Page } } })),
    { path: '*', element: <Navigate to="/" replace /> },
  ] }] }], { basename: adminBasename, future: { v7_relativeSplatPath: true } })
}
