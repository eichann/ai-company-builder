// Settings → 「ブラウザ操作」 (tests/download-folders-ui.tsx; agent-browser.md "The app's window"):
// the item exists only while the member has a site, says the AI does not operate the window yet and
// that the login is not kept, and says when 「ログインを消す」 failed. Which sites and when are main's
// (tests/browser-window.test.ts).
import { test, expect } from '@playwright/test'
import { openPreview } from './helpers'

const nav = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: '設定の項目' })

test('without a site the settings have no 「ブラウザ操作」', async ({ page }) => {
  const { errors } = await openPreview(page, 'download-folders', { tab: 'mine' })
  await expect(nav(page).getByRole('button', { name: 'Slack' })).toBeVisible()
  await expect(nav(page).getByRole('button', { name: 'ブラウザ操作' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a site the company allowed: open it; the notes say the AI does not use it and the login is not kept', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'mine', browser: '1' })
  await nav(page).getByRole('button', { name: 'ブラウザ操作' }).click()
  await expect(page.getByText('manager.example.net')).toBeVisible()
  await expect(page.getByText(/AI はまだこの窓を操作しません。/)).toBeVisible()
  await expect(page.getByText(/アプリを開き直すと、もう一度ログインが必要です。/)).toBeVisible()
  await page.getByRole('button', { name: '開いてログイン' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { browserOpened?: string[] }).browserOpened)).toEqual(['manager.example.net'])
  await page.getByRole('button', { name: 'ログインを消す' }).click()
  await expect(page.getByRole('status')).toHaveText('このサイトのログインを消しました。')
})

test('「ログインを消す」 that could not clear says so (never 「消しました」)', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'browser', browser: 'clearFails' })
  await page.getByRole('button', { name: 'ログインを消す' }).click()
  await expect(page.getByRole('status')).toHaveText('ログインを消せませんでした。もう一度お試しください。')
})
