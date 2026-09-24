import { useEffect, useRef } from 'react'

interface CurveConf {
  base: number // 基线在视口高度的比例
  amp: number // 波动幅度 px
  speed: number // 每秒左移 px
  drift: number // 趋势偏置（正=多头缓慢上移）
  step: number // 相邻点水平间距 px
  stroke: string
  fill: string
  dotCore: string
  dotGlow: string
}

interface CurveState extends CurveConf {
  points: number[] // 相对基线的 y 偏移，从左到右
  offset: number // 距下次补点的累计位移
  value: number // 随机游走的当前值
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

const CURVES: CurveConf[] = [
  {
    base: 0.32,
    amp: 52,
    speed: 30,
    drift: 1,
    step: 26,
    stroke: 'rgba(0, 229, 255, 0.34)',
    fill: 'rgba(0, 229, 255, 0.06)',
    dotCore: 'rgba(0, 229, 255, 0.9)',
    dotGlow: 'rgba(0, 229, 255, 0.25)',
  },
  {
    base: 0.68,
    amp: 72,
    speed: 17,
    drift: -1,
    step: 34,
    stroke: 'rgba(124, 92, 255, 0.28)',
    fill: 'rgba(124, 92, 255, 0.05)',
    dotCore: 'rgba(167, 139, 250, 0.9)',
    dotGlow: 'rgba(167, 139, 250, 0.22)',
  },
]

const LINK_DIST = 150 // 粒子间连线的最大距离

/** 随机游走一步：围绕 0 波动，越界回弹，叠加缓慢单边趋势 */
function walk(value: number, amp: number, drift: number): number {
  let nv = value + (Math.random() - 0.5 + drift * 0.1) * amp * 0.3
  if (nv > amp) nv = amp - (nv - amp) * 0.5
  if (nv < -amp) nv = -amp + (-amp - nv) * 0.5
  return nv
}

/**
 * 登录页 canvas 动效：行情走势曲线滚动 + 粒子节点网络。
 * rAF 驱动，页面隐藏时由浏览器自动暂停；prefers-reduced-motion 时只画静态一帧。
 */
export default function AuthCanvas(): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let w = 0
    let h = 0
    const curves: CurveState[] = []
    let particles: Particle[] = []

    const initEntities = (): void => {
      curves.length = 0
      for (const c of CURVES) {
        const n = Math.ceil(w / c.step) + 3
        const st: CurveState = { ...c, points: [], offset: 0, value: (Math.random() - 0.5) * c.amp * 0.6 }
        for (let i = 0; i < n; i++) {
          st.value = walk(st.value, c.amp, c.drift)
          st.points.push(st.value)
        }
        curves.push(st)
      }
      const count = Math.max(24, Math.min(48, Math.round((w * h) / 42000)))
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 16,
        vy: (Math.random() - 0.5) * 13,
        r: 0.9 + Math.random() * 1.5,
      }))
    }

    const draw = (dt: number): void => {
      ctx.clearRect(0, 0, w, h)

      // ---- 粒子节点网络（区块链意象：漂浮节点近距连线）----
      for (const p of particles) {
        p.x += p.vx * dt
        p.y += p.vy * dt
        if (p.x < -20) p.x = w + 20
        else if (p.x > w + 20) p.x = -20
        if (p.y < -20) p.y = h + 20
        else if (p.y > h + 20) p.y = -20
      }
      ctx.lineWidth = 1
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 < LINK_DIST * LINK_DIST) {
            const alpha = (1 - Math.sqrt(d2) / LINK_DIST) * 0.13
            ctx.strokeStyle = `rgba(0, 229, 255, ${alpha.toFixed(3)})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }
      ctx.fillStyle = 'rgba(158, 222, 255, 0.5)'
      for (const p of particles) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }

      // ---- 行情走势曲线：随机游走 + 整体左移 ----
      for (const c of curves) {
        c.offset += c.speed * dt
        while (c.offset >= c.step) {
          c.offset -= c.step
          c.value = walk(c.value, c.amp, c.drift)
          c.points.push(c.value)
          if (c.points.length > Math.ceil(w / c.step) + 3) c.points.shift()
        }

        const baseY = h * c.base
        const n = c.points.length

        // 面积填充（自上而下渐隐）
        ctx.beginPath()
        for (let i = 0; i < n; i++) {
          const x = i * c.step - c.offset
          const y = baseY + c.points[i]
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.lineTo(n * c.step - c.offset, h)
        ctx.lineTo(-c.step, h)
        ctx.closePath()
        const g = ctx.createLinearGradient(0, baseY - c.amp, 0, baseY + c.amp * 2)
        g.addColorStop(0, c.fill)
        g.addColorStop(1, 'rgba(0, 0, 0, 0)')
        ctx.fillStyle = g
        ctx.fill()

        // 描线
        ctx.beginPath()
        for (let i = 0; i < n; i++) {
          const x = i * c.step - c.offset
          const y = baseY + c.points[i]
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = c.stroke
        ctx.lineWidth = 1.6
        ctx.stroke()

        // 屏幕右缘的“实时报价点”：y 在最后两点间插值，永远贴着当前时刻
        const fi = (w + c.offset) / c.step
        const i0 = Math.min(Math.floor(fi), n - 2)
        const t = Math.min(Math.max(fi - i0, 0), 1)
        const px = w
        const py = baseY + c.points[i0] * (1 - t) + c.points[i0 + 1] * t

        // 向下的渐隐竖线（最新价指示线）
        const vg = ctx.createLinearGradient(0, py, 0, py + 90)
        vg.addColorStop(0, c.stroke.replace(/0\.\d+\)$/, '0.16)'))
        vg.addColorStop(1, 'rgba(0, 0, 0, 0)')
        ctx.strokeStyle = vg
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(px, py + 90)
        ctx.stroke()

        // 发光端点
        const dot = ctx.createRadialGradient(px, py, 0, px, py, 16)
        dot.addColorStop(0, c.dotCore)
        dot.addColorStop(0.35, c.dotGlow)
        dot.addColorStop(1, 'rgba(0, 0, 0, 0)')
        ctx.fillStyle = dot
        ctx.beginPath()
        ctx.arc(px, py, 16, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = c.dotCore
        ctx.beginPath()
        ctx.arc(px, py, 2, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const onResize = (): void => {
      w = window.innerWidth
      h = window.innerHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      initEntities()
      if (reduced) draw(0)
    }
    onResize()
    window.addEventListener('resize', onResize)

    if (!reduced) {
      let last = performance.now()
      const frame = (now: number): void => {
        const dt = Math.min((now - last) / 1000, 0.1)
        last = now
        draw(dt)
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return <canvas className="fx-canvas" ref={ref} />
}
