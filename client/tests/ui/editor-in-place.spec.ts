// A Markdown document read and edited in the same view (tests/editor-in-place-ui.tsx;
// files-and-editor.md "Editing a document in place"). What the file gets byte for byte is held by
// src/features/editor/markdownSplice.test.ts; here: the real keyboard, autosave, the watcher, closing.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const ROOT = '/Users/demo/会社'
const MEETING = `${ROOT}/営業部/定例メモ.md`

const doc = (page: Page) => page.locator('[data-in-place-editor] .ProseMirror')
const files = (page: Page) => page.evaluate(() => (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles)
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __acbWrites: Array<[string, string]> }).__acbWrites)
const shortcut = (page: Page, init: { key: string; shiftKey?: boolean }) => page.evaluate((i) => {
  (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', { ...i, metaKey: true, bubbles: true, cancelable: true }))
}, init)

/** Puts the caret right after the first `after` in the document. */
async function caretAfter(page: Page, after: string) {
  await doc(page).click()
  await page.evaluate((text) => {
    const root = document.querySelector('[data-in-place-editor] .ProseMirror')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(text)
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(n, i + text.length)
      range.collapse(true)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      return
    }
    throw new Error(`not found: ${text}`)
  }, after)
}

async function open(page: Page, query: Record<string, string> = {}) {
  const state = await openPreview(page, 'editor-in-place', query)
  return state
}

test('a Markdown document opens as the document, editable in place; typing changes only that line of the file', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  const state = await open(page)
  await expect(doc(page).getByRole('heading', { name: '営業部 定例ミーティング' })).toBeVisible()
  await expect(doc(page)).toHaveAttribute('contenteditable', 'true')
  // The frontmatter is the quiet box, not editable text; the table and the list are drawn.
  await expect(page.getByRole('note', { name: 'このファイルの情報' })).toHaveCount(0)
  await expect(doc(page).locator('table')).toContainText('問い合わせ')
  const before = (await files(page))[MEETING]

  await caretAfter(page, '送る前に田中さんが')
  await page.keyboard.type('必ず')
  await caretAfter(page, '問い合わせ')
  await page.keyboard.type('数')
  await page.clock.runFor(1500)
  await expect.poll(async () => (await files(page))[MEETING]).not.toBe(before)
  const after = (await files(page))[MEETING]
  expect(after).toBe(before.replace('送る前に田中さんが', '送る前に田中さんが必ず').replace('| 問い合わせ |', '| 問い合わせ数 |'))
  expectNoPageErrors(state)
})

test('Enter in a nested list adds one line in the list\'s own indentation and marker, nothing else changes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  const before = (await files(page))[MEETING]
  await caretAfter(page, '送る前に田中さんが確認する')
  await page.keyboard.press('Enter')
  await page.keyboard.type('請求書も送る')
  await page.clock.runFor(1500)
  await expect.poll(async () => (await files(page))[MEETING]).not.toBe(before)
  expect((await files(page))[MEETING]).toBe(before.replace('    * 送る前に田中さんが確認する\n', '    * 送る前に田中さんが確認する\n    * 請求書も送る\n'))
})

test('Enter in a `-` list and at the end of a paragraph: the empty line writes nothing, the typed text is its own line', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await page.evaluate(p => (window as unknown as { __acbExternalEdit: (p: string, t: string) => void }).__acbExternalEdit(p, '- 項目一\n- 項目二\n\n終わりの段落です。\n'), MEETING)
  await expect(doc(page)).toContainText('終わりの段落です。')
  await caretAfter(page, '項目一')
  await page.keyboard.press('Enter')
  await page.clock.runFor(1500)
  expect((await files(page))[MEETING]).toBe('- 項目一\n- 項目二\n\n終わりの段落です。\n')
  await page.keyboard.type('新')
  await caretAfter(page, '終わりの段落です。')
  await page.keyboard.press('Enter')
  await page.keyboard.type('追記')
  await page.clock.runFor(1500)
  await expect.poll(async () => (await files(page))[MEETING]).toBe('- 項目一\n- 新\n- 項目二\n\n終わりの段落です。\n\n追記\n')
  await expect(page.getByText('元に戻しました')).toHaveCount(0)
})

test('⌘⇧V goes to the source and back to the document, which shows what was typed in the source', async ({ page }) => {
  await open(page)
  await expect(doc(page)).toBeVisible()
  await doc(page).click()
  await shortcut(page, { key: 'v', shiftKey: true })
  const source = page.locator('.cm-content[role="textbox"]')
  await expect(source).toContainText('<!-- AI メモ')
  await source.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n最後の一行です。')
  await shortcut(page, { key: 'v', shiftKey: true })
  await expect(doc(page)).toContainText('最後の一行です。')
})

test('the AI writing the file shows at once when nothing is edited; with an edit, the member\'s text stays and autosave pauses', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await expect(doc(page)).toBeVisible()
  await page.evaluate(p => (window as unknown as { __acbExternalEdit: (p: string, t: string) => void }).__acbExternalEdit(p, '# 書き換えた定例\n\nAI が書き直しました。\n'), MEETING)
  await expect(doc(page).getByRole('heading', { name: '書き換えた定例' })).toBeVisible()

  await caretAfter(page, 'AI が書き直しました')
  await page.keyboard.type('（確認済み）')
  await page.evaluate(p => (window as unknown as { __acbExternalEdit: (p: string, t: string) => void }).__acbExternalEdit(p, '# もう一度書き換えた\n'), MEETING)
  await expect(page.getByText('このファイルは外部で変更されました')).toBeVisible()
  await expect(doc(page)).toContainText('（確認済み）')
  const count = (await writes(page)).length
  await page.clock.runFor(3000)
  expect((await writes(page)).length).toBe(count)
  expect((await files(page))[MEETING]).toBe('# もう一度書き換えた\n')
})

