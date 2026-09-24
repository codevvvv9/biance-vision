import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, setUnauthorizedHandler } from '../api'
import type { AuthUser } from '../types'

interface AuthContextValue {
  user: AuthUser | null
  /** 初始会话探测中（此时不渲染任何路由，避免闪烁） */
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 会话过期 / 被踢下线时，任何接口返回 401 都直接回到登录页
    setUnauthorizedHandler(() => setUser(null))
    api<{ user: AuthUser }>('/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
    return () => setUnauthorizedHandler(null)
  }, [])

  const login = useCallback(async (username: string, password: string): Promise<void> => {
    const d = await api<{ user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: { username, password },
    })
    setUser(d.user)
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch {
      /* 本地状态照常清理 */
    }
    setUser(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return v
}
