// The selection bubble of a document edited in place (tests/editor-in-place-ui.tsx;
// files-and-editor.md "The selection bubble"): decorations, size and link by button and by key,
// each written back as its one line; ［コメント］ through the screen's comment box into the review's
// own sidecar file.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

const ROOT = '/Users/demo/会社'
const DOC = `${ROOT}/営業部/定例メモ.md`
const TEXT = '# 定例\n\n予定を書きます。来週は研修です。\n\n- 一つめ\n- 二つめ\n'

const doc = (page: Page) => page.locator('[data-in-place-editor] .ProseMirror')
const bubble = (page: Page) => page.getByRole('toolbar', { name: '選んだ文字の飾り' })
const files = (page: Page) => page.evaluate(() => (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles)

async function open(page: Page) {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await openPreview(page, 'editor-in-place')
  await page.evaluate(([p, t]) => (window as unknown as { __acbExternalEdit: (p: string, t: string) => void }).__acbExternalEdit(p, t), [DOC, TEXT] as const)
  await expect(doc(page).getByRole('heading', { name: '定例' })).toBeVisible()
}

/** Selects `words` (their first occurrence) in the document, as a drag would. */
async function select(page: Page, words: string) {
  await doc(page).click()
  await page.evaluate((text) => {
    const root = document.querySelector('[data-in-place-editor] .ProseMirror')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(text)
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(n, i)
      range.setEnd(n, i + text.length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      return
    }
    throw new Error(`not found: ${text}`)
  }, words)
}

async function saved(page: Page) {
  await page.clock.runFor(1500)
  return (await files(page))[DOC]
}

test('selecting words shows one bubble; 太字 is pressed, written as `**…**` on its line only, and pressed again comes off', async ({ page }) => {
  await open(page)
  await select(page, '来週は研修です')
  await expect(bubble(page)).toBeVisible()
  await bubble(page).getByRole('button', { name: '太字' }).click()
  await expect(bubble(page).getByRole('button', { name: '太字' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('来週は研修です', '**来週は研修です**'))
  await bubble(page).getByRole('button', { name: '太字' }).click()
  await expect.poll(() => saved(page)).toBe(TEXT)
})

test('the keys do the same: ⌘I, ⌘⇧S, ⌘E, and ⌘⌥2 / ⌘⌥0 for the size', async ({ page }) => {
  await open(page)
  await select(page, '予定')
  await page.keyboard.press('ControlOrMeta+i')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('予定を', '*予定*を'))
  await select(page, '一つめ')
  await page.keyboard.press('ControlOrMeta+Shift+s')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('予定を', '*予定*を').replace('- 一つめ', '- ~~一つめ~~'))
  await select(page, '二つめ')
  await page.keyboard.press('ControlOrMeta+e')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('予定を', '*予定*を').replace('- 一つめ', '- ~~一つめ~~').replace('- 二つめ', '- `二つめ`'))
  await select(page, '定例')
  await page.keyboard.press('ControlOrMeta+Alt+2')
  await expect.poll(() => saved(page)).toContain('## 定例\n')
  await page.keyboard.press('ControlOrMeta+Alt+0')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('# 定例\n', '定例\n').replace('予定を', '*予定*を').replace('- 一つめ', '- ~~一つめ~~').replace('- 二つめ', '- `二つめ`'))
})

test('文字の大きさ from the bubble: a paragraph becomes 見出し2, its one line', async ({ page }) => {
  await open(page)
  await select(page, '来週')
  await bubble(page).getByRole('button', { name: /本文/ }).click()
  await page.getByRole('menuitemradio', { name: /見出し2/ }).click()
  await expect.poll(() => saved(page)).toBe(TEXT.replace('予定を書きます。来週は研修です。', '## 予定を書きます。来週は研修です。'))
})

