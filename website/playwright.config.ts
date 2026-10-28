import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// Self-hosted dev server so the suite runs green from a cold checkout (CI):
// with WEBSITE_TEST_URL set, tests target that already-running origin instead
// (local habit: the retired brand server occupies 3100 — point at another port).
const webServer = process.env.WEBSITE_TEST_URL
  ? undefined
  : {
      // production server: byte-stable HTML (geo.spec compares bot vs user
      // responses) and the relative /login? href the article assertions expect
      command: 'npx next build && npx next start --hostname 127.0.0.1 --port 3100',
      url: 'http://127.0.0.1:3100/en',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    }

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
  ...(webServer ? { webServer } : {}),
  reporter: 'list',
})
