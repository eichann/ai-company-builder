// The composer (ChatInput) wiring for the next-prompt suggestion, and the
// steering bubble in the transcript (tests/chat-composer-ui.tsx).
// The ghost-text rules themselves (typing along, other text, IME, caret) are
// pinned by tests/prompt-suggestion.test.ts; here only what a component split
// can break: the ghost widget and its ARIA wiring, keys reaching the editor,
// the parent's callbacks (send / suggestion cleared) and the hint line.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

const SUGGESTION = 'はい、本文まで書いてください'
const input = (page: Page) => page.locator('.cm-content[role="textbox"]')
/** What the member typed: the editor's lines without the placeholder / ghost widgets. */
const typed = (page: Page) => expect.poll(() => input(page).evaluate(content => {
  const copy = content.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.cm-placeholder, .cm-ghost-suggestion, .cm-widgetBuffer').forEach(node => node.remove())
  return [...copy.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')
}))
const ghost = (page: Page) => page.locator('.cm-ghost-suggestion')
const suggestionHint = (page: Page) => page.getByText('→ または Tab で候補を入力 • Esc で消す • ⌘+Enter で送信')
const sentBubble = (page: Page, text: string) => page.locator('main .bg-accent', { hasText: text })

test('the suggestion is ghost text in the empty input, described to screen readers, with its hint', async ({ page }) => {
  await openPreview(page, 'chat-composer')
  await expect(ghost(page)).toHaveText(SUGGESTION)
  await expect(ghost(page)).toHaveAttribute('aria-hidden', 'true')
  const describedBy = await input(page).getAttribute('aria-describedby')
  expect(describedBy, 'the input points at the suggestion description').toBeTruthy()
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(`入力候補：${SUGGESTION}。→キーまたはTabキーで入力欄に入れます。Escキーで消します。`)
  await expect(suggestionHint(page)).toBeVisible()
})

for (const key of ['ArrowRight', 'Tab'] as const) {
  test(`${key} puts the suggestion into the input; ⌘+Enter sends it`, async ({ page }) => {
    await openPreview(page, 'chat-composer')
    await input(page).click()
    await page.keyboard.press(key)
    await typed(page).toBe(SUGGESTION)
    await expect(ghost(page)).toHaveCount(0)
    await expect(sentBubble(page, SUGGESTION)).toHaveCount(0)
    await page.keyboard.press('Meta+Enter')
    await expect(sentBubble(page, SUGGESTION)).toBeVisible()
    await typed(page).toBe('')
  })
}

test('Esc dismisses the suggestion and the parent drops its hint', async ({ page }) => {
  await openPreview(page, 'chat-composer')
  await input(page).click()
  await page.keyboard.press('Escape')
  await expect(ghost(page)).toHaveCount(0)
  await expect(suggestionHint(page)).toHaveCount(0)
  await expect(page.getByText('入力候補：')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await typed(page).toBe('')
})

test('Enter is a new line; ⌘+Enter sends what was typed', async ({ page }) => {
  await openPreview(page, 'chat-composer', { suggestion: '' })
  await expect(page.locator('.cm-placeholder')).toBeVisible()
  await input(page).click()
  await page.keyboard.insertText('一行目')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('二行目')
  await expect(input(page).locator('.cm-line')).toHaveCount(2)
  await expect(sentBubble(page, '一行目')).toHaveCount(0)
  await page.keyboard.press('Meta+Enter')
  await expect(sentBubble(page, '一行目')).toContainText('二行目')
})

test('an instruction added while the AI worked is shown where it was taken, between the tool rows', async ({ page }) => {
  await openPreview(page, 'chat-composer')
  await expect(page.getByText('作業中に追加した指示')).toBeVisible()
  const order = await page.locator('main').evaluate(main => {
    const text = (main as HTMLElement).innerText
    return [text.indexOf('Read'), text.indexOf('作業中に追加した指示'), text.lastIndexOf('Read'), text.indexOf('承知しました')]
  })
  expect(order[0]).toBeGreaterThanOrEqual(0)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  await expect(page.getByRole('button', { name: 'Read' })).toHaveCount(2)
})