test('a link: ⌘K asks for the address, ［付ける］ links the words; the bubble on a link takes it off', async ({ page }) => {
  await open(page)
  await select(page, '研修')
  await page.keyboard.press('ControlOrMeta+k')
  const field = page.getByRole('textbox', { name: 'リンク先' })
  await expect(field).toBeFocused()
  await field.fill('https://example.com/kensyu')
  await page.getByRole('button', { name: '付ける' }).click()
  await expect.poll(() => saved(page)).toBe(TEXT.replace('研修です', '[研修](https://example.com/kensyu)です'))
  await select(page, '研修')
  await bubble(page).getByRole('button', { name: 'リンクを外す' }).click()
  await expect.poll(() => saved(page)).toBe(TEXT)
})

test('［コメント］ opens the review\'s comment box; sent, it is the member\'s own review file and the document is read with its comment', async ({ page }) => {
  await open(page)
  await select(page, '来週は研修です')
  await bubble(page).getByRole('button', { name: 'コメント' }).click()
  await expect(page.getByTestId('comment-quote')).toHaveText('来週は研修です')
  await page.locator('textarea').fill('日付を書いてください')
  await page.keyboard.press('ControlOrMeta+Enter')
  // The review file, in the shape 「レビューする」 + a comment writes (files-and-editor.md "Document review").
  await expect.poll(async () => Object.keys(await files(page)).filter(p => p.startsWith(`${DOC}.review.`))).toHaveLength(1)
  const all = await files(page)
  const name = Object.keys(all).find(p => p.startsWith(`${DOC}.review.`))!
  expect(name).toMatch(/\.review\.[0-9a-f-]{36}\.json$/)
  const stored = JSON.parse(all[name])
  expect(Object.keys(stored)).toEqual(['version', 'review'])
  expect(Object.keys(stored.review)).toEqual(['id', 'reviewerName', 'reviewerEmail', 'status', 'createdAt', 'completedAt', 'comments'])
  expect(stored.review).toMatchObject({ reviewerName: '山田', reviewerEmail: 'demo@example.com', status: 'in_progress', completedAt: null })
  expect(Object.keys(stored.review.comments[0])).toEqual(['id', 'authorName', 'severity', 'selectedText', 'startOffset', 'endOffset', 'body', 'createdAt', 'resolved', 'replies'])
  expect(stored.review.comments[0]).toMatchObject({ selectedText: '来週は研修です', body: '日付を書いてください', startOffset: TEXT.indexOf('来週は研修です'), endOffset: TEXT.indexOf('来週は研修です') + 7 })
  // The document itself is not changed, and it now shows as reviewed: its comment beside it.
  expect(all[DOC]).toBe(TEXT)
  await expect(page.getByText('日付を書いてください')).toBeVisible()
  await expect(page.locator('[data-in-place-editor]')).toHaveCount(0)
})

test('⌘B and ⌘K are the document\'s only while its words have the focus; elsewhere they stay the app\'s', async ({ page }) => {
  await open(page)
  const appKeys = () => page.evaluate(() => (window as unknown as { __acbAppKeys: string[] }).__acbAppKeys)
  await select(page, '来週')
  await page.keyboard.press('ControlOrMeta+b')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('来週', '**来週**'))
  expect(await appKeys()).toEqual([])
  // The caret alone: ⌘K is 探す (no link to make).
  await doc(page).click()
  await page.keyboard.press('ControlOrMeta+k')
  // The focus in the editor's area but not in the document (its frame, as after closing a tab): ⌘B is the left column.
  await page.locator('[data-command-area="editor"]').first().focus()
  await page.keyboard.press('ControlOrMeta+b')
  expect(await appKeys()).toEqual(['find.byName', 'layout.toggleLeft'])
  expect(await saved(page)).toBe(TEXT.replace('来週', '**来週**'))
})

test('on a Mac, Ctrl+B / Ctrl+E in the document stay the text\'s own keys (back a character, end of line); only ⌘ formats', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
  await open(page)
  await select(page, '来週')
  await page.keyboard.press('Control+b')
  await page.keyboard.press('Control+e')
  await page.clock.runFor(1500)
  expect((await files(page))[DOC]).toBe(TEXT)
  await select(page, '来週')
  await page.keyboard.press('Meta+b')
  await expect.poll(() => saved(page)).toBe(TEXT.replace('来週', '**来週**'))
})
