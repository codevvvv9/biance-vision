import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
const chrome = process.env.CHROME_PATH || (!process.env.CI && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)
export default defineConfig({
  testDir: './tests/admin', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:17846', viewport: { width: 1440, height: 1000 }, launchOptions: { executablePath: chrome }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm exec vite preview --config vite.admin.config.ts --host 127.0.0.1 --port 17846', port: 17846, env: { BV_ADMIN_WEB_PORT: '17846' }, reuseExistingServer: false },
  reporter: 'list',
})
