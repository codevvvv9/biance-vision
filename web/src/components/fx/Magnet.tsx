/**
 * 磁吸容器（React Bits Magnet 的零依赖实现）：
 * 悬停时向光标方向轻微偏移（clamp 在 range 内），离开回弹。只写 CSS vars，
 * 动画交给 CSS transition；reduced-motion 时保持原位。
 */
import { useRef, type MouseEvent, type ReactNode } from 'react'
import { useReducedMotion } from './useReducedMotion'

interface Props {
  children: ReactNode
  /** 偏移系数（光标偏移 × 系数） */
  strength?: number
  /** 最大偏移 px */
  range?: number
  className?: string
}

export default function Magnet({ children, strength = 0.22, range = 8, className = '' }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()

  const move = (e: MouseEvent<HTMLDivElement>): void => {
    if (reduced || ref.current === null) return
    const r = ref.current.getBoundingClientRect()
    const dx = (e.clientX - (r.left + r.width / 2)) * strength
    const dy = (e.clientY - (r.top + r.height / 2)) * strength
    ref.current.style.setProperty('--fx-tx', `${Math.max(-range, Math.min(range, dx))}px`)
    ref.current.style.setProperty('--fx-ty', `${Math.max(-range, Math.min(range, dy))}px`)
  }

  const leave = (): void => {
    ref.current?.style.setProperty('--fx-tx', '0px')
    ref.current?.style.setProperty('--fx-ty', '0px')
  }

  return (
    <div ref={ref} className={`fx-magnet ${className}`.trim()} onMouseMove={move} onMouseLeave={leave}>
      {children}
    </div>
  )
}
