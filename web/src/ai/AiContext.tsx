import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { lsGet, lsSet } from '../utils'

export interface AiStatus {
  configured: boolean
  model: string
}

interface AiContextValue {
  status: AiStatus
  refresh: () => Promise<void>
  /** 机器人是否显示（配置完成且用户未右键隐藏） */
  robotVisible: boolean
  showRobot: () => void
  hideRobot: () => void
  chatOpen: boolean
  setChatOpen: (v: boolean) => void
  /** 其他页面注入的一条待发送消息（如 /brooks 页「AI 解读」）：打开聊天窗并自动发送 */
  pendingPrompt: string | null
  askAi: (prompt: string) => void
  consumePendingPrompt: () => void
}

const Ctx = createContext<AiContextValue | null>(null)
const HIDDEN_KEY = 'bv.aiRobotHidden'

export function AiProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<AiStatus>({ configured: false, model: '' })
  const [robotHidden, setRobotHidden] = useState<boolean>(() => lsGet<boolean>(HIDDEN_KEY, false))
  const [chatOpen, setChatOpen] = useState(false)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)

  const askAi = useCallback((prompt: string): void => {
    if (!prompt.trim()) return
    setPendingPrompt(prompt)
    setChatOpen(true)
  }, [])

  const consumePendingPrompt = useCallback((): void => {
    setPendingPrompt(null)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api<AiStatus>('/ai/status'))
    } catch {
      /* 未配置 / 网络异常时保持默认 */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const showRobot = useCallback((): void => {
    lsSet(HIDDEN_KEY, false)
    setRobotHidden(false)
  }, [])

  const hideRobot = useCallback((): void => {
    lsSet(HIDDEN_KEY, true)
    setRobotHidden(true)
    setChatOpen(false)
  }, [])

  return (
    <Ctx.Provider
      value={{
        status,
        refresh,
        robotVisible: status.configured && !robotHidden,
        showRobot,
        hideRobot,
        chatOpen,
        setChatOpen,
        pendingPrompt,
        askAi,
        consumePendingPrompt,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useAi(): AiContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAi 必须在 AiProvider 内使用')
  return v
}
