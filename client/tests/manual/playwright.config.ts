// Shoots the user manual's screenshots (manual/README.md): `pnpm manual:shoot`
// from the repository root. Same preview pages and server as the renderer UI
// tests (../../playwright.config.ts), but a generator, not a test suite: CI
// does not run it, and its output is the committed manual/images/*.png.
//
//   pnpm manual:shoot                      # every scene
//   pnpm manual:shoot -g main-window        # one scene (by id)
import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import uiConfig from '../../playwright.config'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

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
    baseURL: uiConfig.use?.baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 800 },
    // Sharp text on the high-density screens the manual is read on.
    deviceScaleFactor: 2,
  },
  // The UI tests' build-and-preview command, run from client/.
  webServer: { ...(uiConfig.webServer as NonNullable<typeof uiConfig.webServer> & object), cwd: CLIENT },
})
