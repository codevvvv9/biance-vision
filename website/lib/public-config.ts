import { promises as fs } from 'node:fs'
import path from 'node:path'
import { contactConfig } from './site'

export interface PublicContacts { version: 1; revision: number; telegram: string; email: string; updatedAt: number }
let lastGood: PublicContacts | null = null
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
