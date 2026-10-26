'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import { domMin, LazyMotion, useInView, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react'
import * as m from 'motion/react-m'
import { brand, duck } from '@biance/brand/identity'
import { text, type Locale } from '@/lib/site'
import styles from './DuckHero.module.css'

const DURATION = 7000
const risks = [
  ['Market noise', '市场噪声', 'Read the context before reacting.', '先看上下文，再回应市场。'],
  ['Overconfidence', '过度自信', 'Challenge your view with counterevidence.', '用反对证据检验判断。'],
  ['Missing evidence', '证据不足', 'Waiting for confirmation is a valid conclusion.', '等待确认，也是有效结论。'],
] as const

/** Static final scene is also the SSR / no-JS / failed-enhancement fallback. */
export function DuckHero({ locale }: { locale: Locale }) {
  const id = useId()
  const root = useRef<HTMLElement>(null)
  const field = useRef<HTMLDivElement>(null)
  const progress = useMotionValue(1)
  const reduced = useReducedMotion()
  const inView = useInView(root, { amount: 0.2 })
  const [enhanced, setEnhanced] = useState(false)
  const [paused, setPaused] = useState(false)
  const [finished, setFinished] = useState(true)
  const [foreground, setForeground] = useState(true)
  const [phase, setPhase] = useState(2)
  const [activeRisk, setActiveRisk] = useState<number | null>(null)
  const initialized = useRef(false)
  const selected = useRef<number | null>(null)
  const currentPhase = useRef(2)
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const offsetX = useSpring(0, { stiffness: 190, damping: 22 })
  const offsetY = useSpring(0, { stiffness: 190, damping: 22 })
  const tilt = useSpring(0, { stiffness: 140, damping: 20 })
  const routeX = useTransform(progress, [0, .22, .42, .64, .83, 1], [90, 150, 220, 300, 360, 410])
  const routeY = useTransform(progress, [0, .22, .42, .64, .83, 1], [195, 118, 154, 225, 135, 140])
  const x = useTransform(() => routeX.get() + offsetX.get())
  const y = useTransform(() => routeY.get() + offsetY.get())
  const pathLength = useTransform(progress, [.12, .9], [0, 1])
  const playing = enhanced && !paused && !finished && !reduced && inView && foreground

  // Start only after the optional feature chunk has loaded. Failure leaves the SSR scene intact.
  const loadFeatures = useMemo(() => () => import('./duck-motion-features').then(module => {
    setEnhanced(true)
    return module.default
  }).catch(() => domMin), [])

  const resetOffset = useCallback(() => {
    selected.current = null
    setActiveRisk(null)
    offsetX.set(0); offsetY.set(0); tilt.set(0)
  }, [offsetX, offsetY, tilt])

  useEffect(() => {
    const visibility = () => setForeground(!document.hidden)
    visibility()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      if (returnTimer.current) clearTimeout(returnTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!enhanced) return
    if (reduced) {
      progress.set(1); currentPhase.current = 2; setPhase(2); setFinished(true)
    } else if (!initialized.current) {
      initialized.current = true
      progress.set(0); currentPhase.current = 0; setPhase(0); setFinished(false)
    }
  }, [enhanced, reduced, progress])

  useEffect(() => {
    if (!playing) return
    let frame = 0
    let previous: number | undefined
    const tick = (now: number) => {
      if (previous !== undefined) {
        const value = Math.min(1, progress.get() + Math.min(now - previous, 100) / DURATION)
        progress.set(value)
        const nextPhase = value < .28 ? 0 : value < .78 ? 1 : 2
        if (currentPhase.current !== nextPhase) { currentPhase.current = nextPhase; setPhase(nextPhase) }
        if (value === 1) { setFinished(true); return }
      }
      previous = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, progress])

  useEffect(() => {
    if (!inView || !foreground || paused || reduced) {
      offsetX.jump(0); offsetY.jump(0); tilt.jump(0)
    }
  }, [inView, foreground, paused, reduced, offsetX, offsetY, tilt])

  function evade(index: number) {
    if (selected.current === index) return
    selected.current = index
    setActiveRisk(index)
    if (reduced || paused || !foreground || !inView || !enhanced) return
    const shifts = [[-22, -16, -12], [18, 24, 10], [22, -22, -8]]
    const [dx, dy, angle] = shifts[index]
    offsetX.set(dx); offsetY.set(dy); tilt.set(angle)
  }

  function senseRisk(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch' || !field.current) return
    const labels = Array.from(field.current.querySelectorAll<HTMLButtonElement>('[data-risk]'))
    let nearest = -1, distance = 95
    labels.forEach((node, index) => {
      const box = node.getBoundingClientRect()
      const delta = Math.hypot(event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2)
      if (delta < distance) { distance = delta; nearest = index }
    })
    if (nearest >= 0) evade(nearest)
    else if (selected.current !== null) resetOffset()
  }

  const steps = [text(locale, 'Spot the risk', '识别风险'), text(locale, 'Challenge the view', '检验证据'), text(locale, 'Decide with context', '有据判断')]
  const playback = !enhanced || reduced ? 'static' : paused ? 'paused' : finished ? 'complete' : playing ? 'playing' : 'suspended'
  return <section ref={root} className={styles.scene} aria-label={text(locale, 'DuckStrat: from risk to research', 'DuckStrat：从识别风险到研究判断')} data-playback={playback} data-phase={phase} data-enhanced={enhanced}>
    <div className={styles.heading}><span className={styles.eyebrow}>THE DUCKSTRAT WAY</span><span className={styles.sceneIndex}>01 — 03</span></div>
    <div ref={field} className={styles.field} onPointerMove={senseRisk} onPointerLeave={resetOffset}>
      <LazyMotion features={loadFeatures} strict>
        <svg className={styles.map} viewBox="0 0 560 360" width="560" height="360" fill="none" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
          <title id={`${id}-title`}>{text(locale, 'A duck navigating risk toward evidence', '小黄鸭绕过风险，走向有依据的判断')}</title>
          <desc id={`${id}-desc`}>{text(locale, 'Market noise, overconfidence and missing evidence are examined before a conditional conclusion. Waiting is also a valid decision.', '识别市场噪声、过度自信与证据不足，再检查成立条件、反对证据与失效条件。等待也是有效判断。')}</desc>
          <defs><pattern id={`${id}-grid`} width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#b6c6cd" opacity=".12" /></pattern><radialGradient id={`${id}-glow`}><stop stopColor={brand.yellow} stopOpacity=".1" /><stop offset="1" stopColor={brand.yellow} stopOpacity="0" /></radialGradient></defs>
          <rect width="560" height="360" fill={`url(#${id}-grid)`} />
          <ellipse cx="355" cy="180" rx="185" ry="140" fill={`url(#${id}-glow)`} />
          <circle cx="280" cy="185" r="130" fill="none" stroke="#bfd7df" strokeOpacity=".06" />
          <path d="M65 210C120 65 180 95 220 154S300 285 345 180S400 125 430 176" fill="none" stroke="#9bb9b7" strokeOpacity=".14" strokeWidth="2" strokeDasharray="3 8" />
          <m.path d="M65 210C120 65 180 95 220 154S300 285 345 180S400 125 430 176" fill="none" stroke="#86cdb7" strokeWidth="2" style={{ pathLength }} />
          <m.g className={styles.mascot} style={{ x, y, rotate: tilt }}>
            <ellipse cx="-4" cy="53" rx="43" ry="7" fill="#000" opacity=".2" />
            <g transform="translate(-52 -53) scale(1.8)">
              <path d={duck.body} fill={brand.yellow} />
              <path d={duck.beak} fill="#ed9949" />
              <path d={duck.wing} stroke="#b88726" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M25 13C28 9 33 9 36 10" stroke="#fff2bb" strokeWidth="2" strokeLinecap="round" opacity=".6" />
              <circle cx="36" cy="16" r="2.2" fill="#182125" />
            </g>
          </m.g>
          <text x="30" y="334" fill="#72858d" fontSize="10" letterSpacing="2">RISK → EVIDENCE → STRATEGY</text>
        </svg>
      </LazyMotion>
      {risks.map(([en, zh], index) => <button key={en} type="button" data-risk={index} className={`${styles.risk} ${styles[`risk${index}`]}`} aria-pressed={activeRisk === index} aria-describedby={`${id}-feedback`} onFocus={() => evade(index)} onBlur={resetOffset} onClick={() => {
        evade(index)
        if (returnTimer.current) clearTimeout(returnTimer.current)
        returnTimer.current = setTimeout(resetOffset, 1400)
      }}><span aria-hidden="true">{['≈', '!', '?'][index]}</span>{text(locale, en, zh)}<span className={styles.riskArrow} aria-hidden="true">↗</span></button>)}
      <div className={styles.conclusion}><span className={styles.cardEyebrow}>{text(locale, 'A CONDITIONAL VIEW', '有条件的研究判断')}</span><strong>{text(locale, 'Evidence, before action.', '行动之前，先看依据。')}</strong><ul>{[[ 'Conditions', '成立条件' ],[ 'Counterevidence', '反对证据' ],[ 'Invalidation', '失效条件' ]].map(([en, zh]) => <li key={en}><span aria-hidden="true">✓</span>{text(locale, en, zh)}</li>)}</ul></div>
    </div>
    <div className={styles.caption}><p id={`${id}-feedback`} role="status">{activeRisk === null ? text(locale, 'A nimble duck. A considered strategy.', '灵活地避开陷阱，审慎地形成策略。') : text(locale, risks[activeRisk][2], risks[activeRisk][3])}</p><span>{text(locale, 'Hover or tap a risk to explore', '靠近或点击风险标签，看看它的反应')}</span></div>
    <div className={styles.bottom}><ol className={styles.steps}>{steps.map((step, index) => <li key={step} aria-current={phase === index ? 'step' : undefined}><span>0{index + 1}</span>{step}</li>)}</ol><div className={styles.controls}>
      <button type="button" disabled={!enhanced || !!reduced || finished} onClick={() => setPaused(value => !value)} aria-label={paused ? text(locale, 'Resume animation', '继续动画') : text(locale, 'Pause animation', '暂停动画')}>{paused ? '▷' : 'Ⅱ'}</button>
      <button type="button" disabled={!enhanced || !!reduced} onClick={() => { resetOffset(); progress.set(0); currentPhase.current = 0; setPhase(0); setFinished(false); setPaused(false) }} aria-label={text(locale, 'Replay animation', '重播动画')}>↺</button>
    </div></div>
    <p className={styles.meaning}><strong>Duck</strong> {text(locale, 'stays nimble around risk.', '灵活避开风险。')} <strong>Strat</strong> {text(locale, 'builds strategy on evidence.', '让策略建立在证据之上。')}</p>
  </section>
}
