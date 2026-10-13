/**
 * AI 聊天窗尺寸与最小化：右/下/右下角拖拽改尺寸（localStorage 记忆），
 * 最小化收成头部胶囊条；视口变化时把已有尺寸收回到限制内。
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { lsGet, lsSet } from '../utils'

export type ResizeDir = 'e' | 's' | 'se'

interface ChatSize {
  w: number
  h: number
}

interface ResizeHandleProps {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
}

const SIZE_KEY = 'bv.aiChatSize'
const MIN_W = 360
const MIN_H = 400

/** 尺寸限制：下限保证头部+输入区可用，上限不超过视口（留边距），另设硬上限 */
function clampSize(w: number, h: number): ChatSize {
  const maxW = Math.min(Math.max(window.innerWidth - 48, MIN_W), 1400)
  const maxH = Math.min(Math.max(window.innerHeight - 96, MIN_H), 1600)
  return {
    w: Math.round(Math.min(Math.max(w, MIN_W), maxW)),
    h: Math.round(Math.min(Math.max(h, MIN_H), maxH)),
  }
}

function loadSize(): ChatSize {
  const saved = lsGet<ChatSize | null>(SIZE_KEY, null)
  if (saved) return clampSize(saved.w, saved.h)
  return clampSize(560, Math.min(720, window.innerHeight - 96))
}

export function useChatSize(): {
  size: ChatSize
  minimized: boolean
  setMinimized: (v: boolean | ((m: boolean) => boolean)) => void
  resizeHandleProps: (dir: ResizeDir) => ResizeHandleProps
} {
  const [size, setSize] = useState(loadSize)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const [minimized, setMinimized] = useState(false)
  const resizeRef = useRef<{ dir: ResizeDir; startX: number; startY: number; startW: number; startH: number } | null>(null)
  // 最近一次计算出的尺寸：松手时直接持久化，避免 state 异步渲染导致存旧值
  const pendingSizeRef = useRef<ChatSize | null>(null)

  useEffect(() => {
    const onWinResize = (): void => setSize((s) => clampSize(s.w, s.h))
    window.addEventListener('resize', onWinResize)
    return () => window.removeEventListener('resize', onWinResize)
  }, [])

  const startResize = (e: ReactPointerEvent<HTMLDivElement>, dir: ResizeDir): void => {
    if (e.button !== 0) return
    resizeRef.current = { dir, startX: e.clientX, startY: e.clientY, startW: sizeRef.current.w, startH: sizeRef.current.h }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 指针未激活（如合成事件）时忽略，拖拽逻辑仍可用 */
    }
  }
  const moveResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const st = resizeRef.current
    if (!st) return
    const dw = st.dir === 's' ? 0 : e.clientX - st.startX
    const dh = st.dir === 'e' ? 0 : e.clientY - st.startY
    const next = clampSize(st.startW + dw, st.startH + dh)
    pendingSizeRef.current = next
    setSize(next)
  }
  const endResize = (): void => {
    if (!resizeRef.current) return
    resizeRef.current = null
    lsSet(SIZE_KEY, pendingSizeRef.current ?? sizeRef.current)
    pendingSizeRef.current = null
  }

  const resizeHandleProps = (dir: ResizeDir): ResizeHandleProps => ({
    onPointerDown: (e) => startResize(e, dir),
    onPointerMove: moveResize,
    onPointerUp: endResize,
    onPointerCancel: endResize,
  })

  return { size, minimized, setMinimized, resizeHandleProps }
}
