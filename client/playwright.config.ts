// Playwright UI tests for the renderer (tests/ui/*.spec.ts): each test opens a
// preview page (tests/*-ui.html: real components, preload API and chat server
// mocked) in Chromium and asserts what the member sees and can do. The pages
// are built once with the renderer-only Vite config and served by
// `vite preview`, which Playwright starts and stops itself.
//
//   npx playwright test                 # build, serve, run everything
//   npx playwright test chat-composer   # one spec file
//
// See CLAUDE.md "Renderer UI tests".
import { defineConfig, devices } from '@playwright/test'

const PORT = 4179

export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A UI flake is a bug to fix, not to retry away — but one retry in CI keeps
  // a loaded runner from failing a PR on a single slow frame, and the report
  // still marks the test as flaky.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.UI_TEST_WORKERS ? Number(process.env.UI_TEST_WORKERS) : 2,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: 'npx vite build -c tests/ui/vite.config.ts --logLevel warn && npx vite preview -c tests/ui/vite.config.ts',
    url: `http://127.0.0.1:${PORT}/tests/chat-composer-ui.html`,
    // UI_TEST_REUSE=1: use a `vite preview` you started yourself (rebuild it after changes).
    reuseExistingServer: process.env.UI_TEST_REUSE === '1',
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
