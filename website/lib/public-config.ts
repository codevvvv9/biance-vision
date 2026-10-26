import { promises as fs } from 'node:fs'
import path from 'node:path'
import { contactConfig } from './site'
import { HERO_GAME_VERSION, defaultHeroGame, validateHeroGame } from './hero-game'

export interface PublicContacts { version: 1; revision: number; telegram: string; email: string; updatedAt: number }
/** Snapshot published by the admin panel; mirrors the contacts shape. */
export interface PublicHeroGame { version: 1; revision: number; risks: ReturnType<typeof defaultHeroGame>['risks']; speedScale: number; updatedAt: number }
let lastGood: PublicContacts | null = null
let lastGoodGame: PublicHeroGame | null = null
/** This directory contains only public data; never mount the backend's parent data directory. */
export async function readPublicContacts(): Promise<PublicContacts> {
  const file = path.join(process.env.WEBSITE_PUBLIC_CONFIG_DIR || path.resolve(process.cwd(), '../server/data/website-public'), 'contact.json')
  try {
    if ((await fs.stat(file)).size > 4096) throw new Error('oversized')
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as PublicContacts
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.telegram !== 'string' || (value.telegram !== '' && !/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value.telegram)) ||
      typeof value.email !== 'string' || value.email.length > 254 || (value.email !== '' && !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(value.email)) ||
      (!value.email && !value.telegram) || !Number.isSafeInteger(value.updatedAt)) throw new Error('invalid')
    lastGood = { version: 1, revision: value.revision, telegram: value.telegram, email: value.email, updatedAt: value.updatedAt }
  } catch { /* Keep the last good public snapshot; backend failure does not block the website. */ }
  return lastGood || { version: 1, revision: 0, updatedAt: 0, ...contactConfig() }
}

export async function readPublicHeroGame(): Promise<PublicHeroGame> {
  const file = path.join(process.env.WEBSITE_PUBLIC_CONFIG_DIR || path.resolve(process.cwd(), '../server/data/website-public'), 'hero-game.json')
  try {
    if ((await fs.stat(file)).size > 8192) throw new Error('oversized')
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    const parsed = validateHeroGame(value)
    const { revision, updatedAt } = value
    if (value.version !== HERO_GAME_VERSION || !parsed || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt)) throw new Error('invalid')
    lastGoodGame = { version: HERO_GAME_VERSION, revision, ...parsed, updatedAt }
  } catch { /* Keep the last good snapshot; the game also falls back to built-in defaults. */ }
  if (lastGoodGame) return lastGoodGame
  return { version: HERO_GAME_VERSION, revision: 0, ...defaultHeroGame(), updatedAt: 0 }
}
