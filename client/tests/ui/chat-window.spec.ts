// A consultation's own window (「別ウィンドウで開く」): the chat-only shell
// (src/app/ChatWindowApp.tsx) shows the one consultation main assigned and
// reports its status for the main window's list. The main window's side:
// chat-panel.spec.ts 「a consultation in its own window」.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Reported = { state: string; kind?: string; line: string }
const reported = (page: Page) =>
  page.evaluate(() => (window as unknown as { __acbWindow: { reported: Reported[] } }).__acbWindow.reported.map(r => r.state))

test('shows only that consultation\'s chat, titled after it, and tells the main window when its AI works', async ({ page }) => {
  const state = await openPreview(page, 'chat-window')
  await expect(page.getByText('見積書のたたき台を作りました。')).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveTitle('見積書の相談')
  // Only the chat: no conversation list, no new consultation, no moving it again.
  await expect(page.getByRole('complementary', { name: 'AIへの相談' })).toHaveCount(0)
  const header = page.getByRole('banner')
  await expect(header.getByRole('button', { name: 'AIへの相談の一覧を開閉' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: '別ウィンドウで開く' })).toHaveCount(0)
  await expect.poll(() => reported(page)).toContain('idle')

  await page.locator('.cm-content[role="textbox"]').click()
  await page.keyboard.insertText('続けて')
  await page.keyboard.press('Meta+Enter')
  await expect(page.getByText('確認します。')).toBeVisible()
  await expect.poll(() => reported(page)).toContain('working')
  expectNoPageErrors(state)
})

test('a window main gave no consultation says so instead of showing an empty chat', async ({ page }) => {
  await openPreview(page, 'chat-window', { context: 'none' })
  await expect(page.getByRole('alert')).toHaveText('この画面に表示する相談がありません。ウィンドウを閉じてください。')
})

test('a review request\'s file links open in the main window\'s editor; a file main refuses says why', async ({ page }) => {
  const state = await openPreview(page, 'chat-window', { review: '1' })
  const card = page.getByRole('group', { name: '確認をお願いします' })
  await expect(card).toContainText('見積書のたたき台', { timeout: 15_000 })
  const opened = () => page.evaluate(() => (window as unknown as { __acbWindow: { openedInMain: string[] } }).__acbWindow.openedInMain)
  // A link, as in the main window (this window's file.open hands it to main).
  await card.getByRole('button', { name: '営業部/見積/たたき台.md' }).click()
  await expect.poll(opened).toEqual(['/tmp/acb-preview/営業部/見積/たたき台.md'])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await card.getByRole('button', { name: '営業部/見積/古い版.md' }).click()
  await expect(page.getByRole('alert')).toContainText('このファイルが見つからないため、開けませんでした。')
  await page.getByRole('alert').getByRole('button', { name: '閉じる' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expectNoPageErrors(state)
})
