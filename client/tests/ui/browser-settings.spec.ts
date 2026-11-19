// Settings → 「ブラウザ操作」 (tests/download-folders-ui.tsx; agent-browser.md "The app's window"):
// the item exists only while the member has a site, says the AI does not operate the window yet,
// and says when the login is not kept. Which sites and when are main's (tests/browser-window.test.ts).
import { test, expect } from '@playwright/test'
import { openPreview } from './helpers'

const nav = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: '設定の項目' })

test('without a site the settings have no 「ブラウザ操作」', async ({ page }) => {
  const { errors } = await openPreview(page, 'download-folders', { tab: 'mine' })
  await expect(nav(page).getByRole('button', { name: 'Slack' })).toBeVisible()
  await expect(nav(page).getByRole('button', { name: 'ブラウザ操作' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a site the company allowed: open it, and the notes say the AI does not use it yet', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'mine', browser: 'memory' })
  await nav(page).getByRole('button', { name: 'ブラウザ操作' }).click()
  await expect(page.getByText('manager.example.net')).toBeVisible()
  await expect(page.getByText(/AI はまだこの窓を操作しません。/)).toBeVisible()
  await expect(page.getByText(/アプリを開き直すと、もう一度ログインが必要です。/)).toBeVisible()
  await page.getByRole('button', { name: '開いてログイン' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { browserOpened?: string[] }).browserOpened)).toEqual(['manager.example.net'])
  await page.getByRole('button', { name: 'ログインを消す' }).click()
  await expect(page.getByRole('status')).toHaveText('このサイトのログインを消しました。')
})

test('a login kept on disk does not say it will be asked again', async ({ page }) => {
  await openPreview(page, 'download-folders', { tab: 'browser', browser: 'kept' })
  await expect(page.getByText(/AI はまだこの窓を操作しません。/)).toBeVisible()
  await expect(page.getByText(/もう一度ログインが必要です/)).toHaveCount(0)
})
