// The settings ordered by what the member wants to do (UX stage 3, item 19; src/features/settings/sections.ts) on
// tests/download-folders-ui.html: every section in the left list opens its page (詳しい設定 folded until opened),
// a saved .env value never shows again (only 「設定済み（末尾 …）」), the services' list leads to each service's
// page, and what is typed and not saved can be asked from outside the settings (the way a tab frame will ask).
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SECRET = 'sk-test-never-shown-5678'
const settings = (page: Page) => page.getByRole('dialog', { name: '設定' })
const nav = (page: Page) => page.getByRole('navigation', { name: '設定の項目' })

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-20T10:30:00+09:00') })
})

// Each item of the left list and the heading its page shows.
const SECTIONS: Array<[string, string]> = [
  ['AI に任せること', 'AI に任せること'],
  ['定期の仕事', '定期の仕事'],
  ['入力（音声・候補）', '入力（音声・候補）'],
  ['サービスの一覧', 'つないでいるサービス'],
  ['Google', 'Google'],
  ['Slack', 'Slack'],
  ['ブラウザ操作', 'ブラウザ操作'],
  ['Claude・Gemini などの鍵', 'Claude・Gemini などの鍵'],
  ['不在と代わりの人', '不在と代わりの人'],
  ['この PC に置くフォルダ', 'この PC に置くフォルダ'],
  ['自動同期', '自動同期'],
  ['同期しないファイル', '同期しないファイル'],
  ['API キー・環境変数（この PC）', 'API キー・環境変数（この PC）'],
  ['AIに渡す環境変数', 'AIに渡す環境変数'],
]

test('every section is reached from the left list; 詳しい設定 is folded until opened', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { browser: '1', manual: '1', google: 'connected', slack: 'connected' })
  const folded = nav(page).getByRole('button', { name: '詳しい設定' })
  await expect(folded).toHaveAttribute('aria-expanded', 'false')
  await expect(nav(page).getByRole('button', { name: 'API キー・環境変数（この PC）' })).toHaveCount(0)
  await folded.click()
  await expect(folded).toHaveAttribute('aria-expanded', 'true')
  await expect(nav(page).locator('li button')).toHaveCount(SECTIONS.length)
  for (const [item, heading] of SECTIONS) {
    await nav(page).getByRole('button', { name: item, exact: true }).click()
    await expect(settings(page).getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible()
  }
  expectNoPageErrors(state)
})

test('a section asked for opens with its group unfolded (the chat\'s "no key" card, a section of 詳しい設定)', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { tab: 'aienv' })
  await expect(nav(page).getByRole('button', { name: '詳しい設定' })).toHaveAttribute('aria-expanded', 'true')
  await expect(nav(page).getByRole('button', { name: 'AIに渡す環境変数' })).toHaveAttribute('aria-current', 'page')
  expectNoPageErrors(state)
})

test('a saved key never shows again: after 保存 only 「設定済み（末尾 …）」 is on the page, not the value', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { tab: 'envkeys' })
  const openai = settings(page).getByLabel('OpenAI', { exact: true })
  await openai.fill(SECRET)
  await settings(page).getByRole('button', { name: '保存', exact: true }).click()
  await expect(settings(page).getByRole('button', { name: '保存しました' })).toBeVisible()
  await expect(openai).toHaveValue('')
  await expect(openai).toHaveAttribute('placeholder', /設定済み（末尾 5678）/)
  // Moving away and back reads the status again: still no value anywhere on the page.
  await nav(page).getByRole('button', { name: 'AI に任せること' }).click()
  await nav(page).getByRole('button', { name: 'API キー・環境変数（この PC）' }).click()
  await expect(settings(page).getByLabel('OpenAI', { exact: true })).toHaveValue('')
  expect(await page.content()).not.toContain(SECRET)
  const values = await page.locator('input, textarea').evaluateAll(els => els.map(el => (el as HTMLInputElement).value))
  expect(values.join('\n')).not.toContain(SECRET)
  expectNoPageErrors(state)
})

test('サービスの一覧: each service\'s card says its state and leads to its own page with 詳しく', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { tab: 'tools', manual: '1', google: 'connected', slack: 'connected' })
  await expect(settings(page).getByRole('heading', { name: 'つないでいるサービス' })).toBeVisible()
  await settings(page).getByRole('button', { name: 'Googleを詳しく' }).click()
  await expect(nav(page).getByRole('button', { name: 'Google' })).toHaveAttribute('aria-current', 'page')
  await expect(settings(page).getByRole('heading', { level: 2, name: 'Google', exact: true })).toBeVisible()
  expectNoPageErrors(state)
})

type Ask = { current: { pending: () => string[]; save: () => Promise<string | null> } | null }
const askFromOutside = (page: Page) => page.evaluate(() => (window as unknown as { __settingsUnsaved: Ask }).__settingsUnsaved.current?.pending() ?? null)

test('what is typed and not saved is asked from outside the settings: a kept .env draft and the open section\'s key; save() saves them', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { tab: 'envkeys' })
  expect(await askFromOutside(page)).toEqual([])
  await settings(page).getByLabel('OpenAI', { exact: true }).fill(SECRET)
  // The .env draft survives moving to 「Claude・Gemini などの鍵」, where a key is typed too.
  await nav(page).getByRole('button', { name: 'Claude・Gemini などの鍵' }).click()
  await settings(page).getByRole('button', { name: '自分の鍵を登録' }).click()
  await settings(page).getByLabel('鍵（発行元の画面からコピーして貼り付け）').fill('gm-test-typed-key-0000')
  const asked = await askFromOutside(page)
  expect(asked).toEqual(['Claude・Gemini などの鍵（Anthropic（Claude API））の入力', 'API キー・環境変数の入力'])
  expect(asked!.join('')).not.toContain(SECRET)

  const failed = await page.evaluate(() => (window as unknown as { __settingsUnsaved: Ask }).__settingsUnsaved.current!.save())
  expect(failed).toBeNull()
  expect(await askFromOutside(page)).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { __acbEnvUpdates?: unknown[] }).__acbEnvUpdates)).toEqual([{ OPENAI_API_KEY: SECRET }])
  expectNoPageErrors(state)
})
