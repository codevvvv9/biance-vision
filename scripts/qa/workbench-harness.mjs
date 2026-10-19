/** Optional browser QA: use an installed Playwright module, without adding a production dependency. */
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
export const baseUrl = (process.env.WORKBENCH_URL || 'http://127.0.0.1:17834').replace(/\/$/, '')
export const outputDir = process.env.WORKBENCH_QA_OUTPUT || path.join(tmpdir(), 'bv-workbench-qa')
mkdirSync(outputDir, { recursive: true })
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const launchOptions = { headless: true, executablePath: process.env.CHROME_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined) }
