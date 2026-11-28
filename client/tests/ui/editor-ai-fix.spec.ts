// 「AI に直してもらう」 on a document edited in place (tests/editor-in-place-ui.tsx, the real TabbedEditorPanel
// with the app's selection slot; files-and-editor.md "Asking the AI to fix a passage"): what is handed to the
// consultation (the chat pane's command, faked), the fix shown under its passage in the document's flow,
// ［採用］ writing only the changed line, ［やめる］ nothing, a document changed meanwhile refused, and a
// review comment's ［AI に反映してもらう］ leaving the comment unresolved.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

const ROOT = '/Users/demo/会社'
const DOC = `${ROOT}/営業部/定例メモ.md`
const TEXT = '---\ntitle: 定例\n---\n\n# 定例\n\n予定を書きます。来週は研修です。\n\n* 見積もりは来週の木曜までに送る\n* 次回は 11/27\n\n最後の段落はそのままです。\n'
const MORE = `${TEXT}追記です。\n`
const REVIEW_ID = '7f3c2a10-5b8e-4c1d-9a6f-2e4b8d1c0a93'

const doc = (page: Page) => page.locator('[data-in-place-editor] .ProseMirror')
const bubble = (page: Page) => page.getByRole('toolbar', { name: '選んだ文字の飾り' })
const card = (page: Page) => page.getByRole('region', { name: 'AI の直し案' })
const files = (page: Page) => page.evaluate(() => (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles)
const requests = (page: Page) => page.evaluate(() => (window as unknown as { __acbFixRequests: Array<Record<string, unknown>> }).__acbFixRequests)
const answer = (page: Page, reply: unknown) => page.evaluate(r => (window as unknown as { __acbAnswerFix: (r: unknown) => void }).__acbAnswerFix(r), reply)
const external = (page: Page, path: string, text: string) =>
  page.evaluate(([p, t]) => (window as unknown as { __acbExternalEdit: (p: string, t: string) => void }).__acbExternalEdit(p, t), [path, text] as const)
const externalDelete = (page: Page, path: string) =>
  page.evaluate(p => (window as unknown as { __acbExternalDelete: (p: string) => void }).__acbExternalDelete(p), path)

async function open(page: Page) {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00') })
  await openPreview(page, 'editor-in-place')
  await external(page, DOC, TEXT)
  await expect(doc(page).getByRole('heading', { name: '定例' })).toBeVisible()
}

/** Selects `words` (their first occurrence) in the document, as a drag would. */
async function select(page: Page, words: string) {
  await doc(page).click({ position: { x: 4, y: 4 } }) // a corner: the bubble of a selection before may stand over the middle
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

async function ask(page: Page, words: string, choice = 'もっと丁寧に') {
  await select(page, words)
  await bubble(page).getByRole('button', { name: 'AI に直してもらう' }).click()
  await bubble(page).getByRole('button', { name: choice }).click()
  await expect(card(page)).toBeVisible()
}

test('asking hands over only the passage and a little around it; the fix shows right under that paragraph; ［採用］ changes that line only', async ({ page }) => {
  await open(page)
  await ask(page, '来週の木曜まで')
  const [request] = await requests(page)
  expect(request).toMatchObject({ ask: 'もっと丁寧に', file: '定例メモ.md', passage: '* 見積もりは来週の木曜までに送る\n* 次回は 11/27' })
  expect(String(request.before)).not.toContain('title:')
  expect(String(request.after)).toContain('最後の段落')
  await expect(card(page)).toContainText('相談の AI に頼んでいます')
  // In the document's flow, right after the list it is for (not a floating box).
  const placement = await page.evaluate(() => {
    const el = document.querySelector('[data-ai-fix]')!.closest('.ProseMirror > *')!
    return { before: el.previousElementSibling?.tagName, after: el.nextElementSibling?.textContent }
  })
  expect(placement).toEqual({ before: 'UL', after: '最後の段落はそのままです。' })

  await answer(page, { ok: true, reply: '丁寧にしました。\n\n```acb-fix\n- 見積もりは来週の木曜までにお送りします\n- 次回は 11/27\n```' })
  await expect(card(page).locator('[data-ai-fix-preview]')).toContainText('お送りします')
  await expect(card(page).locator('[data-ai-fix-lines]')).toContainText('− * 見積もりは来週の木曜までに送る')
  await expect(card(page).locator('[data-ai-fix-lines]')).toContainText('＋ * 見積もりは来週の木曜までにお送りします')
  expect(await saved(page)).toBe(TEXT)
  await card(page).getByRole('button', { name: '採用' }).click()
  await expect(card(page)).toHaveCount(0)
  await expect.poll(() => saved(page)).toBe(TEXT.replace('までに送る', 'までにお送りします'))
})

test('the fix is drawn as the chat draws a reply (no image loaded); raw HTML or an image on the internet the passage did not have is never offered', async ({ page }) => {
  await open(page)
  await ask(page, '来週は研修です', '3行に縮めて')
  await answer(page, { ok: true, reply: '```acb-fix\n予定です。**研修**です。![図](images/図.png)\n```' })
  await expect(card(page).locator('[data-ai-fix-preview] strong')).toHaveText('研修')
  await expect(card(page).locator('[data-ai-fix-preview]')).toContainText('画像「図」')
  expect(await card(page).locator('[data-ai-fix-preview] img').count()).toBe(0)
  await card(page).getByRole('button', { name: 'やめる' }).click()

  await ask(page, '来週は研修です', '3行に縮めて')
  await answer(page, { ok: true, reply: '```acb-fix\n予定です。![](https://tracker.example/p.png)\n```' })
  await expect(card(page)).toContainText('文書になかったインターネット上の画像が入っている')
  await expect(card(page).getByRole('button', { name: '採用' })).toHaveCount(0)
  await card(page).getByRole('button', { name: '閉じる' }).click()

  await ask(page, '来週は研修です', '3行に縮めて')
  await answer(page, { ok: true, reply: '```acb-fix\n予定です。<img src=x onerror="window.__pwned=1"><b>太</b>\n```' })
  await expect(card(page)).toContainText('文書になかった HTML の書き方が入っている')
  await expect(card(page).getByRole('button', { name: '採用' })).toHaveCount(0)
  expect(await page.locator('[data-ai-fix] img, [data-ai-fix] b').count()).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  expect(await saved(page)).toBe(TEXT)
})

test('［やめる］ changes nothing, whether the AI answered or not; a refusal is said in the card', async ({ page }) => {
  await open(page)
  await ask(page, '来週は研修です')
  await card(page).getByRole('button', { name: 'やめる' }).click()
  await expect(card(page)).toHaveCount(0)
  // The answer of a request put away is dropped: nothing is left waiting (a change from outside says nothing of a lost fix).
  await answer(page, { ok: true, reply: '```acb-fix\n別の文\n```' })
  await expect(card(page)).toHaveCount(0)
  await external(page, DOC, MORE)
  await expect(doc(page).getByText('追記です。')).toBeVisible()
  await expect(page.getByText('AI に頼んでいる間に文書がほかから変わった')).toHaveCount(0)

  await ask(page, '来週は研修です', '表にして')
  await answer(page, { ok: true, reply: '```acb-fix\n| 予定 |\n|---|\n| 研修 |\n```' })
  await card(page).getByRole('button', { name: 'やめる' }).click()
  await expect(card(page)).toHaveCount(0)

  await ask(page, '来週は研修です')
  await answer(page, { ok: false, reason: 'busy' })
  await expect(card(page)).toContainText('相談の AI がほかのことをしている')
  await expect(card(page).getByRole('button', { name: '採用' })).toHaveCount(0)
  expect(await saved(page)).toBe(MORE)
})

test('a document changed while the AI was asked is never fixed: typed into, or changed from outside', async ({ page }) => {
  await open(page)
  await ask(page, '来週は研修です')
  // The member types elsewhere meanwhile.
  await doc(page).getByText('最後の段落はそのままです。').click()
  await page.keyboard.press('End')
  await page.keyboard.type('追記')
  await answer(page, { ok: true, reply: '```acb-fix\n予定を書きます。来週は研修でございます。\n```' })
  await expect(card(page)).toContainText('文書が変わったため、この直し案は使えません')
  await expect(card(page).getByRole('button', { name: '採用' })).toHaveCount(0)
  expect(await saved(page)).toBe(TEXT.replace('そのままです。', 'そのままです。追記'))

  // The file changed from outside (the AI, sync) while asked: the document opens afresh and says so.
  await card(page).getByRole('button', { name: '閉じる' }).click()
  await ask(page, '来週は研修です')
  await external(page, DOC, TEXT.replace('最後の段落', '外からの段落'))
  await expect(page.getByText('AI に頼んでいる間に文書がほかから変わったため')).toBeVisible()
  await answer(page, { ok: true, reply: '```acb-fix\n別の文\n```' })
  await expect(card(page)).toHaveCount(0)
  expect((await files(page))[DOC]).toBe(TEXT.replace('最後の段落', '外からの段落'))
})

test('with edits not saved yet, a change or a delete from outside while asked makes the fix unusable (the edits stay)', async ({ page }) => {
  await open(page)
  // Typed and not saved yet (the clock stands still, so autosave's second never passes): a change from outside then
  // keeps these edits on screen.
  await page.clock.pauseAt(new Date('2026-01-01T00:10:00'))
  await doc(page).getByText('最後の段落はそのままです。').click()
  await page.keyboard.press('End')
  await page.keyboard.type('追記')
  await ask(page, '来週は研修です')
  await external(page, DOC, TEXT.replace('最後の段落', '外からの段落'))
  await expect(page.getByText('このファイルは外部で変更されました')).toBeVisible()
  await answer(page, { ok: true, reply: '```acb-fix\n予定を書きます。来週は研修でございます。\n```' })
  await expect(card(page)).toContainText('ほかで変わったか消されたため')
  await expect(card(page).getByRole('button', { name: '採用' })).toHaveCount(0)
  await expect(doc(page)).toContainText('そのままです。追記')

  // Answered first, then the file is deleted from outside: ［採用］ goes and nothing is written (nor the file made again).
  await card(page).getByRole('button', { name: '閉じる' }).click()
  await ask(page, '来週は研修です')
  await answer(page, { ok: true, reply: '```acb-fix\n予定を書きます。来週は研修でございます。\n```' })
  await expect(card(page).getByRole('button', { name: '採用' })).toBeVisible()
  await externalDelete(page, DOC)
  await expect(card(page)).toContainText('ほかで変わったか消されたため')
  await expect(card(page).getByRole('button', { name: '採用' })).toHaveCount(0)
  await expect(doc(page)).not.toContainText('ございます')
  expect(await saved(page)).toBeUndefined()
})

test('a review comment\'s ［AI に反映してもらう］ asks with the comment, shows the fix in the document, and never resolves the comment', async ({ page }) => {
  const reviewPath = `${DOC}.review.${REVIEW_ID}.json`
  const review = {
    version: 1,
    review: {
      id: REVIEW_ID, reviewerName: '田中', reviewerEmail: 'tanaka@example.com', status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:10:00.000Z',
      comments: [{
        id: 'c-date', authorName: '田中', severity: 'must_fix', selectedText: '来週の木曜まで', startOffset: 0, endOffset: 0,
        body: '日付（11/27）で書いてください。', createdAt: '2026-01-01T00:05:00.000Z', resolved: false, replies: [],
      }],
    },
  }
  await open(page)
  await external(page, reviewPath, JSON.stringify(review, null, 2))
  await page.getByTitle('レビュー履歴を確認').click()
  await page.getByRole('button', { name: /田中/ }).click()
  await page.getByRole('button', { name: 'AI に反映してもらう' }).click()
  await expect(card(page)).toBeVisible()
  const [request] = await requests(page)
  expect(request).toMatchObject({ comment: { quote: '来週の木曜まで', body: '日付（11/27）で書いてください。' }, passage: '* 見積もりは来週の木曜までに送る\n* 次回は 11/27' })
  await answer(page, { ok: true, reply: '```acb-fix\n* 見積もりは 11/27（木）までに送る\n* 次回は 11/27\n```' })
  await card(page).getByRole('button', { name: '採用' }).click()
  await expect(page.getByText('コメントは解決にしていません')).toBeVisible()
  await expect.poll(() => saved(page)).toBe(TEXT.replace('来週の木曜までに送る', ' 11/27（木）までに送る'))
  // No reply file (where a resolved mark would go) and the review file as it was.
  const after = await files(page)
  expect(Object.keys(after).filter(p => p.includes('.reply.'))).toEqual([])
  expect(after[reviewPath]).toBe(JSON.stringify(review, null, 2))
  await page.getByRole('button', { name: 'レビューに戻る' }).click()
  await expect(page.getByRole('button', { name: '解決', exact: true })).toBeVisible()
})
