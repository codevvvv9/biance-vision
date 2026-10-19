import { Link, useLocation } from 'react-router-dom'
import { researchUiMode, researchUrl } from './uiMode'

export function UiModeSwitch({ conversationId, runId, disabled = false }: { conversationId?: string | null; runId?: string | null; disabled?: boolean }): JSX.Element {
  const { search } = useLocation()
  const mode = researchUiMode(search)
  const ids: { conversation?: string | null; run?: string | null } = {}
  if (conversationId !== undefined) ids.conversation = conversationId
  if (runId !== undefined) ids.run = runId
  return <Link className="ui-mode-switch" aria-disabled={disabled || undefined} title={disabled ? '请等待当前消息或确认操作完成' : undefined} onClick={e => { if (disabled) e.preventDefault() }} to={researchUrl(search, mode === 'dev' ? 'legacy' : 'dev', ids)}>
    {mode === 'dev' ? '切换旧版' : '体验新版'}<span aria-hidden> ↗</span>
  </Link>
}
