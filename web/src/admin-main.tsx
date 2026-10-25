import { startTelemetry, mountDevDebug } from '@biance/shared-ui'/** Independent admin composition root. User providers and styles stay outside. */
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { ErrorBoundary, AuthProvider } from '@biance/shared-ui'
import { createAdminRouter } from './admin'
import { AdminTheme } from './admin/app/Theme'
import './i18n'
import './styles/tokens.css'
import './admin/ui/document.css'
const root = document.getElementById('root')
if (!root) throw new Error('#root is required')
const overlays = document.createElement('div')
overlays.id = 'admin-overlays'
document.body.append(overlays)
const router = createAdminRouter()
// P2a-3 错误遥测（client_error/operation_failed；登出 reset 由 AuthContext 调用）
if (import.meta.env.DEV) mountDevDebug()
startTelemetry({ pageId: `admin:` + location.pathname.slice(0, 48) })
createRoot(root).render(<ErrorBoundary><AuthProvider><AdminTheme><RouterProvider router={router} future={{ v7_startTransition: true }} /></AdminTheme></AuthProvider></ErrorBoundary>)
