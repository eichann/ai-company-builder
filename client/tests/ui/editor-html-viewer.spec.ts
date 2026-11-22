// The HTML viewer in the middle panel (tests/editor-tabs-ui.tsx?view=html, doc-frame.md "The viewer
// (A2)"): an .html tab opens as 見る, its document view is placed over the tab's area and hidden
// while anything of the app covers it, closed when the tab is left or 中身 is shown; a refusal is
// said in plain Japanese; a change of its files reloads it; a link asks first with its domain large.
// The views themselves are faked (window.__acbDocCalls); the real view: doc-frame-electron.test.ts.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const ROOT = '/Users/demo/会社'
const DOC = `${ROOT}/営業部/報告/11月の売上.html`
const TOP = `${ROOT}/会社案内.html`
const MD = `${ROOT}/営業部/提案書.md`

type Call = [string, ...unknown[]]
type Box = { x: number; y: number; width: number; height: number }
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __acbDocCalls: Call[] }).__acbDocCalls)
const lastBounds = async (page: Page) => (await calls(page)).filter(c => c[0] === 'bounds').at(-1)?.[2] as Box | null | undefined
const sendEvent = (page: Page, event: unknown) => page.evaluate(e => (window as unknown as { __acbDocEvent: (e: unknown) => void }).__acbDocEvent(e), event)
const tab = (page: Page, path: string) => page.getByTitle(path, { exact: true })
const area = (page: Page) => page.getByTestId('html-viewer-area')

async function open(page: Page) {
  const state = await openPreview(page, 'editor-tabs', { view: 'html' })
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  await expect.poll(() => lastBounds(page)).toBeTruthy()
  return state
}

test('an .html tab opens as 見る: its view is placed exactly over the tab\'s area, and closed when another tab is chosen', async ({ page }) => {
  const state = await open(page)
  expect((await calls(page))[0]).toEqual(['open', DOC])
  const box = await area(page).boundingBox()
  const placed = (await lastBounds(page))!
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(placed[k] - box![k])).toBeLessThan(1)
  await expect(page.getByRole('button', { name: '見る' })).toHaveAttribute('aria-pressed', 'true')
  await tab(page, MD).click()
  await expect.poll(async () => (await calls(page)).some(c => c[0] === 'close' && c[1] === 7)).toBe(true)
  await tab(page, DOC).click()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').length).toBe(2)
  expectNoPageErrors(state)
})

test('anything of the app drawn over the document hides its view until it goes (a menu, the link confirmation)', async ({ page }) => {
  const state = await open(page)
  await page.getByTestId('open-menu').click()
  await expect.poll(() => lastBounds(page)).toBeNull()
  await expect(area(page)).toContainText('メニューやダイアログを閉じると、資料に戻ります。')
  await page.getByRole('menuitem', { name: '閉じる' }).click()
  await expect.poll(() => lastBounds(page)).toBeTruthy()
  // A menu smaller than the grid of points, placed between its points, is found by its role.
  const box = (await area(page).boundingBox())!
  const step = (w: number) => (w - 4) / Math.ceil((w - 4) / 48)
  await page.evaluate(at => { (window as unknown as { __acbSmallMenuAt: object }).__acbSmallMenuAt = at }, {
    left: box.x + 2 + step(box.width) / 2 - 6, top: box.y + 2 + step(box.height) / 2 - 6,
  })
  await page.getByTestId('open-small-menu').click()
  await expect.poll(() => lastBounds(page)).toBeNull()
  await page.getByTestId('open-small-menu').click()
  await expect.poll(() => lastBounds(page)).toBeTruthy()
  expectNoPageErrors(state)
})

test('a view that is made after the member left (another tab, 中身) is closed at once', async ({ page }) => {
  const state = await open(page)
  await page.evaluate(() => { (window as unknown as { __acbDocDelay: number }).__acbDocDelay = 400 })
  await page.getByRole('button', { name: '中身' }).click()
  await page.getByTitle('見る', { exact: true }).click()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').length).toBe(2)
  await tab(page, MD).click()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'close')).toContainEqual(['close', 8])
  expect((await calls(page)).filter(c => c[0] === 'bounds' && c[1] === 8)).toEqual([])
  expectNoPageErrors(state)
})

test('a refusal is said in plain Japanese (a document at the company folder\'s top level)', async ({ page }) => {
  const state = await open(page)
  await tab(page, TOP).click()
  await expect(page.getByRole('alert')).toHaveText('会社フォルダのいちばん上にある HTML は表示できません。部署などのフォルダに入れてください。')
  expectNoPageErrors(state)
})

