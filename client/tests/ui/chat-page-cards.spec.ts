// Page cards in a reply (chat-ui-and-history.md "Page cards in a reply") on the real MarkdownMessage under the real
// editor (tests/editor-tabs-ui.tsx?view=html). The reply's text is the AI's, which may have read a planted
// instruction, so: only a link to an HTML page of the company folder is a card; pressing it opens that page in the
// HTML viewer (doc-frame.md: its own isolated view) and nowhere else; nothing of the page runs or loads in the app's
// page — the card reads nothing, draws no frame and asks the network for nothing. The views are faked
// (window.__acbDocCalls); what a page can reach inside its view: doc-frame-electron.test.ts 「a page the AI made…」.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const ROOT = '/Users/demo/会社'
const DOC = `${ROOT}/営業部/報告/11月の売上.html`
const PAGE_DOC = `${ROOT}/営業部/.personal/inbox/日付別/2026/20261128/ページ/プランの比べ表.html`

type Call = [string, ...unknown[]]
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __acbDocCalls: Call[] }).__acbDocCalls)
const opens = async (page: Page) => (await calls(page)).filter(c => c[0] === 'open').map(c => c[1])
const reply = (page: Page) => page.getByRole('region', { name: 'AI の返事' })
const cards = (page: Page) => reply(page).locator('[data-chat-page-card]')

test('only links to HTML pages of the company folder are cards; a card opens its page in the HTML viewer and runs or loads nothing in the app', async ({ page }) => {
  const outside: string[] = []
  await page.route(url => !['data:', 'blob:', 'about:'].includes(url.protocol) && url.hostname !== '127.0.0.1', route => {
    outside.push(route.request().url())
    return route.abort()
  })
  const state = await openPreview(page, 'editor-tabs', { view: 'html' })
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  await expect.poll(() => opens(page)).toEqual([DOC])

  // The page in the member's 今日のフォルダ and a page of a department: cards. The web, a file outside the company
  // folder, a climb, the top level and a Markdown file stay ordinary links.
  await expect(cards(page)).toHaveCount(2)
  await expect(cards(page).first()).toContainText('プランの比べ表')
  await expect(cards(page).first()).toContainText('ページ・あなただけに見えます・プランの比べ表.html')
  await expect(cards(page).last()).toContainText('11月の売上')
  await expect(cards(page).last()).not.toContainText('あなただけ')
  await expect(reply(page).getByRole('link')).toHaveText(['ネットの表', 'よそ', '上へ', '会社案内', '提案書'])

  // Pressing a card opens that page's tab as 見る: the viewer's own open, with exactly the page's path.
  await cards(page).first().click()
  await expect(page.getByTitle(PAGE_DOC, { exact: true })).toBeVisible()
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  await expect.poll(async () => (await opens(page)).at(-1)).toBe(PAGE_DOC)
  // From 中身, a card brings its page back as 見る.
  await page.getByRole('button', { name: '中身' }).click()
  await expect(page.getByRole('toolbar', { name: '資料の中身' })).toBeVisible()
  const before = (await opens(page)).length
  await cards(page).first().click()
  await expect(page.getByRole('toolbar', { name: '資料の表示' })).toBeVisible()
  await expect.poll(async () => (await opens(page)).slice(before)).toEqual([PAGE_DOC])

  // Nothing of the page in the app: its script (which writes parent.__pwned and fetches the web) never ran here,
  // no frame was made, nothing left for the network.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined()
  await expect(page.locator('iframe, object, embed')).toHaveCount(0)
  expect(outside).toEqual([])
  expectNoPageErrors(state)
})
