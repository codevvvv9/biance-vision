import { parseEntry } from './websiteEntry'

/** UI selection is local to the URL; it never changes API environments or permissions. */
export type ResearchUiMode = 'legacy' | 'dev'

export function researchUiMode(search: string): ResearchUiMode {
  return new URLSearchParams(search).get('ui') === 'dev' ? 'dev' : 'legacy'
}

export function researchUrl(search: string, mode: ResearchUiMode, ids?: { conversation?: string | null; run?: string | null }): string {
  const params = new URLSearchParams(search)
  params.set('ui', mode)
  for (const key of ['conversation', 'run'] as const) {
    if (ids && key in ids) {
      if (ids[key]) params.set(key, ids[key]!)
      else params.delete(key)
    }
  }
  return `/research?${params.toString()}`
}

/** Only same-site paths are valid login return destinations. */
export function authReturnTo(search: string, state?: { from?: string } | null): string {
  const candidate = new URLSearchParams(search).get('returnTo') ?? state?.from
  if (candidate?.startsWith('/') && !candidate.startsWith('//') && !/[\\\x00-\x20]/.test(candidate)) return candidate === '/' ? '/dashboard' : candidate
  return '/research?ui=dev'
}

export function authUrl(path: '/login' | '/register', returnTo: string, mode: ResearchUiMode): string {
  return `${path}?${new URLSearchParams({ ui: mode, returnTo }).toString()}`
}

/** Contact detours can return to a pending deep link in this tab for 30 minutes. */
const AUTH_RETURN_KEY = 'bv.auth-return.v1'
export function rememberAuthReturn(target: string): void {
  try { sessionStorage.setItem(AUTH_RETURN_KEY, JSON.stringify({ target: authReturnTo('', { from: target }), createdAt: Date.now() })) } catch { /* The explicit login URL still works without storage. */ }
}
export function clearAuthReturn(): void { try { sessionStorage.removeItem(AUTH_RETURN_KEY) } catch { /* Optional recovery. */ } }
export function pendingAuthReturnTo(search: string, state?: { from?: string } | null): string {
  const explicit = authReturnTo(search, state)
  if (explicit !== '/research?ui=dev') return explicit
  try {
    // A newly prepared website question opens a fresh research context.
    if (parseEntry(sessionStorage.getItem('bv.research-entry.v1'))) return explicit
    const saved = JSON.parse(sessionStorage.getItem(AUTH_RETURN_KEY) || 'null') as { target?: string; createdAt?: number } | null
    if (saved && Number.isSafeInteger(saved.createdAt) && saved.createdAt! <= Date.now() && Date.now() - saved.createdAt! < 30 * 60_000 && typeof saved.target === 'string') return authReturnTo('', { from: saved.target })
    clearAuthReturn()
  } catch { /* Browser storage is optional. */ }
  return explicit
}