test('中身 shows the source and closes the view; ⌘⇧V goes back to 見る and opens it again', async ({ page }) => {
  const state = await open(page)
  await page.getByRole('button', { name: '中身' }).click()
  await expect(page.locator('.cm-content[role="textbox"]')).toContainText('11月の売上')
  expect(await calls(page)).toContainEqual(['close', 7])
  await page.locator('.cm-content[role="textbox"]').click()
  await page.evaluate(() => (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', { key: 'v', shiftKey: true, metaKey: true, bubbles: true, cancelable: true })))
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').length).toBe(2)
  expectNoPageErrors(state)
})

test('a change of the document or a file it loads reloads it; a data file or another folder does not', async ({ page }) => {
  const state = await open(page)
  const change = (p: string) => page.evaluate(path => (window as unknown as { __acbFileChange: (p: string) => void }).__acbFileChange(path), p)
  await change(`${ROOT}/営業部/報告/売上.csv`)
  await change(`${ROOT}/営業部/style.css`)
  await page.waitForTimeout(400)
  expect((await calls(page)).filter(c => c[0] === 'reload')).toEqual([])
  await change(`${ROOT}/営業部/報告/images/graph.png`)
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'reload')).toEqual([['reload', 7]])
  await expect(page.getByText('ファイルが変わったので、表示を新しくしました')).toBeVisible()
  await change(DOC)
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'reload').length).toBe(2)
  expectNoPageErrors(state)
})

test('a link pressed in the document asks first, its domain large; only 「ブラウザで開く」 hands it to the browser', async ({ page }) => {
  const state = await open(page)
  const opened = () => page.evaluate(() => (window as unknown as { __acbOpened: string[] }).__acbOpened)
  await sendEvent(page, { viewId: 99, kind: 'link', url: 'https://other.example/' })
  await page.waitForTimeout(200)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await sendEvent(page, { viewId: 7, kind: 'link', url: 'https://xn--80ak6aa92e.com/report?from=doc' })
  const dialog = page.getByRole('dialog', { name: '外のサイトを開きますか？' })
  await expect(dialog.getByTestId('link-host')).toHaveText('xn--80ak6aa92e.com')
  await expect.poll(() => lastBounds(page), 'the document is hidden under the confirmation').toBeNull()
  await expect(dialog).toBeFocused()
  await page.keyboard.press('Enter')
  expect(await opened()).toEqual([])
  await dialog.getByRole('button', { name: 'やめる' }).click()
  expect(await opened()).toEqual([])
  await sendEvent(page, { viewId: 7, kind: 'link', url: 'https://example.com/a' })
  await page.getByRole('button', { name: 'ブラウザで開く' }).click()
  expect(await opened()).toEqual(['https://example.com/a'])
  await expect.poll(() => lastBounds(page)).toBeTruthy()
  expectNoPageErrors(state)
})

test('zoom steps, 止める and もう一度表示する, and a view that went by itself', async ({ page }) => {
  const state = await open(page)
  await page.getByRole('button', { name: '拡大' }).click()
  await page.getByRole('button', { name: '拡大' }).click()
  await page.getByRole('button', { name: '元の大きさ' }).click()
  await page.getByRole('button', { name: '縮小' }).click()
  expect((await calls(page)).filter(c => c[0] === 'zoom')).toEqual([['zoom', 7, 1.1], ['zoom', 7, 1.25], ['zoom', 7, 1], ['zoom', 7, 0.9]])
  await expect(page.getByText('90%')).toBeVisible()
  await page.getByRole('button', { name: '止める' }).click()
  expect(await calls(page)).toContainEqual(['close', 7])
  await expect(area(page)).toContainText('資料を止めました')
  await page.getByRole('button', { name: 'もう一度表示する' }).click()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').length).toBe(2)
  await expect.poll(async () => (await calls(page)).at(-1)).toEqual(['bounds', 8, expect.anything()])
  expect(await calls(page)).toContainEqual(['zoom', 8, 0.9])
  await sendEvent(page, { viewId: 8, kind: 'gone' })
  await expect(page.getByRole('alert')).toContainText('資料の表示が止まりました')
  expectNoPageErrors(state)
})

test('the tab keeps its zoom when the member goes to another tab or 中身 and comes back', async ({ page }) => {
  const state = await open(page)
  await page.getByRole('button', { name: '拡大' }).click()
  await page.getByRole('button', { name: '中身' }).click()
  await page.getByTitle('見る', { exact: true }).click()
  await expect(page.getByText('110%')).toBeVisible()
  await tab(page, MD).click()
  await tab(page, DOC).click()
  await expect(page.getByText('110%')).toBeVisible()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'zoom')).toEqual([['zoom', 7, 1.1], ['zoom', 8, 1.1], ['zoom', 9, 1.1]])
  expectNoPageErrors(state)
})

test('全画面 covers the window with the document; 全画面を終える puts it back', async ({ page }) => {
  const state = await open(page)
  const before = (await lastBounds(page))!
  await page.getByRole('button', { name: '全画面' }).click()
  await expect.poll(async () => (await lastBounds(page))?.height ?? 0).toBeGreaterThan(before.height + 100)
  expect((await lastBounds(page))!.y).toBeLessThan(before.y)
  await page.getByRole('button', { name: '全画面を終える' }).click()
  await expect.poll(async () => (await lastBounds(page))?.height).toBe(before.height)
  expectNoPageErrors(state)
})
