import { startTelemetry } from '@biance/shared-ui'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyUpColor, readUpColor } from './utils'
import './i18n'
import './styles/index.css'

// 挂载前应用涨跌配色偏好，避免首屏闪一下默认色
applyUpColor(readUpColor())

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root 元素不存在')

// P2a-3 错误遥测（client_error/operation_failed；登出 reset 由 AuthContext 调用）
startTelemetry({ pageId: `user:` + location.pathname.slice(0, 48) })
createRoot(rootEl).render(<App />)