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
  expect((await calls(page))[0]).toEqual(['open', DOC, 'demo'])
  const box = await area(page).boundingBox()
  const placed = (await lastBounds(page))!
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(placed[k] - box![k])).toBeLessThan(1)
  await expect(page.getByRole('toolbar', { name: '資料の表示' }).getByRole('button', { name: '見る' })).toHaveAttribute('aria-pressed', 'true')
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
  // A toast (role status) as small, the same way.
  await page.getByTestId('open-toast').click()
  await expect.poll(() => lastBounds(page)).toBeNull()
  await page.getByTestId('open-toast').click()
  await expect.poll(() => lastBounds(page)).toBeTruthy()
  expectNoPageErrors(state)
})

test('the document shows between the dividers around the editor (left column, chat, bottom panel), and follows a drag of the left one', async ({ page }) => {
  // Each divider's grab strip reaches 4 px over the editor's edge, over the points the cover check
  // samples 2 px inside the area: it lies under the document, it is not an overlay.
  const state = await open(page)
  await expect(area(page)).not.toContainText('メニューやダイアログを閉じると、資料に戻ります。')
  const before = (await lastBounds(page))!
  const divider = (await page.getByRole('separator', { name: 'ファイルツリーとエディタの境目' }).boundingBox())!
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
  await page.mouse.down()
  await page.mouse.move(divider.x + 60, divider.y + divider.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await lastBounds(page))?.x ?? 0)).toBe(Math.round(before.x + 60 - divider.width / 2))
  expect((await lastBounds(page))!.width).toBeLessThan(before.width)
  expectNoPageErrors(state)
})

test('a view that is made after the member left (another tab, 中身) is closed at once', async ({ page }) => {
  const state = await open(page)
  await page.evaluate(() => { (window as unknown as { __acbDocDelay: number }).__acbDocDelay = 400 })
  await page.getByRole('button', { name: '中身' }).click()
  await page.getByRole('toolbar', { name: '資料の中身' }).getByRole('button', { name: '見る' }).click()
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
  expect(await calls(page)).toContainEqual(['close', 7, true])
  await page.locator('.cm-content[role="textbox"]').click()
  await page.evaluate(() => (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', { key: 'v', shiftKey: true, metaKey: true, bubbles: true, cancelable: true })))
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').length).toBe(2)
  expectNoPageErrors(state)
})

test('中身 keeps the labelled 「見る｜中身」 at the same top-left place; 見る shows the document again where the member was reading', async ({ page }) => {
  // The owner (2026-11-23): 「中身に切り替えたら、戻らなくなっちゃいました」 — the toggle lived only in the
  // document's toolbar, which 中身 closes.
  const state = await open(page)
  const viewBar = page.getByRole('toolbar', { name: '資料の表示' })
  const at = (await viewBar.getByRole('button', { name: '見る' }).boundingBox())!
  await viewBar.getByRole('button', { name: '中身' }).click()
  await expect(page.locator('.cm-content[role="textbox"]')).toContainText('11月の売上')
  const sourceBar = page.getByRole('toolbar', { name: '資料の中身' })
  const back = sourceBar.getByRole('button', { name: '見る' })
  await expect(back).toBeVisible()
  await expect(back).toHaveAttribute('aria-pressed', 'false')
  await expect(sourceBar.getByRole('button', { name: '中身' })).toHaveAttribute('aria-pressed', 'true')
  const box = (await back.boundingBox())!
  expect(Math.abs(box.x - at.x)).toBeLessThan(1)
  expect(Math.abs(box.y - at.y)).toBeLessThan(1)
  // Leaving for 中身 asks main to keep where the document was scrolled (main keeps it; the page never sees it).
  expect(await calls(page)).toContainEqual(['close', 7, true])
  await back.click()
  await expect(viewBar).toBeVisible()
  await expect(sourceBar).toHaveCount(0)
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').length).toBe(2)
  await expect.poll(async () => (await calls(page)).at(-1)).toEqual(['bounds', 8, expect.anything()])
  // Another tab or ［止める］ keeps nothing: the document opens from its top next time, as before.
  await tab(page, MD).click()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'close' && c[1] === 8)).toEqual([['close', 8]])
  await expect(page.getByRole('toolbar', { name: '資料の中身' })).toHaveCount(0)
  await tab(page, DOC).click()
  await viewBar.getByRole('button', { name: '止める' }).click()
  expect((await calls(page)).filter(c => c[0] === 'close' && c[1] === 9)).toEqual([['close', 9]])
  expectNoPageErrors(state)
})

