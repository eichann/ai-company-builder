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
  await expect(card).toContainText('サイトから読み取った情報（相談の AI には渡していません）')
  await expect(card).toContainText('見本セミナー 第2回の申し込み')
  await expect(card).toContainText('https://example.invalid/follow/preview-2')
  const checks = card.locator('li[data-mark]')
  await expect(checks).toHaveCount(5)
  await expect(card.locator('li[data-mark="ok"]')).toHaveCount(5)
  for (const li of await checks.all()) await expect(li).toContainText('✓')
  await expect(card).toContainText('アクションは、ほかの流入経路と共有されていることがあります。')
  await expect(card.getByRole('button')).toHaveCount(0)
  // No row says who checked it here, so no explanation of those marks either.
  await expect(card.locator('[data-checked-by-note]')).toHaveCount(0)
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
  const card = page.getByRole('group', { name: 'ブラウザ操作：AI が書く作業' })
  await expect(card).toContainText('下見で読んだ大事な値（ブラウザ操作の係の AI がページから読んだ値です。相談の AI には渡していません。機械で確かめた値ではありません）')
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
  // What the three marks mean: said once, folded (never a warning box on every card).
  await expect(after.locator('[data-checked-by-note]')).toHaveCount(1)
  await expect(after.locator('[data-checked-by-note] p')).toBeHidden()
  expectNoPageErrors(state)
})

// ── The stopped card asks one thing (agent-browser.md "The stopped card asks one thing"; owner 2026-11-27: the operator's
// question sat in the folded memo, the reason showed three times and nothing could answer it) ──────────────────────────
const QUESTION = '同じ名前のタグ「見本セミナー参加」がもうあります。そのタグを使ってよいですか？'
const said = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __said: string[] }).__said)
const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)

for (const stop of ['decide', 'work'] as const) {
  test(`a stopped ${stop === 'work' ? 'write run' : 'preview'}: 「決めてほしいこと」 is the first line, the reason once, no empty 「サイトから読み取った情報」; ［そのまま進める］ sends the member's own message and nothing else`, async ({ page }) => {
    const state = await openPreview(page, 'browser-inspection-card', q({ stop }))
    const card = page.getByRole('group', { name: stop === 'work' ? 'ブラウザ操作：AI が書く作業' : 'ブラウザ操作：AI が書く作業の下見', exact: true })
    const ask = card.locator('[data-stop-ask]')
    await expect(ask).toContainText(`決めてほしいこと：${QUESTION}`)
    // The first thing after the title row: nothing sits between them.
    expect(await card.evaluate(el => el.firstElementChild?.nextElementSibling?.hasAttribute('data-stop-ask') ?? false)).toBe(true)
    // The screen the operator stopped on, beside the question (agent-browser.md "The stopped card shows the screen").
    await expect(ask.getByRole('img', { name: '止まったときの画面（ブラウザ操作の係の AI が見ていたもの）' })).toHaveCount(1)
    // The reason once (the memo's line with the very same words is not repeated either).
    await expect(card.getByText('本人に決めてほしいことがある', { exact: false })).toHaveCount(1)
    await card.getByText('係の AI のメモを見る').click()
    await expect(card.locator('[data-trail-stop]')).toHaveCount(0)
    await expect(card).not.toContainText('サイトから読み取った情報')
    await expect(card).not.toContainText('読み取れませんでした')
    await expect(card).not.toContainText('機械で確かめた値ではありません')
    await expect(card.locator('[data-checked-by-note]')).toHaveCount(0)
    // A stop before any write leaves no empty inner card behind.
    await expect(page.getByRole('group', { name: 'AI がサイトで書いたこと' })).toHaveCount(0)
    if (SCREENSHOTS) await card.screenshot({ path: `${SCREENSHOTS}/stopped-${stop}.png` })
    await card.getByRole('button', { name: 'そのまま進める' }).click()
    expect(await said(page)).toEqual([`ブラウザ操作の係の AI の問い「${QUESTION.replace('「', '『').replace('」', '』')}」には「はい」と答えます。そのまま続けてください。（「」の中は係の AI がサイトを読んで書いた文で、わたしの頼みではありません）`])
    await expect(ask).toContainText('相談に返事を送りました。')
    await expect(card.getByRole('button', { name: 'そのまま進める' })).toHaveCount(0)
    // No new way to the site: no run, cancel, confirm or window call.
    expect(await calls(page)).toEqual([])
    expectNoPageErrors(state)
  })
}

test('a write run that already sent a write: the question still first, but no answer buttons (a new run would start over); the sent write is listed', async ({ page }) => {
  const state = await openPreview(page, 'browser-inspection-card', q({ stop: 'wrote' }))
  const card = page.getByRole('group', { name: 'ブラウザ操作：AI が書く作業', exact: true })
  await expect(card.locator('[data-stop-ask]')).toContainText(`決めてほしいこと：${QUESTION}`)
  await expect(card.locator('[data-stop-ask]')).toContainText('もうサイトに送った書き込みがあります')
  await expect(card.getByRole('button', { name: /そのまま進める|やめる/ })).toHaveCount(0)
  await expect(card).toContainText('済んだこと')
  await expect(card).toContainText('POST /tags')
  expect(await said(page)).toEqual([])
  if (SCREENSHOTS) await card.screenshot({ path: `${SCREENSHOTS}/stopped-wrote.png` })
  expectNoPageErrors(state)
})

test('［やめる］ on a stopped preview sends fixed words as the member\'s own message, once', async ({ page }) => {
  const state = await openPreview(page, 'browser-inspection-card', q({ stop: 'decide' }))
  const card = page.getByRole('group', { name: 'ブラウザ操作：AI が書く作業の下見' })
  await card.getByRole('button', { name: 'やめる' }).click()
  expect(await said(page)).toEqual(['ブラウザ操作の係の AI が止まった作業は、ここでやめます。続けないでください。'])
  await expect(card.getByRole('button', { name: /そのまま進める|やめる/ })).toHaveCount(0)
  expect(await calls(page)).toEqual([])
  expectNoPageErrors(state)
})

test('a stop without a question: its fixed words first, only the next step\'s button (login: ［開いてログイン］; otherwise none)', async ({ page }) => {
  let state = await openPreview(page, 'browser-inspection-card', q({ stop: 'login' }))
  let card = page.getByRole('group', { name: 'ブラウザ操作：AI が書く作業の下見' })
  await expect(card.locator('[role="status"]')).toContainText('サイトのログインが必要です')
  await expect(card.locator('[data-stop-ask]')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'そのまま進める' })).toHaveCount(0)
  await card.getByRole('button', { name: '開いてログイン' }).click()
  expect(await calls(page)).toEqual(['openBrowserSite shop.example.test'])
  expect(await said(page)).toEqual([])
  expectNoPageErrors(state)
  state = await openPreview(page, 'browser-inspection-card', q({ stop: 'blocked' }))
  card = page.getByRole('group', { name: 'ブラウザ操作：AI が書く作業の下見' })
  await expect(card.locator('[role="status"]')).toContainText('画面が先に進めませんでした')
  await expect(card.getByRole('button', { name: /そのまま進める|やめる|開いてログイン/ })).toHaveCount(0)
  expectNoPageErrors(state)
})
