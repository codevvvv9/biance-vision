import { Navigate, Route, Routes } from 'react-router-dom'
import AdminLayout from './AdminLayout'
import AdminPage from './AdminPage'
import AdminAgentsPage from './AdminAgentsPage'
import AdminEvalsPage from './AdminEvalsPage'
import AdminKnowledgePage from './AdminKnowledgePage'
import AiInsightsPage from './AiInsightsPage'

/** 管理后台子应用：经 App.tsx 的 React.lazy 按需加载，守卫集中在 AdminLayout */
export default function AdminApp(): JSX.Element {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<AdminPage />} />
        <Route path="ai" element={<AiInsightsPage />} />
        <Route path="knowledge" element={<AdminKnowledgePage />} />
        <Route path="agents" element={<AdminAgentsPage />} />
        <Route path="evals" element={<AdminEvalsPage />} />
        {/* 未知 admin 子路径保持改造前行为：跳回首页 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
