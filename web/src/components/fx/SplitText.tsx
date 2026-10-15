/**
 * 逐字入场（React Bits SplitText 的零依赖实现）。
 * rise / blur 两种效果；gradient 支持首尾色逐字插值——终态呈现整行渐变，
 * 避免父级 background-clip:text 与逐字 transform 动画相互干扰。
 */
import { useReducedMotion } from './useReducedMotion'

/** 16 进制颜色线性插值 */
function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  const [r, g, blue] = pa.map((v, i) => Math.round(v + (pb[i] - v) * t))
  return `rgb(${r}, ${g}, ${blue})`
}

interface Props {
  text: string
  effect?: 'rise' | 'blur'
  /** 起始延迟 s */
  delay?: number
  /** 逐字步进 s */
  step?: number
  /** 首尾色（如 ['#00e5ff', '#a78bfa']） */
  gradient?: [string, string]
  className?: string
}

export default function SplitText({ text, effect = 'rise', delay = 0, step = 0.032, gradient, className = '' }: Props): JSX.Element {
  const reduced = useReducedMotion()
  if (reduced) return <span className={className}>{text}</span>
  const chars = Array.from(text)
  return (
    <span className={`fx-split fx-${effect} ${className}`.trim()} aria-label={text}>
      {chars.map((ch, i) => (
        <span
          key={`${ch}-${i}`}
          aria-hidden
          className="fx-ch"
          style={{
            animationDelay: `${(delay + i * step).toFixed(3)}s`,
            ...(gradient !== undefined
              ? { color: lerpHex(gradient[0], gradient[1], chars.length > 1 ? i / (chars.length - 1) : 0) }
              : {}),
          }}
        >
          {ch === ' ' ? '\u00A0' : ch}
        </span>
      ))}
    </span>
  )
}
