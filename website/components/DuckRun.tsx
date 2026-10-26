'use client'

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { brand, duck } from '@biance/brand/identity'
import { text, type Locale } from '@/lib/site'
import { defaultHeroGame, validateHeroGame } from '@/lib/hero-game'
import styles from './DuckRun.module.css'

const BEST_KEY = 'duckstrat.riskrun.best'

type Mode = 'idle' | 'playing' | 'over'
interface Pill { kind: 'pill'; x: number; y: number; label: string; glyph: string; w: number; wK: number; counted: boolean; seed: number }
interface Wall { kind: 'wall'; x: number; gapY: number; gapH: number; counted: boolean; seed: number }
interface Evidence { x: number; y: number; seed: number; taken: boolean }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; color: string; gravity: number }
interface FloatText { x: number; y: number; text: string; color: string; life: number }
type Obstacle = Pill | Wall
interface Result { time: number; dodged: number; evidence: number; newBest: boolean }

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rankFor(locale: Locale, seconds: number) {
  if (seconds >= 60) return text(locale, 'Disciplined strategist', '纪律策略师')
  if (seconds >= 30) return text(locale, 'Informed decisions', '有据判断')
  if (seconds >= 15) return text(locale, 'Risk aware', '初识风险')
  return text(locale, 'Still drifting', '随波逐流')
}

/**
 * Risk Run: the visitor steers the duck through a stream of market risks.
 * Canvas + rAF only — no new runtime dependency. The DOM overlay is part of
 * the server-rendered card, so first paint never depends on the game loop.
 */
