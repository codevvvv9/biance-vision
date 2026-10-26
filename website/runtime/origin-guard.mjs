import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { brand } from '../../packages/brand/identity.js'
import { assertBuildIdentity } from './build-identity.mjs'

const embedded = new URL('./build-identity.json', import.meta.url)
const path = existsSync(embedded) ? embedded : new URL('../.next/build-identity.json', import.meta.url)
const built = JSON.parse(await readFile(path, 'utf8'))
const value = new URL(process.env.WEBSITE_ORIGIN || 'http://localhost:3100')
if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.pathname !== '/' || value.search || value.hash) throw new Error('Invalid runtime WEBSITE_ORIGIN')
assertBuildIdentity(built, { origin: value.origin, brand: brand.name })