const backups = (page: Page) => page.evaluate(() => (window as unknown as { __acbBackups: Array<{ reason: string; path: string; content?: string }> }).__acbBackups)
const externalEdit = (page: Page, text: string) => page.evaluate(([p, t]) => (window as unknown as { __acbExternalEdit: (p: string, t: string) => void }).__acbExternalEdit(p, t), [MEETING, text] as const)

/** Typed in the document, then the AI writes the file: the band and ［比べて選ぶ］. */
async function editThenArrive(page: Page) {
  await open(page)
  await externalEdit(page, '# 定例\n\n予定を書きます。\n\n- 一つめ\n- 二つめ\n')
  await expect(doc(page).getByRole('heading', { name: '定例' })).toBeVisible()
  await caretAfter(page, '予定を書きます')
  await page.keyboard.type('（私）')
  await externalEdit(page, '# 定例\n\n予定を書きます。AI が足しました。\n\n- 一つめ\n- 二つめ\n')
  await page.getByRole('button', { name: '比べて選ぶ' }).click()
}

test('［届いた版を採用］ after editing in place: the edits are kept first, the document shows what arrived, and the next edit is placed against it', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await editThenArrive(page)
  await page.getByRole('button', { name: '届いた版を採用' }).click()
  await expect(doc(page)).toContainText('AI が足しました。')
  await expect(doc(page)).not.toContainText('（私）')
  expect(await backups(page)).toEqual([{ reason: 'editor_edits', path: MEETING, content: '# 定例\n\n予定を書きます（私）。\n\n- 一つめ\n- 二つめ\n' }])
  // The document was opened afresh on the version that arrived: a new edit changes only its own bytes.
  await caretAfter(page, '二つめ')
  await page.keyboard.type('です')
  await page.clock.runFor(1500)
  await expect.poll(async () => (await files(page))[MEETING]).toBe('# 定例\n\n予定を書きます。AI が足しました。\n\n- 一つめ\n- 二つめです\n')
})

test('［自分の版を保存］ after editing in place: the arrived version is kept, the edits written, and editing goes on from them', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await editThenArrive(page)
  await page.getByRole('button', { name: '自分の版を保存' }).click()
  await expect.poll(async () => (await files(page))[MEETING]).toBe('# 定例\n\n予定を書きます（私）。\n\n- 一つめ\n- 二つめ\n')
  expect((await backups(page))[0]).toEqual({ reason: 'editor_overwrite', path: MEETING, content: '# 定例\n\n予定を書きます。AI が足しました。\n\n- 一つめ\n- 二つめ\n' })
  await expect(doc(page)).toContainText('予定を書きます（私）。')
  await caretAfter(page, '一つめ')
  await page.keyboard.type('だ')
  await page.clock.runFor(1500)
  await expect.poll(async () => (await files(page))[MEETING]).toBe('# 定例\n\n予定を書きます（私）。\n\n- 一つめだ\n- 二つめ\n')
})

test('保存せずに進む after editing in place keeps exactly what was typed in the backups', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  const before = (await files(page))[MEETING]
  await page.evaluate(p => (window as unknown as { __acbFailWrites: Set<string> }).__acbFailWrites.add(p), MEETING)
  await caretAfter(page, '予算の確認を')
  await page.keyboard.type('二度')
  await page.evaluate(() => (window as unknown as { __acbRequestClose: () => void }).__acbRequestClose())
  await page.getByRole('button', { name: '保存せずに進む' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __acbCloseAnswers: string[] }).__acbCloseAnswers)).toEqual(['ack', 'close'])
  expect(await backups(page)).toEqual([{ reason: 'editor_left_unsaved', path: MEETING, content: before.replace('予算の確認を', '予算の確認を二度') }])
})

test('closing the window right after typing in the document saves it first', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await caretAfter(page, '予算の確認を')
  await page.keyboard.type('二度')
  await page.evaluate(() => (window as unknown as { __acbRequestClose: () => void }).__acbRequestClose())
  await expect.poll(() => page.evaluate(() => (window as unknown as { __acbCloseAnswers: string[] }).__acbCloseAnswers)).toEqual(['ack', 'close'])
  expect((await files(page))[MEETING]).toContain('予算の確認を二度しました。')
})

test('a document the editor cannot hold stays as it reads, says why, and offers the source', async ({ page }) => {
  await open(page, { file: 'notes' })
  await expect(page.getByText('脚注など')).toBeVisible()
  await expect(page.locator('[data-in-place-editor]')).toHaveCount(0)
  await page.getByRole('button', { name: 'もとの書き方で直す' }).click()
  await expect(page.locator('.cm-content[role="textbox"]')).toContainText('[^1]: 注の中身')
  expect(await writes(page)).toEqual([])
})

test('⌘F in the document finds words without changing the document', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await open(page)
  await expect(doc(page)).toBeVisible()
  await doc(page).click()
  await shortcut(page, { key: 'f' })
  const box = page.getByPlaceholder('検索...')
  await expect(box).toBeFocused()
  await box.fill('確認')
  await expect(page.getByText('1/2')).toBeVisible()
  await box.press('Enter')
  await expect(page.getByText('2/2')).toBeVisible()
  await page.clock.runFor(3000)
  expect(await writes(page)).toEqual([])
  expect(await page.locator('[data-in-place-editor] mark').count()).toBe(0)
})
