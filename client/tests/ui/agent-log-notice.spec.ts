// The member is told that the AI action log goes to the administrators
// (monitoring M1, owner decision): once over the chat (per account on this
// PC), and always in the settings screen. What is sent is pinned in
// tests/agent-event-sender.test.ts.
import { test, expect } from '@playwright/test'
import { openPreview, expectNoPageErrors } from './helpers'

const SENTENCE = 'AI の操作の記録（いつ・どの道具を・どこに使ったか。会話やファイルの中身は含みません）が、会社の管理者に送られます。'

test('the chat shows the notice once: focused OK, remembered per account, the chat stays usable', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { notice: '1' })
  const notice = page.getByRole('dialog', { name: 'AI の操作の記録について' })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(SENTENCE)
  await expect(notice).toContainText('詳しくは管理者にお問い合わせください。')
  const ok = notice.getByRole('button', { name: 'OK' })
  await expect(ok).toBeFocused()
  // Non-modal: the conversation behind it is still there.
  await expect(page.getByRole('banner')).toBeVisible()
  await ok.click()
  await expect(notice).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('acb.agentLogNoticeSeen:preview-user'))).not.toBeNull()
  expectNoPageErrors(state)
})

test('Esc dismisses the notice as well', async ({ page }) => {
  await openPreview(page, 'chat-header', { notice: '1' })
  const notice = page.getByRole('dialog', { name: 'AI の操作の記録について' })
  await expect(notice.getByRole('button', { name: 'OK' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(notice).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('acb.agentLogNoticeSeen:preview-user'))).not.toBeNull()
})

test('an account that has seen it gets no notice', async ({ page }) => {
  await openPreview(page, 'chat-header')
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'AI の操作の記録について' })).toHaveCount(0)
})

test('the settings screen always says it, whichever section is open', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { view: 'settings' })
  const nav = page.getByRole('navigation', { name: '設定の項目' })
  await expect(nav.getByText(SENTENCE)).toBeVisible()
  await nav.getByRole('button', { name: '入力候補' }).click()
  await expect(nav.getByText(SENTENCE)).toBeVisible()
  expectNoPageErrors(state)
})
