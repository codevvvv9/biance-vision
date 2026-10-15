/**
 * 容器级聚光（React Bits Spotlight 的零依赖实现）：
 * 容器挂一个 rAF 节流的 mousemove，把光标坐标（百分比）写进命中的 .fx-spot
 * 卡片的 --fx-mx/--fx-my，渲染全部交给 CSS（radial-gradient ::after）。
 * 子元素只需加 .fx-spot 类；reduced-motion 下不挂监听。
 */
import { useEffect, type RefObject } from 'react'

export function useSpotlight(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let target: HTMLElement | null = null
    let cx = 0
    let cy = 0
    const apply = (): void => {
      raf = 0
      if (target !== null) {
        const r = target.getBoundingClientRect()
        target.style.setProperty('--fx-mx', `${((cx - r.left) / r.width) * 100}%`)
        target.style.setProperty('--fx-my', `${((cy - r.top) / r.height) * 100}%`)
      }
    }
    const onMove = (e: MouseEvent): void => {
      target = (e.target as HTMLElement | null)?.closest<HTMLElement>('.fx-spot') ?? null
      cx = e.clientX
      cy = e.clientY
      if (raf === 0) raf = requestAnimationFrame(apply)
    }
    el.addEventListener('mousemove', onMove)
    return () => {
      el.removeEventListener('mousemove', onMove)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [ref])
}
