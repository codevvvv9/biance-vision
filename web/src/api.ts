interface ApiOptions {
  method?: string
  body?: unknown
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    method: options.method,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  if (!res.ok) {
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
