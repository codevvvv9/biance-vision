import { api } from '../../../api'
import type { AiProfileMasked, AdminUser } from '../../../types'
export const loadAiConfig = () => Promise.all([api<{ profiles: Record<string, AiProfileMasked> }>('/admin/ai/config'), api<{ users: AdminUser[] }>('/admin/users')]).then(([config, users]) => ({ ...config, ...users }))
export const loadModels = (name: string) => api<{ models: string[] }>(`/admin/ai/models?name=${encodeURIComponent(name)}`)
export const loadPrompt = (name: string) => api<{ prompt: string }>(`/admin/ai/prompt?name=${encodeURIComponent(name)}`)
export const saveAiConfig = (profiles: unknown) => api('/admin/ai/config', { method: 'PUT', body: { profiles } })
export const clearAiConfig = () => api('/admin/ai/config', { method: 'DELETE' })
export const testAiConfig = (name: string, profile: unknown) => api<{ ok: boolean; message: string }>(`/admin/ai/test?name=${encodeURIComponent(name)}`, { method: 'POST', body: profile })
