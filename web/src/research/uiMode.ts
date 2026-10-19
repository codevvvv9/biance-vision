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
  if (candidate?.startsWith('/') && !candidate.startsWith('//') && !candidate.includes('\\')) return candidate
  return researchUiMode(search) === 'dev' ? '/research?ui=dev' : '/'
}

export function authUrl(path: '/login' | '/register', returnTo: string, mode: ResearchUiMode): string {
  return `${path}?${new URLSearchParams({ ui: mode, returnTo }).toString()}`
}
