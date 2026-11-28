// The editor panel's own behaviour (tests/editor-tabs-ui.tsx?view=tabs): tabs,
// saving, the Markdown preview and its shortcuts, images and PDFs. External
// changes: editor-tabs.spec.ts; reviews inside the preview: doc-review.spec.ts.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const ROOT = '/Users/demo/会社'
const SCRIPT = `${ROOT}/コンテンツG/台本.md`
const LONG_DOC = `${ROOT}/営業部/議事録.md`

const editor = (page: Page) => page.locator('.cm-content[role="textbox"]')
const tab = (page: Page, path: string) => page.getByTitle(path, { exact: true })
const closeButton = (page: Page, path: string) => page.locator('div.group', { has: tab(page, path) }).getByRole('button')
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __acbWrites: Array<[string, string]> }).__acbWrites)
/** What automatic sync reads before it runs (src/shared/lib/unsavedEdits.ts). */
const unsavedForSync = (page: Page) => page.evaluate(() => (window as unknown as { __acbHasUnsavedEdits: () => boolean }).__acbHasUnsavedEdits())
const pinned = (page: Page) => page.evaluate(() => (window as unknown as { __acbPinned: string[] }).__acbPinned)
/** A shortcut as macOS reports it (⌘⇧V arrives as key 'v'), sent to the focused element. */
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

test('an edit is saved a second after the last keystroke; until then the tab says it is unsaved and automatic sync waits', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  const state = await open(page)
  await pauseClock(page)
  expect(await unsavedForSync(page)).toBe(false)
  await typeAtEnd(page, '\n追記')
  await expect(page.getByRole('tab').getByRole('img', { name: '保存していない変更があります' })).toBeVisible()
  expect(await unsavedForSync(page), 'automatic sync must see the unsaved tab').toBe(true)
  await page.clock.runFor(900)
  expect(await writes(page)).toEqual([])
  await page.clock.runFor(300)
  await expect.poll(() => writes(page)).toEqual([[SCRIPT, '# 台本\n\n第12回の構成案です。\n追記']])
  await expect(page.getByRole('img', { name: '保存していない変更があります' })).toHaveCount(0)
  expect(await unsavedForSync(page)).toBe(false)
  expectNoPageErrors(state)
})

test('a failed autosave says so above the editor and the tab keeps its unsaved dot (no bottom band)', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await pauseClock(page)
  await page.evaluate(p => (window as unknown as { __acbFailWrites: Set<string> }).__acbFailWrites.add(p), SCRIPT)
  await typeAtEnd(page, '\n追記')
  await page.clock.runFor(1200)
  await expect(page.getByText('保存に失敗しました')).toBeVisible()
  await expect(page.getByRole('tab').getByRole('img', { name: '保存していない変更があります' })).toBeVisible()
  expect(await unsavedForSync(page)).toBe(true)
})

test('⌘S saves at once, without waiting for the autosave', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await pauseClock(page)
  await typeAtEnd(page, '\n追記')
  await shortcut(page, { key: 's' })
  await expect.poll(() => writes(page)).toEqual([[SCRIPT, '# 台本\n\n第12回の構成案です。\n追記']])
})

