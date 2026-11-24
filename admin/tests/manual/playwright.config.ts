// Shoots the administrator guide's screenshots (manual-admin/README.md): `pnpm manual-admin:shoot`
// from the repository root. A generator, not a test suite: CI does not run it (vitest reads only
// tests/**/*.test.*), and its output is the committed manual-admin/images/*.png.
//
//   pnpm manual-admin:shoot                    # every scene (builds the admin first, ~30 s)
//   pnpm manual-admin:shoot -g admin-home      # one scene (by id)
//
// The admin console is the real production build (`next build` + `next start`); every /api/* call
// a page makes is answered in the browser by the fictional company of world.ts (shoot.spec.ts), so
// nothing reaches a server and no real data can show.
import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// The admin package is CommonJS: Playwright loads this file with __dirname.
const ADMIN = path.resolve(__dirname, '../..')
const PORT = 3110

export default defineConfig({
  testDir: '.',
  testMatch: 'shoot.spec.ts',
  fullyParallel: true,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 800 },
    // Sharp text on the high-density screens the guide is read on.
    deviceScaleFactor: 2,
    // Date fields draw their format from the browser's language, not the page's locale.
    launchOptions: { args: ['--lang=ja-JP'] },
  },
  webServer: {
    // API_PROXY_URL points at a closed port: the pages' /api/* calls are answered in the browser
    // (shoot.spec.ts) and one that slipped through would fail instead of reaching a real server.
    command: `pnpm exec next build && pnpm exec next start -H 127.0.0.1 -p ${PORT}`,
    cwd: ADMIN,
    env: { API_PROXY_URL: 'http://127.0.0.1:9', NEXT_TELEMETRY_DISABLED: '1' },
    url: `http://127.0.0.1:${PORT}/login`,
    timeout: 180_000,
    // MANUAL_ADMIN_REUSE=1: use a `next start` on that port you started yourself (rebuild after changes).
    reuseExistingServer: process.env.MANUAL_ADMIN_REUSE === '1',
  },
})
