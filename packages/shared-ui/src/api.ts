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
    throw new Error(detail || i18n.t('common:api.requestFailed', { code: res.status }))
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