test('the editor\'s shortcuts reach it only while the focus is inside it', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await pauseClock(page)
  await typeAtEnd(page, '\n追記')
  await page.getByRole('button', { name: '営業部' }).click()
  await shortcut(page, { key: 's' })
  await shortcut(page, { key: 'v', shiftKey: true })
  await expect(editor(page)).toBeVisible()
  expect(await writes(page)).toEqual([])

  await editor(page).click()
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

test('closing a tab whose file changed elsewhere keeps it open and shows the compare view: nothing written, nothing dropped', async ({ page }) => {
  await open(page)
  await typeAtEnd(page, '\n閉じる前の追記')
  // Changed on disk before the watcher tells the tab: the save on closing finds it.
  await page.evaluate(p => { (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles[p] += '\nAI の追記' }, SCRIPT)
  await closeButton(page, SCRIPT).click()
  await expect(page.getByTestId('external-compare')).toBeVisible()
  await expect(tab(page, SCRIPT)).toHaveCount(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await writes(page)).toEqual([])
  await expect(editor(page)).toHaveCount(0)
  await page.getByRole('button', { name: '比べるのをやめる' }).click()
  await expect(editor(page)).toContainText('閉じる前の追記')
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

test('⌘⇧V switches a Markdown file between editor and preview, and the choice is kept at the next start', async ({ page }) => {
  await open(page)
  await editor(page).click()
  await shortcut(page, { key: 'v', shiftKey: true })
  await expect(page.getByRole('heading', { name: '台本' })).toBeVisible()
  await expect(editor(page)).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: '台本' })).toBeVisible()
  await page.getByRole('button', { name: '編集' }).click()
  await expect(editor(page)).toContainText('第12回の構成案です。')

  await tab(page, `${ROOT}/営業部/顧客リスト.csv`).click()
  await editor(page).click()
  await shortcut(page, { key: 'v', shiftKey: true })
  await expect(editor(page)).toContainText('A社,山田')
})

test('⌘F in a Markdown preview finds text: count, next, previous, Escape closes and clears', async ({ page }) => {
  await open(page)
  await tab(page, LONG_DOC).click()
  await page.getByRole('button', { name: 'プレビュー' }).click()
  await expect(page.getByRole('heading', { name: '第1回' })).toBeVisible()
  // The pressed button is gone: the editor takes the focus back on the next frame (slow runners lag).
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-command-area="editor"]'))).toBe(true)
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

test('⌘F in a preview also finds the name and description shown from the file\'s frontmatter', async ({ page }) => {
  await open(page)
  // A SKILL.md-like file: the `---` block becomes the quiet box above the text.
  await page.evaluate(p => {
    const w = window as unknown as { __acbFiles: Record<string, string>; __acbFileChange: (path: string) => void }
    w.__acbFiles[p] = '---\nname: proposal-writer\ndescription: 提案書の骨子を作る\n---\n\n# 議事録\n\n本文です。'
    w.__acbFileChange(p)
  }, LONG_DOC)
  await tab(page, LONG_DOC).click()
  await page.getByRole('button', { name: 'プレビュー' }).click()
  await expect(page.getByRole('note', { name: 'このファイルの情報' })).toContainText('proposal-writer')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-command-area="editor"]'))).toBe(true)
  await shortcut(page, { key: 'f' })
  const box = page.getByPlaceholder('検索...')
  await box.fill('proposal-writer')
  await expect(page.getByText('1/1')).toBeVisible()
  await box.fill('骨子')
  await expect(page.getByText('1/1')).toBeVisible()
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

test('each Markdown file keeps its own preview scroll position when the member switches between two previews', async ({ page }) => {
  // Preview → preview kept one mounted preview: the second file opened at the
  // first one's position, and coming back did not restore it.
  await open(page)
  await tab(page, LONG_DOC).click()
  await page.getByRole('button', { name: 'プレビュー' }).click()
  const scroller = page.locator('.markdown-body').locator('..')
  await expect(page.getByRole('heading', { name: '第1回' })).toBeVisible()
  await scroller.evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 })
  await tab(page, `${ROOT}/営業部/提案書.md`).click()
  await expect(page.getByRole('heading', { name: '提案書' })).toBeVisible()
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

/**
 * Videos load from `acb-media://`, the app's own scheme (main streams them): the browser here has
 * none, so the page's video addresses are pointed at a route that answers with the fixture's bytes.
 */
async function serveVideos(page: Page, files: Record<string, string>) {
  await page.addInitScript(() => {
    const toRoute = (value: string) => value.startsWith('acb-media://video/')
      ? `/__acb-media/${encodeURIComponent(decodeURIComponent(value.slice('acb-media://video/'.length).split('?')[0]).split('/').pop() ?? '')}`
      : value
    const setAttribute = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (name: string, value: string) {
      return setAttribute.call(this, name, this instanceof HTMLMediaElement && name === 'src' ? toRoute(String(value)) : value)
    }
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...src, set(value: string) { src.set!.call(this, toRoute(String(value))) } })
  })
  await page.route('**/__acb-media/**', route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '')
    const fixture = files[name]
    return fixture
      ? route.fulfill({ status: 200, contentType: 'video/mp4', body: fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'video', fixture)) })
      : route.fulfill({ status: 404 })
  })
}