test('an app shortcut pressed while the document has the keyboard runs as if pressed in its tab (⌘⇧V → 中身); another view\'s does not', async ({ page }) => {
  const state = await open(page)
  const key = { key: 'v', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }
  await sendEvent(page, { viewId: 99, kind: 'shortcut', key })
  await page.waitForTimeout(200)
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  // The focus is elsewhere in the page (the document's own view had the keyboard): the tab still gets it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await sendEvent(page, { viewId: 7, kind: 'shortcut', key })
  await expect(page.locator('.cm-content[role="textbox"]')).toContainText('11月の売上')
  expect(await calls(page)).toContainEqual(['close', 7, true])
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

test('a Drive file link also offers ［ACB で再生］, which asks main by view and main\'s number for the link (never the address); other links do not', async ({ page }) => {
  const state = await open(page)
  const opened = () => page.evaluate(() => (window as unknown as { __acbOpened: string[] }).__acbOpened)
  expect((await calls(page)).find(c => c[0] === 'open'), 'the view is opened for the current company').toEqual(['open', DOC, 'demo'])
  await sendEvent(page, { viewId: 7, kind: 'link', url: 'https://example.com/a' })
  const dialog = page.getByRole('dialog', { name: '外のサイトを開きますか？' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'ACB で再生' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'やめる' }).click()
  await sendEvent(page, { viewId: 7, kind: 'link', url: 'https://drive.google.com/file/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/view', videoLink: 3 })
  await expect(dialog.getByTestId('link-host')).toHaveText('drive.google.com')
  await dialog.getByRole('button', { name: 'ACB で再生' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'playLink')).toEqual([['playLink', 7, 3]])
  expect(await opened(), 'nothing opened in the browser').toEqual([])
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
  await page.getByRole('toolbar', { name: '資料の中身' }).getByRole('button', { name: '見る' }).click()
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

const SLIDES = `${ROOT}/営業部/報告/提案スライド.html`
const inserted = (page: Page) => page.evaluate(() => (window as unknown as { __acbInserted: string[] }).__acbInserted)
const band = (page: Page) => page.getByTestId('blocked-parts-band')

test('the chat\'s ［見る］ is on a finished write of an HTML file in the company folder only, and opens its tab as 見る (also from 中身)', async ({ page }) => {
  const state = await open(page)
  const lines = page.getByRole('region', { name: 'AI の作業' })
  // Written HTML (2); not on a read, a Markdown file, an HTML file outside the company folder or a failed write.
  await expect(lines.getByRole('button', { name: '見る' })).toHaveCount(2)
  await lines.getByRole('button', { name: '見る' }).first().click()
  await expect(tab(page, SLIDES)).toBeVisible()
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').map(c => c[1])).toEqual([DOC, SLIDES])
  // The other document shown as 中身: its ［見る］ brings it back as 見る.
  await tab(page, DOC).click()
  await page.getByRole('button', { name: '中身' }).click()
  await expect(page.locator('.cm-content[role="textbox"]')).toContainText('11月の売上')
  await lines.getByRole('button', { name: '見る' }).last().click()
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').at(-1)?.[1]).toBe(DOC)
  expectNoPageErrors(state)
})

test('the band says what the document wanted from the internet (count, hosts), suggests the AI fix, and stays dismissed for those hosts', async ({ page }) => {
  const state = await open(page)
  await sendEvent(page, { viewId: 99, kind: 'blocked', count: 2, hosts: ['other.example'], hostCount: 1 })
  await page.waitForTimeout(150)
  await expect(band(page)).toHaveCount(0)
  await sendEvent(page, { viewId: 7, kind: 'blocked', count: 3, hosts: ['cdn.jsdelivr.net', 'fonts.googleapis.com'], hostCount: 2 })
  await expect(band(page)).toContainText('この資料はインターネットから部品を 3 件読み込もうとしています。')
  await expect(band(page)).toContainText('読み込まずに表示しています')
  // The document's view moves under the band and stays shown (the band is not an overlay).
  const bandBox = (await band(page).boundingBox())!
  await expect.poll(async () => (await lastBounds(page))?.y ?? 0).toBeGreaterThanOrEqual(Math.floor(bandBox.y + bandBox.height))
  await band(page).getByRole('button', { name: '止めたもの' }).click()
  await expect(band(page).getByRole('listitem')).toHaveText(['cdn.jsdelivr.net', 'fonts.googleapis.com'])
  await expect(band(page)).toContainText('HTML は 1 つのファイルにまとめ、インターネットの部品を使わない')
  await band(page).getByRole('button', { name: 'AI に直してもらう' }).click()
  expect(await inserted(page)).toEqual(['「営業部/報告/11月の売上.html」を、インターネットの部品（CDN のプログラム、Web フォント、ネットの画像）を使わずに作り直してください。HTML は 1 つのファイルにまとめてください。'])
  // Dismissed: the same hosts again (an auto refresh) keep it closed; a new host brings it back.
  await band(page).getByRole('button', { name: 'この帯を閉じる' }).click()
  await expect(band(page)).toHaveCount(0)
  await sendEvent(page, { viewId: 7, kind: 'blocked', count: 4, hosts: ['cdn.jsdelivr.net', 'fonts.googleapis.com'], hostCount: 2 })
  await page.waitForTimeout(150)
  await expect(band(page)).toHaveCount(0)
  await sendEvent(page, { viewId: 7, kind: 'blocked', count: 5, hosts: ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'unpkg.com'], hostCount: 3 })
  await expect(band(page)).toContainText('部品を 5 件')
  // The page loaded again and wants nothing: no band.
  await sendEvent(page, { viewId: 7, kind: 'blocked', count: 0, hosts: [], hostCount: 0 })
  await expect(band(page)).toHaveCount(0)
  // Dismissed, then 止める and もう一度表示する: a new view says it again.
  await sendEvent(page, { viewId: 7, kind: 'blocked', count: 4, hosts: ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'unpkg.com', 'esm.sh'], hostCount: 4 })
  await band(page).getByRole('button', { name: 'この帯を閉じる' }).click()
  await page.getByRole('button', { name: '止める' }).click()
  await expect(band(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'もう一度表示する' }).click()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').length).toBe(2)
  await sendEvent(page, { viewId: 8, kind: 'blocked', count: 1, hosts: ['cdn.jsdelivr.net'], hostCount: 1 })
  await expect(band(page)).toContainText('部品を 1 件')
  expectNoPageErrors(state)
})

test('the band lists the document\'s Google Drive videos (counts only) with ［ブラウザで開く］ for each, which asks main by view and row; ［×］ holds until a new video', async ({ page }) => {
  const state = await open(page)
  const videos = (p: Page) => band(p).getByTestId('drive-videos')
  await sendEvent(page, { viewId: 99, kind: 'driveVideos', count: 2, total: 2, seen: 2 })
  await page.waitForTimeout(150)
  await expect(band(page)).toHaveCount(0)
  // Nothing else blocked: the Drive part shows alone, without the internet parts' sentence.
  await sendEvent(page, { viewId: 7, kind: 'driveVideos', count: 2, total: 2, seen: 2 })
  await expect(videos(page)).toContainText('この資料には Google Drive の動画が 2 本あります。［ACB で再生］で、アプリの中のプレイヤーで見られます')
  await expect(band(page)).not.toContainText('部品を')
  await expect(videos(page).getByRole('listitem')).toHaveText(['動画 1ACB で再生ブラウザで開く', '動画 2ACB で再生ブラウザで開く'])
  await videos(page).getByRole('button', { name: '動画 2 をブラウザで開く' }).click()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'driveVideo')).toEqual([['driveVideo', 7, 1]])
  // ［ACB で再生］: main's player over the document plays it, asked by view and row only.
  await videos(page).getByRole('button', { name: '動画 1 を ACB で再生' }).click()
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'playVideo')).toEqual([['playVideo', 7, 0]])
  // With the blocked parts too: both parts, one band.
  await sendEvent(page, { viewId: 7, kind: 'blocked', count: 2, hosts: ['drive.google.com'], hostCount: 1 })
  await expect(band(page)).toContainText('部品を 2 件')
  await expect(videos(page)).toBeVisible()
  // ［×］: the same videos again (an auto refresh) keep it closed; a video the view had not had brings it back.
  await band(page).getByRole('button', { name: 'この帯を閉じる' }).click()
  await expect(band(page)).toHaveCount(0)
  await sendEvent(page, { viewId: 7, kind: 'driveVideos', count: 1, total: 1, seen: 2 })
  await page.waitForTimeout(150)
  await expect(band(page)).toHaveCount(0)
  await sendEvent(page, { viewId: 7, kind: 'driveVideos', count: 10, total: 12, seen: 13 })
  await expect(videos(page)).toContainText('動画が 12 本あります')
  await expect(videos(page).getByRole('button', { name: /をブラウザで開く$/ })).toHaveCount(10)
  await expect(videos(page).getByRole('listitem').last()).toHaveText('ほかにもあります')
  // Another page of the folder: no videos listed.
  await sendEvent(page, { viewId: 7, kind: 'driveVideos', count: 0, total: 0, seen: 13 })
  await expect(videos(page)).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a view\'s first band state that arrives before its id does is still shown (another view\'s is not); only Drive videos: a neutral label', async ({ page }) => {
  const state = await open(page)
  await page.getByRole('button', { name: '止める' }).click()
  await page.evaluate(() => {
    const w = window as unknown as { __acbEarlyEvents: object[]; __acbDocEvent: (e: unknown) => void }
    w.__acbEarlyEvents = [{ kind: 'driveVideos', count: 1, total: 1, seen: 1 }]
  })
  await page.getByRole('button', { name: 'もう一度表示する' }).click()
  await expect(band(page).getByTestId('drive-videos')).toContainText('動画が 1 本あります')
  await expect(page.getByRole('region', { name: '資料の中の動画' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'インターネットの部品' })).toHaveCount(0)
  // Another view's early state stays its own.
  await page.getByRole('button', { name: '止める' }).click()
  await page.evaluate(() => {
    const w = window as unknown as { __acbEarlyEvents: object[]; __acbDocDelay: number }
    w.__acbEarlyEvents = []
    w.__acbDocDelay = 300
  })
  await page.getByRole('button', { name: 'もう一度表示する' }).click()
  await sendEvent(page, { viewId: 1234, kind: 'driveVideos', count: 3, total: 3, seen: 3 })
  await expect.poll(async () => (await calls(page)).filter(c => c[0] === 'open').length).toBe(3)
  await page.waitForTimeout(600)
  await expect(band(page)).toHaveCount(0)
  expectNoPageErrors(state)
})

