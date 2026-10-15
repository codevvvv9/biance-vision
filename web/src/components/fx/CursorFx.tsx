/**
 * 鼠标交互粒子（React Bits Particles + Click Spark 的零依赖融合实现）：
 * - 移动：按 14px 间距生成尾迹粒子（青为主，偶发紫），初速继承指针速度，指数衰减渐隐；
 * - 点击：12 粒放射火花 + 一圈扩散环；
 * - 单 canvas 单 rAF 循环，粒子上限 160（超出弃最老），dpr 封顶 1.5；
 * - pointer-events: none、z-index 40（内容之上、Header(50) 之下）；
 * - document.hidden 停循环；prefers-reduced-motion 不挂载。
 */
import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  purple: boolean
}

interface Ring {
  x: number
  y: number
  r: number
  life: number
}

const MAX_PARTICLES = 160
const SPAWN_DIST = 14
const DECAY = 0.94

export default function CursorFx(): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    let raf = 0
    let stopped = false
    let particles: Particle[] = []
    let rings: Ring[] = []
    let lastX = -1
    let lastY = -1
    let lastT = 0

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const spawnTrail = (x: number, y: number, vx: number, vy: number): void => {
      if (particles.length >= MAX_PARTICLES) particles.shift()
      particles.push({
        x: x + (Math.random() - 0.5) * 6,
        y: y + (Math.random() - 0.5) * 6,
        vx: vx * 0.25 + (Math.random() - 0.5) * 0.8,
        vy: vy * 0.25 + (Math.random() - 0.5) * 0.8,
        life: 1,
        maxLife: 550 + Math.random() * 350,
        size: 1 + Math.random() * 1.6,
        purple: Math.random() < 0.18,
      })
    }

    const spawnBurst = (x: number, y: number): void => {
      for (let i = 0; i < 12; i += 1) {
        const ang = (Math.PI * 2 * i) / 12 + Math.random() * 0.4
        const sp = 1.6 + Math.random() * 2.4
        if (particles.length >= MAX_PARTICLES) particles.shift()
        particles.push({
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 1,
          maxLife: 420 + Math.random() * 260,
          size: 1.2 + Math.random() * 1.4,
          purple: Math.random() < 0.25,
        })
      }
      rings.push({ x, y, r: 4, life: 1 })
    }

    const onMove = (e: MouseEvent): void => {
      const now = performance.now()
      const dt = lastT > 0 ? Math.min(64, now - lastT) : 16
      const vx = lastX >= 0 ? ((e.clientX - lastX) / dt) * 16 : 0
      const vy = lastY >= 0 ? ((e.clientY - lastY) / dt) * 16 : 0
      // 距上次生成超过 SPAWN_DIST 才补粒子（快速滑动按距离插值补齐，避免断点）
      if (lastX >= 0) {
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        const dist = Math.hypot(dx, dy)
        const steps = Math.max(1, Math.floor(dist / SPAWN_DIST))
        for (let i = 1; i <= steps; i += 1) {
          spawnTrail(lastX + (dx * i) / steps, lastY + (dy * i) / steps, vx, vy)
        }
      } else {
        spawnTrail(e.clientX, e.clientY, 0, 0)
      }
      lastX = e.clientX
      lastY = e.clientY
      lastT = now
      wake()
    }

    const onClick = (e: MouseEvent): void => {
      spawnBurst(e.clientX, e.clientY)
      wake()
    }

    let prev = performance.now()
    const loop = (now: number): void => {
      const dt = Math.min(64, now - prev)
      prev = now
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

      particles = particles.filter((p) => {
        p.life -= dt / p.maxLife
        if (p.life <= 0) return false
        p.x += p.vx * (dt / 16)
        p.y += p.vy * (dt / 16)
        p.vx *= DECAY
        p.vy *= DECAY
        const a = p.life * p.life
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size * (0.5 + p.life * 0.5), 0, Math.PI * 2)
        ctx.fillStyle = p.purple ? `rgba(167, 139, 250, ${0.5 * a})` : `rgba(0, 229, 255, ${0.55 * a})`
        ctx.fill()
        return true
      })

      rings = rings.filter((r) => {
        r.life -= dt / 480
        if (r.life <= 0) return false
        r.r += (dt / 16) * 1.8
        ctx.beginPath()
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(0, 229, 255, ${0.45 * r.life})`
        ctx.lineWidth = 1.2
        ctx.stroke()
        return true
      })

      if (!stopped && (particles.length > 0 || rings.length > 0)) {
        raf = requestAnimationFrame(loop)
      } else if (!stopped) {
        // 粒子清空后不再空转，下次鼠标事件再唤醒
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
        raf = 0
      }
    }

    const wake = (): void => {
      if (!stopped && raf === 0) {
        prev = performance.now()
        raf = requestAnimationFrame(loop)
      }
    }

    const onVis = (): void => {
      if (document.hidden) {
        stopped = true
        cancelAnimationFrame(raf)
        raf = 0
      } else {
        stopped = false
        wake()
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('pointerdown', onClick)
    document.addEventListener('visibilitychange', onVis)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('pointerdown', onClick)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return <canvas ref={canvasRef} className="fx-cursor" aria-hidden />
}
