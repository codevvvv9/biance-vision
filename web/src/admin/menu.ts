/** 管理后台菜单配置：Header 用户下拉与 AdminLayout 内部导航共用同一份数据源 */
export interface AdminMenuItem {
  path: string
  label: string
  hint: string
}

export const ADMIN_MENU: AdminMenuItem[] = [
  { path: '/admin', label: '管理面板', hint: '用户 / 日志' },
  { path: '/admin/ai', label: 'AI 会话', hint: '上下文 / 记忆' },
  { path: '/admin/knowledge', label: '知识库', hint: '导入 / 发布 / 检索调试' },
  { path: '/admin/agents', label: 'Agent 配置', hint: '能力 / 版本 / 回滚' },
  { path: '/admin/evals', label: '评测与模型', hint: '数据集 / 训练 / 指标' },
]
