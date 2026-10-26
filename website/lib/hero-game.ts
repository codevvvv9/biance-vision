/**
 * Shared shape for the admin-configurable hero game (Risk Run).
 * Pure module: no fs, no client APIs — imported by the public-config
 * reader (server side) and by the game component (client fallback).
 */

export interface HeroGameRisk { zh: string; en: string; glyph: string }
export interface HeroGameConfig { risks: HeroGameRisk[]; speedScale: number }

export const HERO_GAME_VERSION = 1
export const HERO_GAME_RISK_MIN = 3
export const HERO_GAME_RISK_MAX = 10
export const HERO_GAME_SPEED_MIN = 0.5
export const HERO_GAME_SPEED_MAX = 2

/** Built-in defaults keep the game playable with no config file at all. */
export function defaultHeroGame(): HeroGameConfig {
  return {
    risks: [
      { zh: '杠杆', en: 'LEVERAGE', glyph: '↯' },
      { zh: '追高', en: 'CHASING', glyph: '▲' },
      { zh: 'FOMO', en: 'FOMO', glyph: '!' },
      { zh: '重仓', en: 'OVERSIZE', glyph: '▤' },
      { zh: '噪声', en: 'NOISE', glyph: '≈' },
      { zh: '假突破', en: 'FAKEOUT', glyph: '✕' },
    ],
    speedScale: 1,
  }
}

const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Strict validation for the persisted snapshot; lenient fields are clamped. */
export function validateHeroGame(value: unknown): HeroGameConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const risksIn = raw.risks
  if (!Array.isArray(risksIn) || risksIn.length < HERO_GAME_RISK_MIN || risksIn.length > HERO_GAME_RISK_MAX) return null
  const risks: HeroGameRisk[] = []
  for (const item of risksIn) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const risk = item as Record<string, unknown>
    if (!isFilled(risk.zh) || risk.zh.trim().length > 8) return null
    if (!isFilled(risk.en) || risk.en.trim().length > 16) return null
    if (!isFilled(risk.glyph) || risk.glyph.trim().length > 3) return null
    risks.push({ zh: risk.zh.trim(), en: risk.en.trim().toUpperCase(), glyph: risk.glyph.trim() })
  }
  const speed = typeof raw.speedScale === 'number' && Number.isFinite(raw.speedScale)
    ? raw.speedScale
    : Number.NaN
  if (Number.isNaN(speed)) return null
  return { risks, speedScale: Math.min(HERO_GAME_SPEED_MAX, Math.max(HERO_GAME_SPEED_MIN, speed)) }
}