export function DuckRun({ locale }: { locale: Locale }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Shared pointer channel: the React handler writes, the game loop reads.
  const pointerY = useRef(.5)
  const playTopRef = useRef(0)
  const playHRef = useRef(1)
  const modeRef = useRef<Mode>('idle')
  const startRef = useRef<() => void>(() => {})
  const hitRef = useRef<() => void>(() => {})
  const [mode, setMode] = useState<Mode>('idle')
  const [best, setBest] = useState<number | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(BEST_KEY)
      const value = stored === null ? Number.NaN : Number.parseInt(stored, 10)
      if (Number.isFinite(value) && value >= 0) setBest(value)
    } catch { /* private mode: play without a best score */ }
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const BODY = new Path2D(duck.body)
    const BEAK = new Path2D(duck.beak)
    const WING = new Path2D(duck.wing)

    let W = 0, H = 0, k = 1
    let playTop = 0, playH = 1, duckX = 0, duckH = 46, duckR = 14
    let raf = 0
    let inView = true, visible = !document.hidden
    let last = 0
    const rand = mulberry((Date.now() ^ (Math.random() * 0xffff)) >>> 0)

    const G = {
      t: 0, idleT: 0, worldX: 0, speed: 92,
      shields: 3, dodged: 0, evidence: 0,
      y: .5, target: .5, tilt: 0,
      invuln: 0, shake: 0, flash: 0, bubbleIn: 0,
      spawnIn: 1, evIn: 2.4, wallIn: 10,
      obstacles: [] as Obstacle[],
      evidenceList: [] as Evidence[],
      particles: [] as Particle[],
      floats: [] as FloatText[],
      kbd: { up: false, down: false },
    }
    // Admin-configured risk words and speed; falls back to built-in defaults.
    const config = { current: defaultHeroGame() }
    let configCancelled = false
    fetch('/site-config.json', { cache: 'no-store' })
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        if (configCancelled || !data || typeof data !== 'object') return
        const parsed = validateHeroGame((data as Record<string, unknown>).heroGame)
        if (parsed) config.current = parsed
      })
      .catch(() => { /* config is optional; defaults keep the game playable */ })

    const metrics = () => {
      k = Math.max(.45, W / 560)
      playTop = Math.max(24, H * .1)
      playH = H - playTop - Math.max(9, H * .05)
      duckX = Math.max(10, W * .02) + (W - Math.max(20, W * .04)) * .2
      duckH = Math.min(66, Math.max(40, H * .19))
      duckR = duckH * .3
      playTopRef.current = playTop
      playHRef.current = playH
    }

    const labelFont = (px: number) => `600 ${Math.max(9, Math.round(px * k))}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`
    const monoFont = (px: number, weight = '') => `${weight} ${Math.round(px)}px "SFMono-Regular", Consolas, "PingFang SC", monospace`.trim()

    const measurePill = (label: string) => {
      ctx.font = labelFont(10.5)
      return ctx.measureText(label).width + 46 * k
    }

    const burst = (x: number, y: number, color: string, count: number, spread = 130) => {
      for (let i = 0; i < count; i++) {
        const angle = rand() * Math.PI * 2
        const speed = 30 + rand() * spread
        G.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 40, life: .5 + rand() * .35, max: .85, r: 1.4 + rand() * 1.8, color, gravity: 240 })
      }
      if (G.particles.length > 90) G.particles.splice(0, G.particles.length - 90)
    }

    const float = (x: number, y: number, label: string, color: string) => {
      G.floats.push({ x, y, text: label, color, life: 1 })
      if (G.floats.length > 8) G.floats.shift()
    }

    const finish = () => {
      const seconds = Math.floor(G.t)
      let newBest = false
      try {
        const stored = window.localStorage.getItem(BEST_KEY)
        const prev = stored === null ? Number.NaN : Number.parseInt(stored, 10)
        if (!Number.isFinite(prev) || seconds > prev) {
          window.localStorage.setItem(BEST_KEY, String(seconds))
          newBest = true
        }
      } catch { /* keep the result without persistence */ }
      if (newBest) setBest(seconds)
      setResult({ time: seconds, dodged: G.dodged, evidence: G.evidence, newBest })
      modeRef.current = 'over'
      setMode('over')
    }

    const damage = () => {
      G.shields -= 1
      G.invuln = 1.5
      G.shake = 1
      G.flash = 1
      burst(duckX + duckR, playTop + G.y * playH, '#e2a79d', 14, 170)
      if (G.shields <= 0) finish()
    }

    const start = () => {
      if (modeRef.current === 'playing') return
      G.t = 0
      G.speed = 128
      G.shields = 3
      G.dodged = 0
      G.evidence = 0
      G.y = .5
      G.target = .5
      pointerY.current = .5
      G.tilt = 0
      G.invuln = 0
      G.shake = 0
      G.flash = 0
      G.spawnIn = 1.15
      G.evIn = 2.2
      G.wallIn = 10
      G.obstacles.length = 0
      G.evidenceList.length = 0
      G.particles.length = 0
      G.floats.length = 0
      setResult(null)
      modeRef.current = 'playing'
      setMode('playing')
    }
    startRef.current = start
    hitRef.current = () => { if (modeRef.current === 'playing' && G.invuln <= 0) damage() }

    const spawnObstacle = () => {
      const playing = modeRef.current === 'playing'
      if (playing && G.t > 10 && G.wallIn <= 0 && rand() < .32) {
        G.wallIn = 8 + rand() * 4
        const gapH = Math.max(.27, .37 - G.t * .0012)
        G.obstacles.push({ kind: 'wall', x: W + 12, gapY: .18 + rand() * .64, gapH, counted: false, seed: Math.floor(rand() * 1e9) })
        return
      }
      const risk = config.current.risks[Math.floor(rand() * config.current.risks.length)]!
      const label = locale === 'zh' ? risk.zh : risk.en
      let yFrac = .14 + rand() * .72
      for (let attempt = 0; attempt < 5; attempt++) {
        const clash = G.obstacles.some(o => o.kind === 'pill' && o.x > W * .42 && Math.abs(o.y - yFrac) < .2)
        if (!clash) break
        yFrac = .14 + rand() * .72
      }
      G.obstacles.push({ kind: 'pill', x: W + 12, y: yFrac, label, glyph: risk.glyph, w: measurePill(label), wK: k, counted: false, seed: Math.floor(rand() * 1e9) })
    }

    const candleSegments = (wall: Wall) => {
      const seeded = mulberry(wall.seed)
      const gapHalf = wall.gapH / 2
      const gapTop = playTop + (wall.gapY - gapHalf) * playH
      const gapBottom = playTop + (wall.gapY + gapHalf) * playH
      const bottom = playTop + playH
      const segs: Array<[number, number]> = []
      const heights: number[] = []
      for (let i = 0; i < 14; i++) heights.push(24 + seeded() * 20)
      let y = playTop
      let guard = 0
      while (y < bottom - 2 && segs.length < 9 && guard < 24) {
        guard += 1
        if (y >= gapTop && y < gapBottom) { y = gapBottom; continue }
        let end = Math.min(y + heights[segs.length % heights.length]! * Math.max(.7, k), bottom)
        if (end > gapTop && y < gapTop) end = gapTop
        if (end - y >= 9) segs.push([y, end])
        y = Math.max(end, y + 2)
      }
      return { segs, gapTop, gapBottom }
    }

    const circleRect = (cx: number, cy: number, r: number, left: number, top: number, right: number, bottom: number) => {
      const dx = Math.max(left - cx, 0, cx - right)
      const dy = Math.max(top - cy, 0, cy - bottom)
      return dx * dx + dy * dy < r * r
    }

    /** Attract mode: drift toward the widest safe corridor. */
    const autopilot = (dt: number) => {
      let lo = 0, hi = 1
      for (const o of G.obstacles) {
        if (o.x < duckX - 60 * k || o.x > duckX + W * .58) continue
        if (o.kind === 'wall') {
          const half = o.gapH / 2
          lo = Math.max(lo, o.gapY - half + .02)
          hi = Math.min(hi, o.gapY + half - .02)
        } else {
          const half = (30 * k) / playH / 2 + .05
          if (o.y > (lo + hi) / 2) hi = Math.min(hi, o.y - half)
          else lo = Math.max(lo, o.y + half)
        }
      }
      if (lo < hi) pointerY.current += ((lo + hi) / 2 - pointerY.current) * Math.min(1, dt * 2.4)
    }

    const update = (dt: number) => {
      const playing = modeRef.current === 'playing'
      G.worldX += G.speed * dt
      if (playing) {
        G.t += dt
        G.speed = (128 + Math.min(G.t * 3.1, 215)) * config.current.speedScale
        if (G.kbd.up) pointerY.current -= 340 * k * dt / playH
        if (G.kbd.down) pointerY.current += 340 * k * dt / playH
      } else {
        G.idleT += dt
        G.speed = 92
        autopilot(dt)
      }
      pointerY.current = Math.min(.97, Math.max(.03, pointerY.current))
      G.target = pointerY.current

      G.spawnIn -= dt
      if (G.spawnIn <= 0) {
        spawnObstacle()
        G.spawnIn = playing ? Math.max(.5, 1.32 - G.t * .011) : 1.6
      }
      G.evIn -= dt
      if (G.evIn <= 0) {
        G.evidenceList.push({ x: W + 10, y: .15 + rand() * .7, seed: Math.floor(rand() * 1e9), taken: false })
        G.evIn = playing ? 2.2 + rand() * 1.6 : 3 + rand() * 2
      }
      if (playing) G.wallIn -= dt

      const move = G.speed * dt
      for (const o of G.obstacles) o.x -= move
      for (const e of G.evidenceList) e.x -= move
      G.obstacles = G.obstacles.filter(o => o.x > -90)
      G.evidenceList = G.evidenceList.filter(e => !e.taken && e.x > -20)

      const duckY = playTop + G.y * playH
      G.y += (G.target - G.y) * Math.min(1, dt * 7)
      G.tilt += (Math.max(-.5, Math.min(.5, (G.target - G.y) * 6)) - G.tilt) * Math.min(1, dt * 9)

      if (playing) {
        G.invuln = Math.max(0, G.invuln - dt)
        for (const o of G.obstacles) {
          const width = o.kind === 'pill' ? o.w : Math.max(9, 13 * k)
          if (!o.counted && o.x + width < duckX - duckR) {
            o.counted = true
            G.dodged += 1
            float(duckX + duckR + 12, duckY - 16, '+1', '#a6e8d4')
          }
          if (G.invuln > 0) continue
          if (o.kind === 'pill') {
            const h = Math.max(24, Math.min(34, 30 * k))
            const cy = playTop + o.y * playH
            if (circleRect(duckX, duckY, duckR, o.x, cy - h / 2, o.x + o.w, cy + h / 2)) damage()
          } else {
            const bw = Math.max(9, 13 * k)
            for (const [top, bottom] of candleSegments(o).segs) {
              if (circleRect(duckX, duckY, duckR, o.x, top + 1, o.x + bw, bottom - 1)) { damage(); break }
            }
          }
        }
        for (const e of G.evidenceList) {
          const ey = playTop + e.y * playH
          const dx = e.x - duckX
          const dy = ey - duckY
          if (dx * dx + dy * dy < (duckR + 8 * k) ** 2) {
            e.taken = true
            G.evidence += 1
            burst(e.x, ey, '#a6e8d4', 10, 90)
            float(e.x, ey - 12, '+✦', '#bff0e0')
          }
        }
        G.bubbleIn -= dt
        if (G.bubbleIn <= 0) {
          G.bubbleIn = .12
          G.particles.push({ x: duckX - duckR - 2, y: duckY + 4, vx: -G.speed * .5, vy: -14 + rand() * 10, life: .5, max: .5, r: 1 + rand() * 1.4, color: '#f5e6b7', gravity: -6 })
        }
      }

      G.shake = Math.max(0, G.shake - dt * 3)
      G.flash = Math.max(0, G.flash - dt * 2.2)
      for (const p of G.particles) {
        p.life -= dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.vy += p.gravity * dt
      }
      G.particles = G.particles.filter(p => p.life > 0)
      for (const f of G.floats) {
        f.life -= dt / .95
        f.y -= 26 * dt
      }
      G.floats = G.floats.filter(f => f.life > 0)
    }

    const drawDuck = (x: number, y: number, bob: number) => {
      const alpha = G.invuln > 0 ? (Math.sin(performance.now() / 45) > 0 ? .35 : .95) : 1
      const s = duckH / 64
      ctx.save()
      ctx.translate(x, y + bob)
      ctx.rotate(G.tilt * .5)
      ctx.globalAlpha = alpha
      const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, duckH * .8)
      glow.addColorStop(0, 'rgba(245,204,88,.14)')
      glow.addColorStop(1, 'rgba(245,204,88,0)')
      ctx.fillStyle = glow
      ctx.fillRect(-duckH * .8, -duckH * .8, duckH * 1.6, duckH * 1.6)
      ctx.translate(-25 * s, -30 * s)
      ctx.scale(s, s)
      ctx.fillStyle = brand.yellow
      ctx.fill(BODY)
      ctx.fillStyle = '#ed9949'
      ctx.fill(BEAK)
      ctx.strokeStyle = '#b88726'
      ctx.lineWidth = 1.7 / s
      ctx.stroke(WING)
      ctx.strokeStyle = '#fff2bb'
      ctx.lineWidth = 2 / s
      ctx.globalAlpha = alpha * .6
      ctx.beginPath()
      ctx.moveTo(25, 13)
      ctx.quadraticCurveTo(28, 9, 36, 10)
      ctx.stroke()
      ctx.globalAlpha = alpha
      ctx.fillStyle = '#182125'
      ctx.beginPath()
      ctx.arc(36, 16, 2.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    const draw = () => {
      const playing = modeRef.current === 'playing'
      ctx.clearRect(0, 0, W, H)
      ctx.save()
      if (G.shake > 0) ctx.translate((Math.random() - .5) * 6 * G.shake, (Math.random() - .5) * 5 * G.shake)

      const spacing = 26 * k
      const offX = -(G.worldX * .06) % spacing
      ctx.fillStyle = '#b6c6cd'
      ctx.globalAlpha = .05
      for (let gx = offX; gx < W; gx += spacing) {
        for (let gy = playTop % spacing; gy < H; gy += spacing) ctx.fillRect(gx, gy, 1.3, 1.3)
      }
      ctx.globalAlpha = .1
      ctx.strokeStyle = '#9bb9b7'
      ctx.lineWidth = 1
      ctx.setLineDash([9, 25])
      ctx.lineDashOffset = -(G.worldX * .35) % 34
      for (const frac of [.28, .55, .82]) {
        const y = playTop + frac * playH + Math.sin(G.worldX * .004 + frac * 9) * 3
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.globalAlpha = 1

      for (const e of G.evidenceList) {
        const y = playTop + e.y * playH
        const pulse = .75 + Math.sin(G.idleT * 3 + G.t * 3 + e.seed % 10) * .25
        ctx.save()
        ctx.translate(e.x, y)
        ctx.rotate(Math.PI / 4 + Math.sin(G.t + e.seed) * .2)
        const r = Math.max(4.5, 6 * k)
        ctx.fillStyle = `rgba(134,205,183,${(.22 * pulse).toFixed(3)})`
        ctx.fillRect(-r * 1.7, -r * 1.7, r * 3.4, r * 3.4)
        ctx.fillStyle = '#86cdb7'
        ctx.fillRect(-r, -r, r * 2, r * 2)
        ctx.fillStyle = '#eafff7'
        ctx.fillRect(-r * .38, -r * .38, r * .76, r * .76)
        ctx.restore()
      }

      for (const o of G.obstacles) {
        if (o.kind === 'pill') {
          if (o.wK !== k) { o.w = measurePill(o.label); o.wK = k }
          const h = Math.max(24, Math.min(34, 30 * k))
          const y = playTop + o.y * playH + Math.sin(G.worldX * .006 + o.seed) * 2.5
          const icon = 15 * Math.max(.8, k)
          ctx.save()
          ctx.translate(o.x, y - h / 2)
          ctx.beginPath()
          ctx.roundRect(0, 0, o.w, h, 6)
          ctx.fillStyle = 'rgba(32,22,25,.94)'
          ctx.fill()
          ctx.strokeStyle = '#c6a29c59'
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.fillStyle = '#c6a29c12'
          ctx.beginPath()
          ctx.roundRect(7 * k, (h - icon) / 2, icon, icon, 3)
          ctx.fill()
          ctx.fillStyle = '#cba59e'
          ctx.font = monoFont(9 * k)
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(o.glyph, 7 * k + icon / 2, h / 2 + .5)
          ctx.fillStyle = '#d9bdb7'
          ctx.font = labelFont(10.5)
          ctx.textAlign = 'left'
          ctx.fillText(o.label, 7 * k + icon + 7 * k, h / 2 + .5)
          ctx.restore()
          ctx.textBaseline = 'alphabetic'
        } else {
          const bw = Math.max(9, 13 * k)
          for (const [top, bottom] of candleSegments(o).segs) {
            const seeded = mulberry(o.seed + Math.round(top))
            const bear = seeded() < .55
            ctx.strokeStyle = '#8a403b'
            ctx.lineWidth = 1.4
            ctx.beginPath()
            ctx.moveTo(o.x + bw / 2, top)
            ctx.lineTo(o.x + bw / 2, bottom)
            ctx.stroke()
            ctx.fillStyle = bear ? '#b9564f' : '#8a403b'
            ctx.beginPath()
            ctx.roundRect(o.x, top + 5 * k, bw, Math.max(6, bottom - top - 10 * k), 2)
            ctx.fill()
          }
        }
      }

      const duckY = playTop + G.y * playH
      const bob = Math.sin((playing ? G.t : G.idleT) * 2.3) * 2.6
      ctx.fillStyle = 'rgba(0,0,0,.22)'
      ctx.beginPath()
      ctx.ellipse(duckX + 2, duckY + duckH * .52, duckH * .42, duckH * .075, 0, 0, Math.PI * 2)
      ctx.fill()
      drawDuck(duckX, duckY, bob)

      for (const p of G.particles) {
        ctx.globalAlpha = Math.max(0, p.life / p.max) * .8
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      for (const f of G.floats) {
        ctx.globalAlpha = Math.max(0, f.life)
        ctx.fillStyle = f.color
        ctx.font = monoFont(10, '600')
        ctx.textAlign = 'left'
        ctx.fillText(f.text, f.x, f.y)
      }
      ctx.globalAlpha = 1

      if (playing || modeRef.current === 'over') {
        // HUD stays readable in fullscreen by scaling with the field width.
        const ui = Math.min(1.7, Math.max(1, k))
        for (let i = 0; i < 3; i++) {
          ctx.save()
          ctx.translate((13 + i * 17) * ui, 14 * ui)
          ctx.scale(ui, ui)
          ctx.beginPath()
          ctx.moveTo(0, -6)
          ctx.lineTo(5, -3)
          ctx.lineTo(5, 2.4)
          ctx.quadraticCurveTo(0, 7.4, -5, 2.4)
          ctx.lineTo(-5, -3)
          ctx.closePath()
          ctx.fillStyle = i < G.shields ? '#86cdb7' : '#31404a'
          ctx.fill()
          ctx.strokeStyle = i < G.shields ? '#bff0e0' : '#46565f'
          ctx.lineWidth = .8
          ctx.stroke()
          ctx.restore()
        }
        ctx.fillStyle = '#72858d'
        ctx.font = monoFont(7 * ui)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(text(locale, 'DISCIPLINE', '纪律'), (13 + 3 * 17 + 4) * ui, 17 * ui)
        ctx.textAlign = 'right'
        ctx.fillStyle = '#dfe8ec'
        ctx.font = monoFont(14 * ui, '600')
        ctx.fillText(`${Math.floor(G.t)}s`, W - 13 * ui, 23 * ui)
        ctx.fillStyle = '#7f95a0'
        ctx.font = monoFont(9 * ui)
        ctx.fillText(`↷ ${G.dodged}   ✦ ${G.evidence}`, W - 13 * ui, 37 * ui)
        ctx.textAlign = 'left'
      }

      if (G.flash > 0) {
        const v = ctx.createRadialGradient(W / 2, H / 2, H * .2, W / 2, H / 2, W * .72)
        v.addColorStop(0, 'rgba(198,91,83,0)')
        v.addColorStop(1, `rgba(198,91,83,${(.26 * G.flash).toFixed(3)})`)
        ctx.fillStyle = v
        ctx.fillRect(0, 0, W, H)
      }
      ctx.restore()
    }

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(.05, last === 0 ? .016 : (now - last) / 1000)
      last = now
      update(dt)
      draw()
    }

    const resize = () => {
      const rect = stage.getBoundingClientRect()
      W = rect.width
      H = rect.height
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(W * dpr))
      canvas.height = Math.max(1, Math.round(H * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      metrics()
      if (reduced) {
        G.idleT = 4
        draw()
      }
    }

    const sync = () => {
      const shouldRun = inView && visible && !reduced
      if (shouldRun && !raf) {
        last = 0
        raf = requestAnimationFrame(tick)
      } else if (!shouldRun && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    const ro = new ResizeObserver(resize)
    ro.observe(stage)
    const io = new IntersectionObserver(entries => {
      inView = entries[0]?.isIntersecting ?? true
      sync()
    }, { threshold: .15 })
    io.observe(stage)
    const onVisibility = () => {
      visible = !document.hidden
      sync()
    }
    document.addEventListener('visibilitychange', onVisibility)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') {
        if (modeRef.current === 'playing') event.preventDefault()
        G.kbd.up = true
      } else if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') {
        if (modeRef.current === 'playing') event.preventDefault()
        G.kbd.down = true
      } else if (event.key === ' ' && modeRef.current !== 'playing') {
        const target = event.target
        if (target instanceof HTMLElement && (target.tagName === 'BUTTON' || target.tagName === 'A')) return
        event.preventDefault()
        start()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') G.kbd.up = false
      if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') G.kbd.down = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    resize()
    sync()
    if (process.env.NODE_ENV !== 'production') {
      ;(window as unknown as Record<string, unknown>).__duckRun = { start, hit: () => hitRef.current() }
    }

    return () => {
      configCancelled = true
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      if (process.env.NODE_ENV !== 'production') {
        delete (window as unknown as Record<string, unknown>).__duckRun
      }
    }
  }, [locale])

  // Fullscreen: native element fullscreen when available; a fixed-viewport
  // overlay fallback keeps iPhone Safari (no element Fullscreen API) covered.
  const [fsNative, setFsNative] = useState(false)
  const [fsFallback, setFsFallback] = useState(false)
  const expanded = fsNative || fsFallback

  useEffect(() => {
    const onFsChange = () => setFsNative(document.fullscreenElement === stageRef.current)
    const onEscFallback = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFsFallback(false)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    window.addEventListener('keydown', onEscFallback)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      window.removeEventListener('keydown', onEscFallback)
    }
  }, [])

  useEffect(() => {
    document.body.style.overflow = fsFallback ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [fsFallback])

  const toggleExpand = useCallback(async () => {
    const stage = stageRef.current
    if (!stage) return
    if (document.fullscreenElement === stage) {
      await document.exitFullscreen().catch(() => {})
      return
    }
    if (fsFallback) { setFsFallback(false); return }
    if (typeof stage.requestFullscreen === 'function') {
      try {
        await stage.requestFullscreen()
        return
      } catch { /* fall through to the overlay fallback */ }
    }
    setFsFallback(true)
  }, [fsFallback])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (modeRef.current === 'idle') startRef.current()
    if (modeRef.current === 'playing') event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current
    if (!stage || modeRef.current !== 'playing') return
    const rect = stage.getBoundingClientRect()
    const frac = (event.clientY - rect.top - playTopRef.current) / playHRef.current
    pointerY.current = Math.min(.97, Math.max(.03, frac))
  }

  const announce = mode === 'over' && result
    ? text(locale, `Run complete: ${result.time} seconds, ${result.dodged} risks dodged, ${result.evidence} evidence collected.`, `本次航行 ${result.time} 秒，避开 ${result.dodged} 个风险，收集 ${result.evidence} 条证据。`)
    : ''

  return <section className={styles.scene} aria-label={text(locale, 'DuckStrat risk-run mini game', 'DuckStrat 风险漂流小游戏')} data-mode={mode}>
    <div className={styles.heading}><span className={styles.eyebrow}>{text(locale, 'RISK RUN', '风险漂流')}</span><span className={styles.sceneIndex}>{best === null ? text(locale, 'BEST —', '最佳 —') : `BEST ${best}s`}</span></div>
    <div ref={stageRef} className={`${styles.stage}${fsFallback ? ` ${styles.fsFallback}` : ''}`} data-mode={mode} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onContextMenu={event => { if (mode === 'playing') event.preventDefault() }}>
      <canvas ref={canvasRef} className={styles.canvas} role="img" aria-label={text(locale, 'Steerable duck dodging risk labels on a flowing market river', '小黄鸭在市场水流中躲避风险标签')} />
      <button type="button" className={styles.fsBtn} onClick={() => void toggleExpand()} aria-label={expanded ? text(locale, 'Exit fullscreen', '退出全屏') : text(locale, 'Play fullscreen', '全屏游玩')} aria-pressed={expanded}>{expanded ? '✕' : '⤢'}</button>
      <div className={styles.overlay} data-mode={mode}>
        {mode === 'over' && result ? <div className={styles.overCard}>
          <span className={styles.overKicker}>{text(locale, 'RUN COMPLETE', '本次航行')}</span>
          <p className={styles.overTitle}>{text(locale, 'A risk caught the duck.', '小黄鸭撞上了一个风险。')}</p>
          <strong className={styles.rank}>{rankFor(locale, result.time)}</strong>
          <p className={styles.stats}>{result.time}s · ↷ {result.dodged} {text(locale, 'dodged', '避开')} · ✦ {result.evidence} {text(locale, 'evidence', '证据')}</p>
          {result.newBest
            ? <span className={styles.newBest}>{text(locale, 'NEW BEST', '新纪录')}</span>
            : <span className={styles.newBest}>{text(locale, `BEST ${best ?? result.time}s`, `最佳 ${best ?? result.time} 秒`)}</span>}
          <div className={styles.overActions}>
            <button type="button" className={styles.primaryBtn} onClick={() => startRef.current()}>{text(locale, 'Run again', '再来一局')}</button>
            <a className={styles.ghostLink} href={`/${locale}/methodology`}>{text(locale, 'See the method', '了解研究方法')} ↗</a>
          </div>
        </div> : <>
          <p className={styles.tip}>{text(locale, 'Dodge the risks.', '避开风险，')}<em>{text(locale, 'gather evidence.', '收集证据。')}</em></p>
          <p className={styles.sub}>{text(locale, 'Three disciplines absorb three hits. How far can you sail?', '三层「纪律」可挡三次碰撞，看你能航行多远。')}</p>
          <button type="button" className={styles.primaryBtn} onClick={() => startRef.current()}>{text(locale, 'Start the run', '开始航行')}</button>
          <span className={styles.hint}>{text(locale, 'MOUSE · TOUCH ·', '鼠标 · 触摸 ·')} <span className={styles.key}>↑</span><span className={styles.key}>↓</span></span>
        </>}
      </div>
    </div>
    <p className={styles.meaning}><strong>Duck</strong> {text(locale, 'stays nimble around risk.', '灵活避开风险。')} <strong>Strat</strong> {text(locale, 'builds strategy on evidence.', '让策略建立在证据之上。')}</p>
    <p className={styles.srOnly} role="status">{announce}</p>
  </section>
}