test('review: selections count only while reviewing and only from this view, the comment box stays off the document, the comment is saved in the Markdown review\'s shape, a hidden place is said', async ({ page }) => {
  const state = await open(page)
  const files = () => page.evaluate(() => (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles)
  const lastReview = async () => (await calls(page)).filter(c => c[0] === 'review').at(-1)
  const commentBox = page.getByPlaceholder(/コメントを入力/)
  const selection = (viewId: number) => ({ viewId, kind: 'selection', quote: { text: '前年比 120%', prefix: '売上は', suffix: 'でした' } })
  expect(await lastReview()).toBeUndefined()
  // Told while not reviewing: nothing opens.
  await sendEvent(page, selection(7))
  await expect(commentBox).toHaveCount(0)
  await page.getByRole('button', { name: 'レビューする' }).click()
  await expect.poll(lastReview).toEqual(['review', 7, { selecting: true, quotes: [] }])
  // Another view's selection is not this tab's.
  await sendEvent(page, selection(99))
  await expect(commentBox).toHaveCount(0)
  // Another page of the folder shown in the view: the review pauses and says so; a selection then opens nothing.
  await sendEvent(page, { viewId: 7, kind: 'page', own: false })
  await expect(page.getByText(/別のページを表示しているため、レビューを止めています/)).toBeVisible()
  await sendEvent(page, selection(7))
  await expect(commentBox).toHaveCount(0)
  await sendEvent(page, { viewId: 7, kind: 'page', own: true })
  await expect(page.getByText(/別のページを表示しているため/)).toHaveCount(0)
  await sendEvent(page, selection(7))
  await expect(commentBox).toBeVisible()
  // A selection held when the view goes to another page is dropped (it was the document's, not that page's).
  await sendEvent(page, { viewId: 7, kind: 'page', own: false })
  await expect(commentBox).toHaveCount(0)
  await sendEvent(page, { viewId: 7, kind: 'page', own: true })
  await sendEvent(page, selection(7))
  await expect(commentBox).toBeVisible()
  // The whole quote is shown before saving (it scrolls when long; never cut to a few lines).
  const quoteStyle = await page.getByTestId('comment-quote').evaluate(el => ({ overflowY: getComputedStyle(el).overflowY, clamp: getComputedStyle(el).webkitLineClamp }))
  expect(quoteStyle).toEqual({ overflowY: 'auto', clamp: 'none' })
  // The view is drawn above the page: the box must not lie over the document's area (nor hide it).
  const areaBox = (await area(page).boundingBox())!
  expect((await commentBox.boundingBox())!.x).toBeGreaterThanOrEqual(areaBox.x + areaBox.width - 1)
  expect(await lastBounds(page)).toBeTruthy()
  await commentBox.fill('出どころを書いてください。')
  await page.getByRole('button', { name: 'コメント', exact: true }).click()
  await expect(commentBox).toHaveCount(0)
  // The Markdown review's sidecar and shape; where the words are in the file; only the quote goes to the view.
  await expect.poll(async () => Object.keys(await files()).filter(p => p.startsWith(`${DOC}.review.`)).length).toBe(1)
  const saved = JSON.parse(Object.entries(await files()).find(([p]) => p.startsWith(`${DOC}.review.`))![1])
  expect(Object.keys(saved)).toEqual(['version', 'review'])
  const comment = saved.review.comments[0]
  expect(Object.keys(comment)).toEqual(['id', 'authorName', 'severity', 'selectedText', 'startOffset', 'endOffset', 'body', 'createdAt', 'resolved', 'replies'])
  expect((await files())[DOC].slice(comment.startOffset, comment.endOffset)).toBe('前年比 120%')
  await expect.poll(lastReview).toEqual(['review', 7, { selecting: true, quotes: [{ text: '前年比 120%', nth: 0, resolved: false }] }])
  // Its place is in a closed part of the document right now.
  await page.evaluate(() => { (window as unknown as { __acbFound: string }).__acbFound = 'hidden' })
  await page.locator('[data-comment-id]').first().click()
  await expect.poll(async () => (await calls(page)).some(c => c[0] === 'find' && c[1] === 7 && c[2] === 0)).toBe(true)
  await expect(page.getByText(/この部分はいま隠れています/)).toBeVisible()
  // Done: the view reports nothing more and draws nothing.
  await page.getByRole('button', { name: 'レビュー完了' }).click()
  await expect.poll(lastReview).toEqual(['review', 7, null])
  // The snapshot keeps the page's readable text, not its HTML (owner decision 2026-11-26).
  const completed = async () => JSON.parse(Object.entries(await files()).find(([p]) => p.startsWith(`${DOC}.review.`))![1]).review
  await expect.poll(async () => (await completed()).status).toBe('completed')
  expect((await completed()).snapshot).toBe('11月の売上\n売上は前年比 120% でした。')
  // Looking at it again from the history: its marks, but no selections (nothing can be added).
  await page.getByRole('button', { name: /レビュー履歴/ }).click()
  await page.getByRole('button', { name: /1件/ }).click()
  await expect.poll(lastReview).toEqual(['review', 7, { selecting: false, quotes: [{ text: '前年比 120%', nth: 0, resolved: false }] }])
  await sendEvent(page, selection(7))
  await expect(commentBox).toHaveCount(0)
  // 「変更を確認」 reads that snapshot against the page's text now: unchanged.
  await page.getByRole('button', { name: '変更を確認' }).click()
  await expect(page.getByText('レビュー時点から変更はありません')).toBeVisible()
  expectNoPageErrors(state)
})
