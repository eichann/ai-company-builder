// Settings never drop what the member typed without a word (UX review 2026-11-28; tests/download-folders-ui.tsx):
// an unsaved key / .env / download choice is marked 「まだ保存していません」, and closing (×, Esc) asks
// ［戻る］［保存しないで閉じる］［保存して閉じる］ — naming what is unsaved, never its value. Leaving a section
// whose own input would be dropped asks the same (移る); the panel's own .env drafts survive a section change, so
// moving away from them asks nothing. Nothing unsaved: closing asks nothing.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SECRET = 'sk-test-never-shown-1234'
const open = async (page: Page, tab: string) => {
  const state = await openPreview(page, 'download-folders', { closed: '1', tab })
  await page.getByRole('button', { name: '設定を開く' }).click()
  return { state, settings: page.getByRole('dialog', { name: '設定' }) }
}
const ask = (page: Page) => page.getByRole('dialog', { name: 'まだ保存していない変更があります' })
const envUpdates = (page: Page) => page.evaluate(() => (window as unknown as { __acbEnvUpdates?: unknown[] }).__acbEnvUpdates ?? [])

test('a typed API key: marked unsaved, closing asks without showing it; 戻る keeps it, 保存しないで閉じる drops it', async ({ page }) => {
  const { state, settings } = await open(page, 'apikeys')
  await settings.getByLabel('OpenAI', { exact: true }).fill(SECRET)
  await expect(settings.getByText('まだ保存していません。保存すると反映されます。')).toBeVisible()
  await expect(settings.getByRole('button', { name: /APIキー（このPC）.*未保存/ })).toBeVisible()

  await settings.getByRole('button', { name: '閉じる' }).click()
  await expect(ask(page)).toContainText('APIキー・環境変数（.env）の入力')
  await expect(ask(page)).not.toContainText(SECRET)
  await ask(page).getByRole('button', { name: '戻る' }).click()
  await expect(ask(page)).toHaveCount(0)
  await expect(settings.getByLabel('OpenAI', { exact: true })).toHaveValue(SECRET)

  // Esc asks too.
  await page.keyboard.press('Escape')
  await ask(page).getByRole('button', { name: '保存しないで閉じる' }).click()
  await expect(settings).toHaveCount(0)
  expect(await envUpdates(page)).toEqual([])
  expectNoPageErrors(state)
})

test('保存して閉じる saves what was typed and closes', async ({ page }) => {
  const { state, settings } = await open(page, 'apikeys')
  await settings.getByLabel('OpenAI', { exact: true }).fill(SECRET)
  await settings.getByRole('button', { name: '閉じる' }).click()
  await ask(page).getByRole('button', { name: '保存して閉じる' }).click()
  await expect(settings).toHaveCount(0)
  expect(await envUpdates(page)).toEqual([{ OPENAI_API_KEY: SECRET }])
  expectNoPageErrors(state)
})

test('the panel\'s .env draft survives moving to another section: nothing asked until closing', async ({ page }) => {
  const { state, settings } = await open(page, 'apikeys')
  await settings.getByLabel('OpenAI', { exact: true }).fill(SECRET)
  await settings.getByRole('button', { name: '自分の設定' }).click()
  await expect(ask(page)).toHaveCount(0)
  await settings.getByRole('button', { name: /APIキー（このPC）/ }).click()
  await expect(settings.getByLabel('OpenAI', { exact: true })).toHaveValue(SECRET)
  expectNoPageErrors(state)
})

test('a download choice not applied: leaving the section asks (移る), 戻る keeps the draft', async ({ page }) => {
  const { state, settings } = await open(page, 'sync')
  await settings.getByRole('tree', { name: 'ダウンロードするフォルダ' }).getByRole('checkbox', { name: '開発部をダウンロードする' }).click()
  await settings.getByRole('button', { name: '自分の設定' }).click()
  await expect(ask(page)).toContainText('ダウンロードするフォルダの変更（まだ適用していません）')
  await expect(ask(page).getByRole('button', { name: '保存しないで移る' })).toBeVisible()
  await ask(page).getByRole('button', { name: '戻る' }).click()
  await expect(settings.getByText(/^未適用の変更：/)).toHaveText('未適用の変更：1 個をダウンロードしない')
  // 保存して閉じる applies it, then closes.
  await settings.getByRole('button', { name: '閉じる' }).click()
  await ask(page).getByRole('button', { name: '保存して閉じる' }).click()
  await expect(settings).toHaveCount(0)
  await page.getByRole('button', { name: '設定を開く' }).click()
  await expect(page.getByRole('checkbox', { name: '開発部をダウンロードする' })).not.toBeChecked()
  expectNoPageErrors(state)
})

test('nothing unsaved: closing asks nothing', async ({ page }) => {
  const { state, settings } = await open(page, 'apikeys')
  await expect(settings.getByLabel('OpenAI', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: '閉じる' }).click()
  await expect(settings).toHaveCount(0)
  await expect(ask(page)).toHaveCount(0)
  expectNoPageErrors(state)
})
