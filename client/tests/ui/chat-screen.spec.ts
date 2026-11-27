// Owner FB 2026-11-27 (「AI への相談」 の画面が最悪): the consultation screen made as quiet as the Claude and
// ChatGPT apps. Guards, each on the real ChatPanel (tests/chat-header-ui.tsx):
// - the list of consultations starts closed (open, it darkened and hid the conversation in a narrow pane);
// - the header holds the list toggle, the consultation's name, its state, ＋ and 「…」 only — no model,
//   effort, meter or agent badge — and at every pane width (280–720 px) nothing overlaps or leaves the pane;
// - the model and 「考える強さ」 are one switch beside the input, never clipped (「Mediu」), changed from its menu;
// - 「引き継ぎメモ」 shows only once a memo exists, and opens from 「…」 before that;
// - how to send is said once (the input's placeholder); the voice input's explanation is its tooltip;
// - the AI's reply is plain text (no bubble); the member's own words a quiet bubble.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const composer = (page: Page) => page.locator('[data-composer-drop]').locator('visible=true')
const modelSwitch = (page: Page) => composer(page).getByRole('button', { name: /^モデルと考える強さ：/ })

type Box = { name: string; left: number; right: number }
async function headerControls(page: Page): Promise<{ header: Box; items: Box[] }> {
  return page.locator('header').first().evaluate(h => {
    const box = (e: Element, name: string) => { const r = e.getBoundingClientRect(); return { name, left: r.left, right: r.right } }
    const items = [...h.querySelectorAll('button, select, h2, [role="status"]')]
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => box(e, e.getAttribute('aria-label') || e.textContent || e.tagName))
    return { header: box(h, 'header'), items }
  })
}
function expectInsideWithoutOverlap({ header, items }: { header: Box; items: Box[] }) {
  for (const c of items) {
    expect(c.left, `${c.name} starts inside the header`).toBeGreaterThanOrEqual(header.left - 0.5)
    expect(c.right, `${c.name} ends inside the header`).toBeLessThanOrEqual(header.right + 0.5)
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const overlap = Math.min(items[i].right, items[j].right) - Math.max(items[i].left, items[j].left)
      expect(overlap, `${items[i].name} and ${items[j].name} do not overlap`).toBeLessThanOrEqual(0.5)
    }
  }
}
/** The switch's whole label is drawn: nothing clipped by its own box or by the pane. */
async function expectWhole(page: Page) {
  const pane = (await page.locator('header').first().boundingBox())!
  const sw = modelSwitch(page)
  await expect(sw).toBeVisible()
  const box = (await sw.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(pane.x - 0.5)
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5)
  const clipped = await sw.evaluate(button => [button, ...button.querySelectorAll('span')].some(e => e.scrollWidth > e.clientWidth + 0.5))
  expect(clipped, 'the model switch\'s label is not cut off').toBe(false)
  // Every control of the input's row (voice, meter, switch, send) stays inside the pane: the row wraps instead.
  for (const control of await composer(page).getByRole('button').all()) {
    const b = await control.boundingBox()
    if (!b || b.width === 0) continue
    const name = await control.getAttribute('aria-label')
    expect(b.x, `${name} starts inside the pane`).toBeGreaterThanOrEqual(pane.x - 0.5)
    expect(b.x + b.width, `${name} ends inside the pane`).toBeLessThanOrEqual(pane.x + pane.width + 0.5)
  }
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }) })

