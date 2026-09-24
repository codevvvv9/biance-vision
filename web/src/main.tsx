import { createRoot } from 'react-dom/client'
import App from './App'
import { applyUpColor, readUpColor } from './utils'
import './styles.css'

// 挂载前应用涨跌配色偏好，避免首屏闪一下默认色
applyUpColor(readUpColor())

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root 元素不存在')

createRoot(rootEl).render(<App />)