test('a video opens in a player with its controls and never starts by itself; one the player cannot read offers another app', async ({ page }) => {
  await serveVideos(page, { '研修.mp4': 'vp9.mp4', '素材.mov': 'prores.mov' })
  const state = await open(page)
  await tab(page, `${ROOT}/営業部/研修.mp4`).click()
  const video = page.locator('video')
  await expect(video).toHaveAttribute('controls', '')
  await expect(video).toHaveAttribute('aria-label', '研修.mp4')
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1)
  expect(await video.evaluate((v: HTMLVideoElement) => ({ autoplay: v.autoplay, paused: v.paused, duration: v.duration }))).toEqual({ autoplay: false, paused: true, duration: 1 })
  await expect(editor(page)).toHaveCount(0)

  await tab(page, `${ROOT}/営業部/素材.mov`).click()
  await expect(page.getByText('この動画はアプリの中では再生できません（動画の形式が対応していないか、ファイルが読み込めません）。')).toBeVisible()
  await expect(page.locator('video')).toHaveCount(0)
  await page.getByRole('button', { name: 'ほかのアプリで開く' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __acbOpened: string[] }).__acbOpened)).toEqual([`video:${ROOT}/営業部/素材.mov`])
  expectNoPageErrors(state)
})

const closeAnswers = (page: Page) => page.evaluate(() => (window as unknown as { __acbCloseAnswers: string[] }).__acbCloseAnswers)
const requestClose = (page: Page) => page.evaluate(() => (window as unknown as { __acbRequestClose: () => void }).__acbRequestClose())

test('closing the window saves every tab with edits — also one not shown — before main may close it', async ({ page }) => {
  // Autosave runs for the shown tab only: an edit in a tab the member left
  // within the second was never written, and closing the window lost it.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await pauseClock(page)
  await typeAtEnd(page, '\n追記')
  await tab(page, `${ROOT}/営業部/提案書.md`).click()
  await requestClose(page)
  await expect.poll(() => closeAnswers(page)).toEqual(['ack', 'close'])
  expect(await writes(page)).toEqual([[SCRIPT, '# 台本\n\n第12回の構成案です。\n追記']])
})

test('a tab that cannot be saved is named before the window closes; キャンセル keeps it open', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await pauseClock(page)
  await page.evaluate(p => (window as unknown as { __acbFailWrites: Set<string> }).__acbFailWrites.add(p), SCRIPT)
  await typeAtEnd(page, '\n追記')
  await requestClose(page)
  await expect(page.getByRole('heading', { name: '保存できていない編集があります' })).toBeVisible()
  await expect(page.getByText('・台本.md')).toBeVisible()
  await page.keyboard.press('Enter') // Enter does not discard
  await expect(page.getByRole('heading', { name: '保存できていない編集があります' })).toBeVisible()
  await page.getByRole('button', { name: 'キャンセル' }).click()
  await expect.poll(() => closeAnswers(page)).toEqual(['ack', 'stay'])
  await expect(editor(page)).toContainText('追記')

  await requestClose(page)
  await page.getByRole('button', { name: '保存せずに進む' }).click()
  await expect.poll(() => closeAnswers(page)).toEqual(['ack', 'stay', 'ack', 'close'])
})
