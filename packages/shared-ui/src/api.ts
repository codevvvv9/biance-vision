import i18n from './i18n'
import type {
  AdminConversationDetail,
  AdminConversationSummary,
  AdminUserRow,
  ChatPolicy,
} from './types'

export interface ApiOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** 幂等键（P1-5 起高成本写操作携带；此处透传） */
  idempotencyKey?: string
}

/**
 * 统一 API 错误（P0-3）：携带 status/code/requestId/retryAfterSeconds——
 * 旧调用方读取 message 仍有效；错误展示可附「请求编号」（报障定位抓手）。
 */
export class ApiError extends Error {
  status: number
  code: string | null
  requestId: string | null
  retryAfterSeconds: number | null

  constructor(init: { status: number; message: string; code?: string; requestId?: string; retryAfterSeconds?: number }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code ?? null
    this.requestId = init.requestId ?? null
    this.retryAfterSeconds = init.retryAfterSeconds ?? null
  }
}

/** 会话失效（401）时的回调，由 AuthContext 注册：把界面切回登录页 */
let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers }
  // 无 body 时不能带 content-type: json——Fastify 对空 body + json 头直接 400（FST_ERR_CTP_EMPTY_JSON_BODY），
  // 会打死所有无 body 的 POST/PUT（logout/取消 run/chat-cutoff/settings 测试）
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
  const res = await fetch(`/api${path}`, {
    headers,
    method: options.method,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  })
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.()
    let detail = ''
    let code: string | undefined
    let retryAfterSeconds: number | undefined
    try {
      const parsed = (await res.json()) as { message?: string; code?: string; retryAfterSeconds?: number }
      detail = parsed.message ?? ''
      code = parsed.code
      retryAfterSeconds = parsed.retryAfterSeconds
    } catch {
      /* noop */
    }
    throw new ApiError({
      status: res.status,
      message: detail || i18n.t('common:api.requestFailed', { code: res.status }),
      code,
      requestId: res.headers.get('x-request-id') ?? undefined,
      retryAfterSeconds,
    })
  }
  return (await res.json()) as T
}

// ---- 管理端：用户聊天管控 / 研究会话追踪（仅超管，对应 /api/admin/*） ----

/** GET /api/admin/users：用户列表（含聊天管控、当日用量与在线近似） */
export function fetchAdminUsers(): Promise<{ users: AdminUserRow[] }> {
  return api('/admin/users')
}

/** PUT /api/admin/users/:username/chat-policy：禁用/解禁，或设每日上限（dailyLimit null = 不限） */
export function updateChatPolicy(
  username: string,
  patch: { disabled?: boolean; dailyLimit?: number | null },
): Promise<{ username: string; chatPolicy: ChatPolicy }> {
  return api(`/admin/users/${encodeURIComponent(username)}/chat-policy`, { method: 'PUT', body: patch })
}

/** POST /api/admin/users/:username/chat-cutoff：一键禁用聊天并取消其全部进行中研究运行；cancelDeferred=true 表示取消被延迟（数据库暂不可用） */
export function cutOffUserChat(username: string): Promise<{ disabled: boolean; cancelledRuns: string[]; cancelDeferred?: boolean }> {
  return api(`/admin/users/${encodeURIComponent(username)}/chat-cutoff`, { method: 'POST' })
}

/** GET /api/admin/conversations?username=：指定用户的研究会话列表（链路 B） */
export function fetchAdminConversations(username: string, limit = 50): Promise<{ conversations: AdminConversationSummary[] }> {
  return api(`/admin/conversations?username=${encodeURIComponent(username)}&limit=${limit}`)
}

/** GET /api/admin/conversations/:id：会话完整消息 + 引用研究运行摘要 */
export function fetchAdminConversation(id: string): Promise<AdminConversationDetail> {
  return api(`/admin/conversations/${encodeURIComponent(id)}`)
}
