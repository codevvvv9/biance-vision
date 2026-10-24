import { contactConfig, publicOrigin } from '../lib/site'

const config = contactConfig()
const origin = new URL(publicOrigin())
const errors: string[] = []
if (origin.protocol !== 'https:' || ['localhost', '127.0.0.1', 'example.com'].includes(origin.hostname) || origin.hostname.endsWith('.example.com')) errors.push('Set WEBSITE_ORIGIN to the real HTTPS public domain.')
if (!config.email && !config.telegram) errors.push('Configure a real Telegram username or contact email.')
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else console.log('Release configuration is valid. Human contact and production origin still require deployment verification.')
