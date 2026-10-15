/**
 * Aurora 极光背景（React Bits Aurora 的零依赖实现，品牌色青/紫/蓝）：
 * - 低分辨率离屏 canvas（宽 ~360px）绘制正弦叠加色带，主画布拉伸 + CSS blur，
 *   每帧只算 3 条波 × ~70 采样点，成本可忽略；
 * - 动画周期 20s+，缓慢流动不抢数据注意力；
 * - document.hidden 停 rAF；prefers-reduced-motion 时画一帧静态后停。
 */
import { useEffect, useRef } from 'react'

interface WaveConf {
  color: string
  /** 波峰基准高度（视口高度比例） */
  base: number
  amplitude: number
  speed: number
  /** 叠加的第二谐波速度 */
  speed2: number
  alpha: number
}

const WAVES: WaveConf[] = [
  { color: '0, 229, 255', base: 0.16, amplitude: 0.05, speed: 0.00013, speed2: 0.00021, alpha: 0.16 },
  { color: '124, 92, 255', base: 0.24, amplitude: 0.07, speed: 0.00009, speed2: 0.00016, alpha: 0.13 },
  { color: '77, 163, 255', base: 0.1, amplitude: 0.04, speed: 0.00017, speed2: 0.00011, alpha: 0.1 },
]

const OFF_W = 480

export default function AuroraBg(): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const off = document.createElement('canvas')
    off.width = OFF_W
    off.height = Math.round(OFF_W * 0.5)
    const offCtx = off.getContext('2d')
    if (offCtx === null) return

    let raf = 0
    let stopped = false

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = (t: number): void => {
      const w = off.width
      const h = off.height
      offCtx.clearRect(0, 0, w, h)
      offCtx.globalCompositeOperation = 'lighter'
      for (const wave of WAVES) {
        offCtx.beginPath()
        offCtx.moveTo(0, h)
        for (let x = 0; x <= w; x += 4) {
          const p = x / w
          const y =
            h * wave.base +
            Math.sin(p * 5.2 + t * wave.speed) * h * wave.amplitude +
            Math.sin(p * 11.7 - t * wave.speed2 + 2) * h * wave.amplitude * 0.5
          offCtx.lineTo(x, y)
        }
        offCtx.lineTo(w, h)
        offCtx.closePath()
        const grad = offCtx.createLinearGradient(0, 0, 0, h)
        grad.addColorStop(0, `rgba(${wave.color}, ${wave.alpha})`)
        grad.addColorStop(1, `rgba(${wave.color}, 0)`)
        offCtx.fillStyle = grad
        offCtx.fill()
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(off, 0, 0, canvas.width, canvas.height)
      if (!stopped && !reduced) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    const onVis = (): void => {
      if (document.hidden) {
        stopped = true
        cancelAnimationFrame(raf)
      } else if (!reduced) {
        stopped = false
        raf = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return <canvas ref={canvasRef} className="fx-aurora" aria-hidden />
}
