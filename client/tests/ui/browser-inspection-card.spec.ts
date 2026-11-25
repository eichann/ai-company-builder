// 「ブラウザ操作」's inspection card (tests/browser-inspection-card-ui.html; agent-browser.md "The inspection in the chat").
// Guards: each check shows its own mark — ✓ only for ok, ✗ with the fields that made it, 「読み取れませんでした」 for what
// could not be read (never ✓) —; a value not read reads 「読み取れませんでした」, never a stand-in; the site's notes always
// show; the card has nothing to press (an inspection only reads); after a restart or in another window it says so plainly.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SCREENSHOTS = process.env.SCREENSHOTS
const q = (o: Record<string, string> = {}) => (process.env.THEME ? { ...o, theme: process.env.THEME } : o)
const cardOf = (page: import('@playwright/test').Page) => page.getByRole('group', { name: '流入経路を点検する' })

test('all ✓: every check marked ✓, the values the site showed, the shared-action note; nothing to press', async ({ page }) => {
  const state = await openPreview(page, 'browser-inspection-card', q())
  const card = cardOf(page)
  await expect(card).toContainText('点検した項目は、すべて確かめられました。')
  await expect(card).toContainText('サイトから読み取った情報（AI には見せていません）')
  await expect(card).toContainText('見本セミナー 第2回の申し込み')
  await expect(card).toContainText('https://example.invalid/follow/preview-2')
  const checks = card.locator('li[data-mark]')
  await expect(checks).toHaveCount(5)
  await expect(card.locator('li[data-mark="ok"]')).toHaveCount(5)
  for (const li of await checks.all()) await expect(li).toContainText('✓')
  await expect(card).toContainText('アクションは、ほかの流入経路と共有されていることがあります。')
  await expect(card.getByRole('button')).toHaveCount(0)
  if (SCREENSHOTS) await card.screenshot({ path: `${SCREENSHOTS}/inspection-all-ok.png` })
  expectNoPageErrors(state)
})

test('a ✗: that check alone is ✗ with the field that made it; the others stay ✓', async ({ page }) => {
  const state = await openPreview(page, 'browser-inspection-card', q({ state: 'ng' }))
  const card = cardOf(page)
  await expect(card).toContainText('確かめで違いが見つかりました')
  const ng = card.locator('li[data-mark="ng"]')
  await expect(ng).toHaveCount(1)
  await expect(ng).toContainText('✗')
  await expect(ng).toContainText('つけるタグ')
  await expect(ng).not.toContainText('✓')
  await expect(card.locator('li[data-mark="ok"]')).toHaveCount(4)
  expectNoPageErrors(state)
})

test('not read: the row and the check say 「読み取れませんでした」, never ✓ or a stand-in value', async ({ page }) => {
  const state = await openPreview(page, 'browser-inspection-card', q({ state: 'not_read' }))
  const card = cardOf(page)
  await expect(card).toContainText('読み取れなかったものがあります。')
  await expect(card.locator('[data-value="unreadable"]')).toHaveCount(2)
  for (const v of await card.locator('[data-value="unreadable"]').all()) await expect(v).toHaveText('読み取れませんでした')
  const unread = card.locator('li[data-mark="unreadable"]')
  await expect(unread).toHaveCount(1)
  await expect(unread).toContainText('読み取れませんでした')
  await expect(unread).not.toContainText('✓')
  await expect(card).not.toContainText('preview-2')
  expectNoPageErrors(state)
})

test('after a restart or in another window: one plain sentence, no value', async ({ page }) => {
  for (const [s, text] of [['gone', 'このアプリを開き直したので消えました'], ['other-window', 'メインの窓の相談で開いてください']] as const) {
    const state = await openPreview(page, 'browser-inspection-card', q({ state: s }))
    const card = page.getByRole('group', { name: '点検のカード' })
    await expect(card).toContainText(text)
    await expect(card).not.toContainText('見本セミナー')
    expectNoPageErrors(state)
  }
})

test('a write run\'s card: the plan shows the key values read and ［任せる］／［やめる］; after ［任せる］ it moves on by itself to the after-read card with who checked each item', async ({ page }) => {
  const state = await openPreview(page, 'browser-inspection-card', q({ frame: '1' }))
  const card = page.getByRole('group', { name: 'ブラウザ操作：AI に任せる書く作業' })
  await expect(card).toContainText('下見で読んだ大事な値（AI には見せていません）')
  await expect(card).toContainText('秋のクーポン（番号 3001）')
  await expect(card.getByRole('button', { name: 'やめる' })).toBeVisible()
  await card.getByRole('button', { name: '任せる' }).click()
  // Nothing else is pressed: the card reads main again until the run settled.
  const after = page.getByRole('group', { name: 'AI がサイトで書いたこと' })
  await expect(after).toBeVisible({ timeout: 10_000 })
  await expect(after.locator('[data-checked-by="machine"]')).toContainText('機械で確かめた')
  await expect(after.locator('[data-checked-by="ai"]')).toContainText('AI が確かめた')
  await expect(after.locator('[data-checked-by="none"]')).toContainText('確かめていない')
  await expect(after).toContainText('「前の回」と違う項目があります。意図した変更か確かめてください。')
  await expect(after.locator('[data-checked-by="ai"]')).toContainText('秋のクーポン')
  await expect(card.getByRole('button', { name: '任せる' })).toHaveCount(0)
  expectNoPageErrors(state)
})