test('the list of consultations starts closed and opens beside the conversation from the header', async ({ page }) => {
  const state = await openPreview(page, 'chat-header')
  const toggle = page.getByRole('banner').getByRole('button', { name: 'AIへの相談の一覧を開閉' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('complementary', { name: 'AIへの相談' })).toHaveCount(0)
  await toggle.click()
  await expect(page.getByRole('complementary', { name: 'AIへの相談' })).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(page.getByRole('complementary', { name: 'AIへの相談' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a narrow pane is not darkened at the start: the conversation and its input are usable', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { width: '360' })
  await expect(page.getByRole('button', { name: 'AIへの相談の一覧を閉じる' })).toHaveCount(0)
  await composer(page).locator('.cm-content[role="textbox"]').click()
  await page.keyboard.insertText('見積書を作って')
  await expect(composer(page)).toContainText('見積書を作って')
  expectNoPageErrors(state)
})

test('the header shows the consultation\'s name, ＋ and 「…」 — no model, effort, meter or agent badge', async ({ page }) => {
  const state = await openPreview(page, 'chat-header')
  const banner = page.getByRole('banner')
  await expect(banner.getByRole('heading', { name: '新しい相談' })).toBeVisible()
  await expect(banner.getByRole('button', { name: '新しい相談' })).toBeVisible()
  await expect(banner.getByRole('button', { name: 'その他の操作' })).toBeVisible()
  await expect(banner.getByRole('combobox')).toHaveCount(0)
  await expect(banner.getByRole('button', { name: /^利用上限|^モデル/ })).toHaveCount(0)
  await expect(banner).not.toContainText(/Opus|Medium|Claude/)
  // What left the header stays reachable in 「…」.
  await banner.getByRole('button', { name: 'その他の操作' }).click()
  const menu = page.locator('.fixed.z-menu')
  for (const name of ['引き継ぎメモ', 'プレーン表示に切り替える', '相談の設定（使う AI）']) await expect(menu.getByRole('button', { name })).toBeVisible()
  await menu.getByRole('button', { name: '相談の設定（使う AI）' }).click()
  await expect(page.getByRole('dialog', { name: '相談の設定' })).toBeVisible()
  expectNoPageErrors(state)
})

for (const width of [280, 320, 360, 420, 520, 720]) {
  test(`at ${width} px the header's controls fit the pane and the model switch is whole`, async ({ page }) => {
    const state = await openPreview(page, 'chat-header', { width: String(width) })
    expectInsideWithoutOverlap(await headerControls(page))
    await expectWhole(page)
    await expect(modelSwitch(page)).toHaveAccessibleName('モデルと考える強さ：Opus 5.5・Medium')
    // A running turn adds its state and stop: still nothing overlaps.
    await composer(page).locator('.cm-content[role="textbox"]').click()
    await page.keyboard.insertText('見積書を作って')
    await page.keyboard.press('Meta+Enter')
    await expect(page.getByRole('banner').getByRole('button', { name: '停止' })).toBeVisible()
    expectInsideWithoutOverlap(await headerControls(page))
    await expectWhole(page)
    expectNoPageErrors(state)
  })
}

test('the model and 考える強さ are changed from the one switch beside the input', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { width: '320' })
  await modelSwitch(page).click()
  const menu = page.getByRole('menu', { name: 'モデルと考える強さ' })
  await expect(menu.getByRole('menuitemradio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true')
  await menu.getByRole('menuitemradio', { name: 'High', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(modelSwitch(page)).toHaveAccessibleName('モデルと考える強さ：Opus 5.5・High')
  await expectWhole(page)
  // Keys: ↓ moves through the choices, Esc closes.
  await modelSwitch(page).click()
  await page.getByRole('menuitemradio', { name: 'Opus 5.5' }).focus()
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => page.evaluate(() => document.activeElement?.previousElementSibling?.textContent), 'the next choice has focus').toBe('Opus 5.5')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'モデルと考える強さ' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('Codex: its models and efforts are in the same switch, whole at the narrowest pane', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { width: '280', agent: 'codex' })
  await expectWhole(page)
  await modelSwitch(page).click()
  await expect(page.getByRole('group', { name: 'モデル' }).getByRole('menuitemradio', { checked: true })).toHaveCount(1)
  await expect(page.getByRole('group', { name: '考える強さ' }).getByRole('menuitemradio', { checked: true })).toHaveCount(1)
  expectNoPageErrors(state)
})

test('「引き継ぎメモ」 shows only once a memo exists; before that it opens from 「…」', async ({ page }) => {
  const state = await openPreview(page, 'chat-header')
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByText(/引き継ぎメモ：/)).toHaveCount(0)
  await page.getByRole('banner').getByRole('button', { name: 'その他の操作' }).click()
  await page.locator('.fixed.z-menu').getByRole('button', { name: '引き継ぎメモ' }).click()
  await expect(page.getByRole('heading', { name: '引き継ぎメモ' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'メモはまだありません。' })).toBeVisible()
  expectNoPageErrors(state)
})

test('a consultation with a memo shows its line under the header', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { handoff: 'saved' })
  await expect(page.getByRole('button', { name: '引き継ぎメモを確認' })).toContainText(/引き継ぎメモ：.*保存/)
  expectNoPageErrors(state)
})

test('how to send is said once, in the input; the voice input explains itself in its tooltip only', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { voice: '1' })
  const box = composer(page)
  await expect(box.locator('.cm-placeholder')).toHaveText(/⌘\+Enter で送信/)
  // No second line about Enter under or beside the input, and no voice hints on the screen.
  const shown = await box.evaluate(root => {
    const texts: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!
      if (el.closest('.sr-only') || el.getBoundingClientRect().width === 0) continue
      texts.push(n.textContent ?? '')
    }
    return texts.join('|')
  })
  expect(shown.match(/Enter/g) ?? []).toHaveLength(1)
  expect(shown).not.toMatch(/1回押すと開始|話した内容を|音声入力/)
  const voice = box.getByRole('button', { name: '音声入力を開始' })
  await expect(voice).toHaveAttribute('title', /1回押すと開始・もう1回で停止/)
  expectNoPageErrors(state)
})

