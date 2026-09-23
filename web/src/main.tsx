import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root 元素不存在')

createRoot(rootEl).render(<App />)
