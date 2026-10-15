/**
 * 入场渐显上浮容器：--fx-i 为同类列表 stagger 序号（55ms 步进，CSS 完成）。
 * 需要保持 DOM 结构不变的场景（表格行/网格卡）直接加 .fx-in 类 + style --fx-i。
 */
import type { CSSProperties, ReactNode } from 'react'

interface Props {
  children: ReactNode
  index?: number
  className?: string
  style?: CSSProperties
}

export default function FadeIn({ children, index = 0, className = '', style }: Props): JSX.Element {
  return (
    <div className={`fx-in ${className}`.trim()} style={{ '--fx-i': index, ...style } as CSSProperties}>
      {children}
    </div>
  )
}
