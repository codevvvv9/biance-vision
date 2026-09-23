import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Header from './components/Header'
import TickerTape from './components/TickerTape'
import Toasts from './components/Toasts'
import { MarketProvider } from './market/MarketContext'
import AlertsPage from './pages/AlertsPage'
import Dashboard from './pages/Dashboard'
import MoversPage from './pages/MoversPage'

export default function App(): JSX.Element {
  return (
    <MarketProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <div className="bg-fx" aria-hidden>
          <div className="bg-grid" />
          <div className="bg-glow glow-a" />
          <div className="bg-glow glow-b" />
        </div>
        <Header />
        <TickerTape />
        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/movers" element={<MoversPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <footer className="footer">
          数据来源：Binance 公开行情接口（REST + WebSocket，1s 推送） · 本工具仅供学习研究，不构成投资建议
        </footer>
        <Toasts />
      </BrowserRouter>
    </MarketProvider>
  )
}
