import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.WEBSITE_TEST_URL || 'http://127.0.0.1:3100',
    launchOptions: { executablePath: process.env.CHROME_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), args: ['--disable-gpu'] },
    screenshot: 'only-on-failure',
  },
  reporter: 'list',
})
