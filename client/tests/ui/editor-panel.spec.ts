// The editor panel's own behaviour (tests/editor-tabs-ui.tsx?view=tabs): tabs,
// saving, the Markdown preview and its shortcuts, images and PDFs. External
// changes: editor-tabs.spec.ts; reviews inside the preview: doc-review.spec.ts.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const ROOT = '/Users/demo/会社'
const SCRIPT = `${ROOT}/コンテンツG/台本.md`
const LONG_DOC = `${ROOT}/営業部/議事録.md`

const editor = (page: Page) => page.locator('.cm-content[role="textbox"]')
const tab = (page: Page, path: string) => page.getByTitle(path, { exact: true })
const closeButton = (page: Page, path: string) => page.locator('div.group', { has: tab(page, path) }).getByRole('button')
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __acbWrites: Array<[string, string]> }).__acbWrites)
const pinned = (page: Page) => page.evaluate(() => (window as unknown as { __acbPinned: string[] }).__acbPinned)
/** A shortcut as macOS reports it (⌘⇧M arrives as key 'm'), sent to the focused element. */
const shortcut = (page: Page, init: { key: string; shiftKey?: boolean }) => page.evaluate((i) => {
  (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', { ...i, metaKey: true, bubbles: true, cancelable: true }))
}, init)

/** Timers only move when the test says so (autosave waits one second). */
async function pauseClock(page: Page) {
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00'))
}

async function open(page: Page) {
  const state = await openPreview(page, 'editor-tabs', { view: 'tabs' })
  await expect(editor(page)).toContainText('第12回の構成案です。')
  return state
}

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(text)
}

test('an edit is saved a second after the last keystroke; until then the tab says it is unsaved', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  const state = await open(page)
  await pauseClock(page)
  await typeAtEnd(page, '\n追記')
  await expect(page.getByText('自動保存 (未保存の変更あり)')).toBeVisible()
  await page.clock.runFor(900)
  expect(await writes(page)).toEqual([])
  await page.clock.runFor(300)
  await expect.poll(() => writes(page)).toEqual([[SCRIPT, '# 台本\n\n第12回の構成案です。\n追記']])
  await expect(page.getByText('自動保存 (未保存の変更あり)')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('⌘S saves at once, without waiting for the autosave', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await pauseClock(page)
  await typeAtEnd(page, '\n追記')
  await shortcut(page, { key: 's' })
  await expect.poll(() => writes(page)).toEqual([[SCRIPT, '# 台本\n\n第12回の構成案です。\n追記']])
})

test('closing a tab with edits saves them first; a clean tab just closes', async ({ page }) => {
  await open(page)
  await typeAtEnd(page, '\n閉じる前の追記')
  await closeButton(page, SCRIPT).click()
  await expect(tab(page, SCRIPT)).toHaveCount(0)
  expect(await writes(page)).toEqual([[SCRIPT, '# 台本\n\n第12回の構成案です。\n閉じる前の追記']])

  await closeButton(page, `${ROOT}/営業部/顧客リスト.csv`).click()
  await expect(tab(page, `${ROOT}/営業部/顧客リスト.csv`)).toHaveCount(0)
  expect(await writes(page)).toHaveLength(1)
})

test('a preview tab is kept (pinned) when it is double-clicked', async ({ page }) => {
  await open(page)
  await tab(page, `${ROOT}/README.md`).dblclick()
  expect(await pinned(page)).toEqual([`${ROOT}/README.md`])
})

test('a preview tab is kept (pinned) at its first edit', async ({ page }) => {
  await open(page)
  await tab(page, `${ROOT}/README.md`).click()
  await expect(editor(page)).toContainText('会社フォルダ')
  expect(await pinned(page)).toEqual([])
  await typeAtEnd(page, '\n追記')
  await expect.poll(() => pinned(page)).toEqual([`${ROOT}/README.md`])
})

test('⌘⇧M switches a Markdown file between editor and preview, and the choice is kept at the next start', async ({ page }) => {
  await open(page)
  await editor(page).click()
  await shortcut(page, { key: 'm', shiftKey: true })
  await expect(page.getByRole('heading', { name: '台本' })).toBeVisible()
  await expect(editor(page)).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: '台本' })).toBeVisible()
  await page.getByRole('button', { name: '編集' }).click()
  await expect(editor(page)).toContainText('第12回の構成案です。')

  await tab(page, `${ROOT}/営業部/顧客リスト.csv`).click()
  await editor(page).click()
  await shortcut(page, { key: 'm', shiftKey: true })
  await expect(editor(page)).toContainText('A社,山田')
})

test('⌘F in a Markdown preview finds text: count, next, previous, Escape closes and clears', async ({ page }) => {
  await open(page)
  await tab(page, LONG_DOC).click()
  await page.getByRole('button', { name: 'プレビュー' }).click()
  await expect(page.getByRole('heading', { name: '第1回' })).toBeVisible()
  await shortcut(page, { key: 'f' })
  const box = page.getByPlaceholder('検索...')
  await expect(box).toBeFocused()
  await box.fill('予算')
  await expect(page.getByText('1/60')).toBeVisible()
  await box.press('Enter')
  await expect(page.getByText('2/60')).toBeVisible()
  await box.press('Shift+Enter')
  await box.press('Shift+Enter')
  await expect(page.getByText('60/60')).toBeVisible()
  await box.press('Escape')
  await expect(box).toHaveCount(0)
  await expect(page.locator('mark[data-search-highlight]')).toHaveCount(0)
})

test('the preview keeps its scroll position when the member opens another file and comes back', async ({ page }) => {
  await open(page)
  await tab(page, LONG_DOC).click()
  await page.getByRole('button', { name: 'プレビュー' }).click()
  const scroller = page.locator('.markdown-body').locator('..')
  await expect(page.getByRole('heading', { name: '第1回' })).toBeVisible()
  await scroller.evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 })
  await tab(page, `${ROOT}/営業部/顧客リスト.csv`).click()
  await expect(editor(page)).toContainText('A社,山田')
  await tab(page, LONG_DOC).click()
  await expect(page.getByRole('heading', { name: '第1回' })).toBeAttached()
  await expect.poll(() => scroller.evaluate(el => el.scrollTop / (el.scrollHeight - el.clientHeight))).toBeGreaterThan(0.4)
})

test('an image and a PDF show as such, and say so when they cannot be read', async ({ page }) => {
  await open(page)
  await tab(page, `${ROOT}/営業部/ロゴ.png`).click()
  await expect(page.getByRole('img', { name: 'ロゴ.png' })).toBeVisible()
  await expect(editor(page)).toHaveCount(0)
  await tab(page, `${ROOT}/営業部/契約書.pdf`).click()
  await expect(page.getByText('PDFを表示できません（削除されたか、読み込めません）')).toBeVisible()
})
