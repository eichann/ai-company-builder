// 設定 → 自分の設定 (言葉の決まり 5c, src/features/settings/components/MySwitchesSection.tsx) on
// tests/download-folders-ui.html?tab=mine. Guards: the two switches show the member's own state
// and a change goes to the server for that switch only; one the company stops is greyed out,
// says 「会社の設定で止まっています」 and cannot be turned on; the settings open on 自分の設定.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('the two switches: the member\'s own state, a change sent for that switch only', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { tab: 'mine' })
  const read = page.getByRole('switch', { name: '受信を読む' })
  const auto = page.getByRole('switch', { name: 'AI が自動で進める' })
  await expect(read).toHaveAttribute('aria-checked', 'false')
  await expect(auto).toHaveAttribute('aria-checked', 'true')
  await read.click()
  await expect(read).toHaveAttribute('aria-checked', 'true')
  await auto.click()
  await expect(auto).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => (window as unknown as { __switchesSet: string[] }).__switchesSet)).toEqual(['readIncoming:true', 'autoRun:false'])
  await expect(page.getByText('会社の設定で止まっています')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a switch the company stops is greyed out with the reason and cannot be turned on', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { tab: 'mine', company: 'off' })
  const read = page.getByRole('switch', { name: '受信を読む' })
  await expect(read).toBeDisabled()
  await expect(read).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('[data-my-switch="readIncoming"]')).toContainText('会社の設定で止まっています')
  await expect(page.getByRole('switch', { name: 'AI が自動で進める' })).toBeEnabled()
  expectNoPageErrors(state)
})
