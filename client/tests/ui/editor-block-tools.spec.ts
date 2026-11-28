// The 「/」 list, the line starts, the empty line's hint and the table bar of a document edited in
// place (tests/editor-in-place-ui.tsx; files-and-editor.md "The 「/」 list, line starts and the table
// bar"): each written back as what the member made — the new lines only, a table's one row, or one
// cell on each of its lines for a column — with real keys; the list's keys are its own only while it shows.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

const ROOT = '/Users/demo/会社'
const DOC = `${ROOT}/営業部/定例メモ.md`
const TEXT = '# 定例\n\n予定を書きます。\n\n- 一つめ\n- 二つめ\n\n| 項目 | 数 |\n|------|---:|\n| 問い合わせ | 42 |\n\n終わりの段落です。\n'

const doc = (page: Page) => page.locator('[data-in-place-editor] .ProseMirror')
const menu = (page: Page) => page.getByRole('listbox', { name: '形を選ぶ' })
const tableBar = (page: Page) => page.getByRole('toolbar', { name: '表の操作' })
const files = (page: Page) => page.evaluate(() => (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles)
const appKeys = (page: Page) => page.evaluate(() => (window as unknown as { __acbAppKeys: string[] }).__acbAppKeys)

async function open(page: Page) {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await openPreview(page, 'editor-in-place')
  await reset(page)
}

/** The file as the AI would write it: with nothing edited, the document opens afresh on it. */
async function reset(page: Page) {
  await page.evaluate(([p, t]) => (window as unknown as { __acbExternalEdit: (p: string, t: string) => void }).__acbExternalEdit(p, t), [DOC, TEXT] as const)
  await expect(doc(page).getByText('予定を書きます。', { exact: true })).toBeVisible()
}

/** The caret at the end of the paragraph holding `words`, then Enter: a new empty line under it. */
async function newLineAfter(page: Page, words: string) {
  await doc(page).getByText(words, { exact: true }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
}

async function saved(page: Page) {
  await page.clock.runFor(1500)
  return (await files(page))[DOC]
}

const withLines = (lines: string) => TEXT.replace('予定を書きます。\n\n', `予定を書きます。\n\n${lines}\n\n`)
/** The new lines at the end (a list there is apart from the `-` list above: next to it, it would join it). */
const atEnd = (lines: string) => `${TEXT}\n${lines}\n`

test('「/」 on an empty line opens the list; typing narrows it, ↓ and Enter choose, and the file gets the new line only', async ({ page }) => {
  await open(page)
  await newLineAfter(page, '予定を書きます。')
  await page.keyboard.type('/')
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('option')).toHaveCount(10)
  await page.keyboard.type('見出し')
  await expect(menu(page).getByRole('option')).toHaveText([/見出し1/, /見出し2/, /見出し3/])
  await expect(menu(page).getByRole('option', { name: /見出し1/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(menu(page).getByRole('option', { name: /見出し2/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  await page.keyboard.type('議題')
  await expect(doc(page).getByRole('heading', { level: 2, name: '議題' })).toBeVisible()
  await expect.poll(() => saved(page)).toBe(withLines('## 議題'))
  // ↑ ↓ and Enter are the text's again: Enter makes a new line, not a choice.
  await page.keyboard.press('Enter')
  await page.keyboard.type('次の段落')
  await expect.poll(() => saved(page)).toBe(withLines('## 議題\n\n次の段落'))
})

test('each choice of the list is written as its Markdown: a checklist, a table typed into, a divider', async ({ page }) => {
  await open(page)
  await newLineAfter(page, '終わりの段落です。')
  await page.keyboard.type('/チェック')
  await page.keyboard.press('Enter')
  await page.keyboard.type('資料を送る')
  await expect.poll(() => saved(page)).toBe(atEnd('- [ ] 資料を送る'))

  await newLineAfter(page, '予定を書きます。')
  await page.keyboard.type('/表')
  await menu(page).getByRole('option', { name: /表/ }).click()
  await page.keyboard.type('名前')
  await expect.poll(() => saved(page)).toBe(atEnd('- [ ] 資料を送る').replace('予定を書きます。\n', '予定を書きます。\n\n| 名前 |   |   |\n| - | - | - |\n|   |   |   |\n|   |   |   |\n'))

  await newLineAfter(page, '予定を書きます。')
  await page.keyboard.type('/区切り')
  await page.keyboard.press('Enter')
  await expect(doc(page).locator('hr')).toHaveCount(1)
  await page.keyboard.type('下')
  await expect.poll(() => saved(page)).toBe(atEnd('- [ ] 資料を送る').replace('予定を書きます。\n', '予定を書きます。\n\n---\n\n下\n\n| 名前 |   |   |\n| - | - | - |\n|   |   |   |\n|   |   |   |\n'))
})

test('Esc closes the list and leaves the 「/」 as typed; with no list, Esc and Enter are not the list\'s', async ({ page }) => {
  await open(page)
  await newLineAfter(page, '予定を書きます。')
  await page.keyboard.type('/')
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  expect(await appKeys(page), 'Esc closed the list only').toEqual([])
  // The list is closed: Esc reaches the part around the editor, Enter is a new line.
  await page.keyboard.press('Escape')
  expect(await appKeys(page)).toEqual(['list.back'])
  await page.keyboard.press('Enter')
  await page.keyboard.type('次')
  await expect.poll(() => saved(page)).toBe(withLines('/\n\n次'))
})

test('the line starts: 「## 」「- 」「1. 」「[] 」「> 」「```」「---」 each become their block, written as typed', async ({ page }) => {
  const cases: Array<[string, string, string]> = [
    ['## ', '小見出し', '## 小見出し'],
    ['- ', '項目', '- 項目'],
    ['1. ', '一番', '1. 一番'],
    ['[] ', 'やること', '- [ ] やること'],
    ['> ', '引用です', '> 引用です'],
    ['```', 'ls', '```\nls\n```'],
  ]
  await open(page)
  for (const [start, words, written] of cases) {
    await reset(page)
    await newLineAfter(page, '終わりの段落です。')
    await page.keyboard.type(start)
    await page.keyboard.type(words)
    await expect.poll(() => saved(page), start).toBe(atEnd(written))
  }
  await reset(page)
  await newLineAfter(page, '予定を書きます。')
  await page.keyboard.type('---')
  await expect(doc(page).locator('hr')).toHaveCount(1)
  // The caret goes on below the divider.
  await page.keyboard.type('下の段落')
  await expect.poll(() => saved(page)).toBe(withLines('---\n\n下の段落'))
})

test('「[] 」 at the start of a list item makes that item a checklist item: its one line', async ({ page }) => {
  await open(page)
  await doc(page).getByText('二つめ', { exact: true }).click()
  await page.keyboard.press('Home')
  await page.keyboard.type('[] ')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('- 二つめ', '- [ ] 二つめ'))
})

test('the empty line the caret is in says 「「/」で形を選べます」 quietly; the file is not changed by it', async ({ page }) => {
  await open(page)
  await newLineAfter(page, '予定を書きます。')
  const line = doc(page).locator('p.acb-empty-line')
  await expect(line).toHaveCount(1)
  expect(await line.evaluate(el => getComputedStyle(el, '::before').content)).toBe('"「/」で形を選べます"')
  await page.keyboard.type('書いた')
  await expect(line).toHaveCount(0)
  await page.clock.runFor(1500)
  expect((await files(page))[DOC]).toBe(withLines('書いた'))
})

test('the table bar: a row is one new line, a column one cell on each line; the header row cannot be deleted', async ({ page }) => {
  await open(page)
  await doc(page).getByText('問い合わせ', { exact: true }).click()
  await expect(tableBar(page)).toBeVisible()
  await tableBar(page).getByRole('button', { name: '行を足す' }).click()
  await expect.poll(() => saved(page)).toBe(TEXT.replace('| 問い合わせ | 42 |\n', '| 問い合わせ | 42 |\n|  |  |\n'))
  // Typed into the new row's first cell: that cell only.
  await page.keyboard.type('商談')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('| 問い合わせ | 42 |\n', '| 問い合わせ | 42 |\n| 商談 |  |\n'))
  await tableBar(page).getByRole('button', { name: '列を足す' }).click()
  await expect.poll(() => saved(page)).toBe(TEXT
    .replace('| 項目 | 数 |\n|------|---:|\n| 問い合わせ | 42 |\n', '| 項目 |  | 数 |\n|------|---|---:|\n| 問い合わせ |  | 42 |\n| 商談 |  |  |\n'))
  // The caret is in the new column's cell of its row: both taken away again.
  await tableBar(page).getByRole('button', { name: '列を消す' }).click()
  await tableBar(page).getByRole('button', { name: '行を消す' }).click()
  await expect.poll(() => saved(page)).toBe(TEXT)
  await doc(page).getByText('項目', { exact: true }).click()
  await expect(tableBar(page).getByRole('button', { name: '行を消す' })).toBeDisabled()
  await expect(tableBar(page).getByRole('button', { name: '列を消す' })).toBeEnabled()
  // Outside the table, no bar.
  await doc(page).getByText('終わりの段落です。', { exact: true }).click()
  await expect(tableBar(page)).toHaveCount(0)
})
