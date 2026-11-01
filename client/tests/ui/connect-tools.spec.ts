// 「仕事の道具をつなぐ」 (tests/connect-tools-ui.tsx): the screen opens by itself only when
// something is new, 「あとで」 tells the server for each service and closes it, 「Google でつなぐ」
// asks for everything at once, and what the member unticked on Google's page is said plainly
// with nothing reopened by itself. Which state opens it is pinned by connectTools.test.ts.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __connectToolsCalls: string[] }).__connectToolsCalls)

test('a new member: Google and Slack with what each does; 「あとで」 marks both shown and closes', async ({ page }) => {
  const state = await openPreview(page, 'connect-tools', { state: 'first' })
  const dialog = page.getByRole('dialog', { name: '仕事の道具をつなぐ' })
  await expect(dialog).toContainText('予定が一覧に出て、会議の議事録を AI が読めます')
  await expect(dialog).toContainText('届いたメールから、やることを作れます')
  await expect(dialog).toContainText('大事な知らせが Slack の DM で届きます')
  await expect(dialog.getByRole('button', { name: 'Google でつなぐ' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Slack でつなぐ' })).toBeVisible()
  for (const word of ['OAuth', 'スコープ', 'トークン']) await expect(dialog).not.toContainText(word)
  await dialog.getByRole('button', { name: 'あとで' }).click()
  await expect(dialog).toHaveCount(0)
  expect((await calls(page)).sort()).toEqual(['markGoogleSeen', 'markSlackSeen'])
  expectNoPageErrors(state)
})

test('「Google でつなぐ」 asks once for all; what was unticked on Google\'s page is said, nothing reopens', async ({ page }) => {
  const state = await openPreview(page, 'connect-tools', { state: 'first' })
  const dialog = page.getByRole('dialog', { name: '仕事の道具をつなぐ' })
  await dialog.getByRole('button', { name: 'Google でつなぐ' }).click()
  await expect(dialog.getByRole('status')).toContainText('ブラウザで Google の画面を開きました')
  await expect(dialog.getByRole('status')).toContainText('許可されなかったため使えません', { timeout: 10_000 })
  await expect(dialog.getByRole('status')).toContainText('メールを、あなたが確かめてから送れる')
  expect(await calls(page)).toEqual(['connectGoogleAll'])
  // Still open (the member reads the result), offering Google again only as a button they press.
  await expect(dialog.getByRole('button', { name: 'Google でつなぐ' })).toBeVisible()
  await dialog.getByRole('button', { name: '閉じる' }).click()
  await expect(dialog).toHaveCount(0)
  expectNoPageErrors(state)
})

test('only what the company added since: 「新しくつなぐもの」 with that one; nothing new → no screen', async ({ page }) => {
  const state = await openPreview(page, 'connect-tools', { state: 'new' })
  const dialog = page.getByRole('dialog', { name: '新しくつなぐもの' })
  await expect(dialog).toContainText('届いたメールから、やることを作れます')
  await expect(dialog).not.toContainText('議事録')
  await expect(dialog.getByRole('button', { name: 'Slack でつなぐ' })).toHaveCount(0)
  await openPreview(page, 'connect-tools', { state: 'seen' })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a company without Slack shows no Slack button', async ({ page }) => {
  const state = await openPreview(page, 'connect-tools', { state: 'noslack' })
  const dialog = page.getByRole('dialog', { name: '仕事の道具をつなぐ' })
  await expect(dialog.getByRole('button', { name: 'Google でつなぐ' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Slack でつなぐ' })).toHaveCount(0)
  await expect(dialog.getByText('Slack', { exact: true })).toHaveCount(0)
  expectNoPageErrors(state)
})
