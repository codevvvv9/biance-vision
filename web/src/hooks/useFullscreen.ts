import { useEffect, useRef, useState } from 'react'

/**
 * 面板级全屏：把返回的 ref 挂到面板根元素上，toggle() 进出全屏。
 * 监听 fullscreenchange 同步状态，Esc / 系统手势退出也能正确回滚 UI。
 */
export function useFullscreen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onFsChange = (): void => setIsFullscreen(document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const toggle = (): void => {
    const el = ref.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen().catch(() => {})
  }

  return { ref, isFullscreen, toggle }
}
