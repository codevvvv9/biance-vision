interface ApiOptions {
  method?: string
  body?: unknown
}

/** 会话失效（401）时的回调，由 AuthContext 注册：把界面切回登录页 */
let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    method: options.method,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.()
    let detail = ''
    try {
      detail = ((await res.json()) as { message?: string }).message ?? ''
    } catch {
      /* noop */
    }
    throw new Error(detail || `请求失败 (HTTP ${res.status})`)
  }
  return (await res.json()) as T
}
