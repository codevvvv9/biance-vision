import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { researchUiMode, researchUrl } from './uiMode'

export function UiModeSwitch({ conversationId, runId, disabled = false }: { conversationId?: string | null; runId?: string | null; disabled?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const { search } = useLocation()
  const mode = researchUiMode(search)
  const ids: { conversation?: string | null; run?: string | null } = {}
  if (conversationId !== undefined) ids.conversation = conversationId
  if (runId !== undefined) ids.run = runId
  return <Link className="ui-mode-switch" aria-disabled={disabled || undefined} title={disabled ? t('research:uiMode.waitHint') : undefined} onClick={e => { if (disabled) e.preventDefault() }} to={researchUrl(search, mode === 'dev' ? 'legacy' : 'dev', ids)}>
    {mode === 'dev' ? t('research:uiMode.legacy') : t('research:uiMode.dev')}<span aria-hidden> ↗</span>
  </Link>
}
