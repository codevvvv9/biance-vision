/** 管理后台菜单配置：AdminLayout 内部导航数据源（含图标）。
 * 主站 Header 的超管菜单入口已随 admin 域名隔离整体移除（主域名 /admin 双层 404），本表只服务管理域名。 */
export interface AdminMenuItem {
  path: string
  /** admin:* 词典 key（消费方用 t() 取当前语言；单一数据源不变） */
  labelKey: string
  hintKey: string
  icon: JSX.Element
}

function LogIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  )
}

function ChatLogIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="13" x2="13" y2="13" />
    </svg>
  )
}

function BookIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5z" />
      <path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20" />
    </svg>
  )
}

function TuneIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h13M21 18h-1" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="19" cy="18" r="2" />
    </svg>
  )
}

function ChartIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  )
}

function PromptIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 5h16M4 12h10M4 19h7" />
      <path d="M17.5 14.5 21 18l-3.5 3.5" />
    </svg>
  )
}

export const ADMIN_MENU: AdminMenuItem[] = [
  { path: '/admin', labelKey: 'admin:menu.panel', hintKey: 'admin:menu.panelHint', icon: <LogIcon /> },
  { path: '/admin/ai', labelKey: 'admin:menu.ai', hintKey: 'admin:menu.aiHint', icon: <ChatLogIcon /> },
  { path: '/admin/knowledge', labelKey: 'admin:menu.knowledge', hintKey: 'admin:menu.knowledgeHint', icon: <BookIcon /> },
  { path: '/admin/agents', labelKey: 'admin:menu.agents', hintKey: 'admin:menu.agentsHint', icon: <TuneIcon /> },
  { path: '/admin/prompts', labelKey: 'admin:menu.prompts', hintKey: 'admin:menu.promptsHint', icon: <PromptIcon /> },
  { path: '/admin/evals', labelKey: 'admin:menu.evals', hintKey: 'admin:menu.evalsHint', icon: <ChartIcon /> },
]
