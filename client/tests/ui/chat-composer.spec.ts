// The composer (ChatInput) wiring for the next-prompt suggestion, slash
// commands, attachments and locking, and the steering bubble in the
// transcript (tests/chat-composer-ui.tsx).
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
  await expect(page.locator('.cm-placeholder'), 'the placeholder comes back with the suggestion gone').toBeVisible()
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

const skill = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(name) })
const skills = (page: Page) => page.locator('button', { hasText: /^.+\/[a-z-]+/ })
const state = (page: Page) => page.getByTestId('composer-state')

test.describe('slash commands', () => {
  test('「/」 lists the skills; typing filters; ↓ and Tab pick one', async ({ page }) => {
    await openPreview(page, 'chat-composer', { suggestion: '' })
    await input(page).click()
    await page.keyboard.insertText('/')
    await expect(skills(page)).toHaveCount(3)
    await page.keyboard.insertText('pr')
    await expect(skills(page)).toHaveCount(2)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Tab')
    await typed(page).toBe('/press-release ')
    await expect(skills(page)).toHaveCount(0)
  })

  test('↓ wraps around and ↑ goes back; a click picks too', async ({ page }) => {
    await openPreview(page, 'chat-composer', { suggestion: '' })
    await input(page).click()
    await page.keyboard.insertText('/')
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(key)
    await page.keyboard.press('Tab')
    await typed(page).toBe('/press-release ')
    await page.keyboard.press('Meta+a')
    await page.keyboard.insertText('/')
    await skill(page, '提案書').click()
    await typed(page).toBe('/proposal ')
    await expect(skills(page)).toHaveCount(0)
  })

  test('Esc and leaving the input close the list and keep the text; Enter closes it and is a new line', async ({ page }) => {
    await openPreview(page, 'chat-composer', { suggestion: '' })
    await input(page).click()
    await page.keyboard.insertText('/mo')
    await expect(skills(page)).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(skills(page)).toHaveCount(0)
    await typed(page).toBe('/mo')
    await page.keyboard.insertText('n')
    await expect(skills(page)).toHaveCount(1)
    await page.locator('main p').first().click()
    await expect(skills(page)).toHaveCount(0)
    await input(page).click()
    await page.keyboard.press('End')
    await page.keyboard.insertText('t')
    await expect(skills(page)).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(skills(page)).toHaveCount(0)
    await expect(input(page).locator('.cm-line')).toHaveCount(2)
    await expect(sentBubble(page, '/mont')).toHaveCount(0)
  })
})

async function drop(page: Page, files: { paths?: string[]; images?: Array<{ name: string; size?: number }> }) {
  const data = await page.evaluateHandle(({ paths, images }) => {
    const dt = new DataTransfer()
    if (paths) dt.setData('application/x-file-paths', JSON.stringify(paths))
    for (const image of images ?? []) dt.items.add(new File([new Uint8Array(image.size ?? 4)], image.name, { type: 'image/png' }))
    return dt
  }, files)
  await input(page).locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]').dispatchEvent('drop', { dataTransfer: data })
}

test('dropped files and images wait above the input, can be taken off, and go out with the message; the parent always knows how many wait', async ({ page }) => {
  await openPreview(page, 'chat-composer', { suggestion: '' })
  await expect(state(page)).toHaveText('添付 0 件')
  await drop(page, { paths: ['営業部/提案書/A社.md', '営業部/価格表.xlsx'] })
  await expect(page.getByTitle('営業部/提案書/A社.md')).toHaveText(/A社\.md/)
  await expect(state(page)).toHaveText('添付 2 件')
  await drop(page, { paths: ['営業部/価格表.xlsx'] })
  await expect(state(page), 'a file already attached is not added twice').toHaveText('添付 2 件')
  await page.getByTitle('営業部/価格表.xlsx').getByRole('button').click()
  await expect(page.getByTitle('営業部/価格表.xlsx')).toHaveCount(0)
  await expect(state(page)).toHaveText('添付 1 件')

  await drop(page, { images: ['a', 'b', 'c', 'd', 'e'].map(n => ({ name: `${n}.png` })) })
  await expect(page.locator('img[alt$=".png"]')).toHaveCount(4)
  await expect(page.getByText('画像は最大4枚までです')).toBeVisible()
  await expect(state(page)).toHaveText('添付 5 件')
  await drop(page, { images: [{ name: 'big.png', size: 2 * 1024 * 1024 + 1 }] })
  await expect(page.getByText('1件の画像が2MBを超えています')).toBeVisible()
  await expect(state(page)).toHaveText('添付 5 件')

  await input(page).click()
  await page.keyboard.insertText('この資料で見積もって')
  await page.keyboard.press('Meta+Enter')
  await expect(sentBubble(page, 'この資料で見積もって')).toBeVisible()
  await expect(state(page)).toHaveText('添付 0 件／送信：画像 4 件、ファイル 営業部/提案書/A社.md')
  await expect(page.locator('img[alt$=".png"]')).toHaveCount(0)
  await expect(page.getByTitle('営業部/提案書/A社.md')).toHaveCount(0)
})

test('a locked input takes no typing and cannot send until the parent unlocks it', async ({ page }) => {
  await openPreview(page, 'chat-composer', { suggestion: '', disabled: '1' })
  await expect(input(page)).toHaveAttribute('contenteditable', 'false')
  await input(page).click()
  await page.keyboard.insertText('まだ打てない')
  await typed(page).toBe('')
  await page.getByRole('button', { name: '入力を有効にする' }).click()
  await expect(input(page)).toHaveAttribute('contenteditable', 'true')
  await input(page).click()
  await page.keyboard.insertText('打てる')
  await page.keyboard.press('Meta+Enter')
  await expect(sentBubble(page, '打てる')).toBeVisible()
})