test('the AI\'s reply is plain text without a bubble; the member\'s words are a quiet bubble', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { history: 'edit' })
  const reply = page.locator('[data-assistant-text]').first()
  await expect(reply).toBeVisible()
  const look = await reply.evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow, padding: s.paddingLeft } })
  expect(look).toEqual({ bg: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none', padding: '0px' })
  const bubble = page.locator('[data-user-bubble]').first()
  const own = await bubble.evaluate(el => {
    const s = getComputedStyle(el)
    const sunken = getComputedStyle(document.documentElement).getPropertyValue('--color-surface-sunken-rgb').trim().split(/\s+/).join(', ')
    return { bg: s.backgroundColor, sunken: `rgb(${sunken})` }
  })
  expect(own.bg, 'the member\'s bubble is the quiet sunken surface, not the primary blue').toBe(own.sunken)
  expectNoPageErrors(state)
})

test('tool rows are readable at once: no fade on the rows, text at least 4.5:1 on the page', async ({ page }) => {
  const state = await openPreview(page, 'tool-rows')
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __toolRowsResult?: unknown }).__toolRowsResult), { timeout: 20_000 }).toBe(true)
  const rows = page.locator('#message button').filter({ hasText: /手分けした作業|コマンドを/ })
  await expect(rows.first()).toBeVisible()
  const looks = await rows.evaluateAll(buttons => buttons.slice(0, 12).map(button => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const lum = ([r, g, b]: number[]) => [r, g, b].map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    let bgEl: Element | null = button
    while (bgEl && getComputedStyle(bgEl).backgroundColor === 'rgba(0, 0, 0, 0)') bgEl = bgEl.parentElement
    const bg = rgb(bgEl ? getComputedStyle(bgEl).backgroundColor : 'rgb(255, 255, 255)')
    const label = [...button.querySelectorAll('span')].find(s => (s.textContent ?? '').trim().length > 0)!
    const fg = rgb(getComputedStyle(label).color)
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
    let faded = false
    for (let e: Element | null = button; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) < 1 || e.getAnimations().length > 0) faded = true
    return { text: label.textContent, contrast: (hi + 0.05) / (lo + 0.05), faded }
  }))
  for (const look of looks) {
    expect(look.faded, `${look.text}: drawn at full strength, no fade`).toBe(false)
    expect(look.contrast, `${look.text}: readable on the page`).toBeGreaterThanOrEqual(4.5)
  }
  expectNoPageErrors(state)
})
