/**
 * 流动描边（React Bits Border Beam 的零依赖实现）。
 * conic 渐变沿元素边缘旋转（@property --fx-angle 驱动）；
 * 不支持 @property 的浏览器退化为静态渐变环。reduced-motion 由 CSS 全局降级。
 * 也可以不包组件，直接给元素加 .fx-beam 类并设置 --fx-beam-c/--fx-beam-t 变量。
 */
import type { CSSProperties, ReactNode } from 'react'

interface Props {
  children: ReactNode
  className?: string
  /** 光束主色（默认 var(--cyan)） */
  color?: string
  /** 光束副色（尾焰，默认 var(--purple)） */
  color2?: string
  /** 旋转一圈时长 ms */
  duration?: number
  /** 描边环宽度 px */
  width?: number
  style?: CSSProperties
}

export default function BorderBeam({ children, className = '', color, color2, duration = 5000, width = 1.5, style }: Props): JSX.Element {
  const vars = {
    '--fx-beam-t': `${duration}ms`,
    '--fx-beam-w': `${width}px`,
    ...(color !== undefined ? { '--fx-beam-c': color } : {}),
    ...(color2 !== undefined ? { '--fx-beam-c2': color2 } : {}),
  } as CSSProperties
  return (
    <div className={`fx-beam ${className}`.trim()} style={{ ...vars, ...style }}>
      {children}
    </div>
  )
}
