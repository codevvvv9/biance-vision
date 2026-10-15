/**
 * fx 动效层共享工具：reduced-motion 检测。
 * 所有 JS 参与的动效（磁吸/聚光/数字滚动）都先查此 hook，命中即退化为静态。
 */
import { useEffect, useState } from 'react'

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}
