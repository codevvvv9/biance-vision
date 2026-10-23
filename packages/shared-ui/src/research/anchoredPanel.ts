/**
 * 弹层定位 hook（Dropdown/Combobox 共用）：弹层渲染到 body（createPortal）+ fixed 定位，
 * 锚定触发按钮的视口矩形；底部空间不足自动向上翻；页面滚动/缩放时 rAF 跟随重算。
 * 背景：此前 absolute 定位会被祖先 overflow:hidden 裁剪（工作台底部下拉"看不见"）、
 * 或在 overflow:auto 容器内撑大滚动区（"顶开排版"）——脱离文档流的 fixed 弹层两者皆免。
 */
import { useEffect, useState, type RefObject } from 'react'

export interface AnchoredPanelPos {
  left: number
  top?: number
  bottom?: number
  minWidth: number
}

const PANEL_BUDGET = 276 // 弹层最大高度 260 + 间距预算，用于判断是否上翻

export function useAnchoredPanel(open: boolean, anchorRef: RefObject<HTMLElement | null>): AnchoredPanelPos | null {
  const [pos, setPos] = useState<AnchoredPanelPos | null>(null)

  useEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    let raf = 0
    const update = (): void => {
      const el = anchorRef.current
      if (el === null) {
        setPos(null)
        return
      }
      const r = el.getBoundingClientRect()
      const flipUp = r.bottom + PANEL_BUDGET > window.innerHeight && r.top > PANEL_BUDGET
      setPos({
        left: r.left,
        minWidth: r.width,
        ...(flipUp ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      })
    }
    update()
    const onMove = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(update)
    }
    // capture：捕获阶段监听，任意内层容器滚动都能跟随（下拉锚随内容滚动移动）
    window.addEventListener('scroll', onMove, { capture: true, passive: true })
    window.addEventListener('resize', onMove)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onMove, { capture: true })
      window.removeEventListener('resize', onMove)
    }
  }, [open, anchorRef])

  return pos
}
