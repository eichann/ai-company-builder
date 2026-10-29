// The document review in the editor (tests/doc-review-ui.tsx): what the member
// sees and the sidecar files it writes. The pure rules (file names, the email
// hash, reply merging, unseen tracking, text matching) are pinned by
// src/features/doc-review/model.test.ts; here: the hook, the
// components and the editor wired together, and the files' exact shape on disk.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const DOC = '/Users/demo/会社/営業部/提案書.md'
const SATO_REVIEW = 'a1b2c3d4-0000-4000-8000-000000000001'
const MY_REPLY_FILE = `${DOC}.reply.qtm6lc.json` // emailToHash('demo@example.com')
const REVIEW_KEYS = ['id', 'reviewerName', 'reviewerEmail', 'status', 'createdAt', 'completedAt', 'comments']
const COMMENT_KEYS = ['id', 'authorName', 'severity', 'selectedText', 'startOffset', 'endOffset', 'body', 'createdAt', 'resolved', 'replies']

const disk = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __acbFiles: Record<string, string> }).__acbFiles }))

/** The file's JSON, after checking it is written the way the app always writes it (2-space JSON). */
function sidecar(files: Record<string, string>, path: string) {
  const text = files[path]
  expect(text, path).toBeDefined()
  const data = JSON.parse(text)
  expect(text).toBe(JSON.stringify(data, null, 2))
  return data
}

async function selectText(page: Page, text: string) {
  await page.evaluate(wanted => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const at = node.textContent?.indexOf(wanted) ?? -1
      if (at === -1) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + wanted.length)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      node.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return
    }
    throw new Error(`text not found: ${wanted}`)
  }, text)
}

test('a reviewed file: open the past review, reply and resolve; both go to my own reply file', async ({ page }) => {
  const state = await openPreview(page, 'doc-review')
  await expect(page.getByText('来期のご提案です。')).toBeVisible()
  const before = await disk(page)

  await page.getByRole('button', { name: 'レビュー履歴 (1)' }).click()
  await page.getByRole('button', { name: /佐藤/ }).click()
  await expect(page.getByText('1件のコメント（0件解決済み）')).toBeVisible()
  await expect(page.getByText('対応必須1件')).toBeVisible()
  await expect(page.getByText('根拠となる数字を添えてください')).toBeVisible()
  await expect(page.locator('mark[data-review-highlight]')).toHaveText('売上目標は前年比120%')
  // Opening the file marked the review as seen (file tree badge).
  expect(await page.evaluate(doc => localStorage.getItem(`review-seen:${doc}`), DOC))
    .toBe(JSON.stringify([`提案書.md.review.${SATO_REVIEW}.json`]))

  await page.getByRole('button', { name: '返信', exact: true }).click()
  const replyBox = page.getByPlaceholder('返信... (⌘+Enter)')
  await replyBox.fill('前年の実績を追記します')
  // The reply form sits above the thread's action bar: its button is the first 「返信」.
  await page.getByRole('button', { name: '返信', exact: true }).first().click()
  await expect(replyBox).toHaveCount(0)
  await expect(page.getByText('前年の実績を追記します')).toBeVisible()

  let files = await disk(page)
  const replies = sidecar(files, MY_REPLY_FILE)
  expect(Object.keys(replies)).toEqual(['version', 'authorName', 'authorEmail', 'replies'])
  expect(replies).toMatchObject({ version: 1, authorName: '山田', authorEmail: 'demo@example.com' })
  expect(replies.replies).toHaveLength(1)
  expect(Object.keys(replies.replies[0])).toEqual(['id', 'authorName', 'body', 'createdAt', 'reviewId', 'commentId'])
  expect(replies.replies[0]).toMatchObject({ authorName: '山田', body: '前年の実績を追記します', reviewId: SATO_REVIEW, commentId: 'c-sato-1' })

  await page.getByRole('button', { name: '解決', exact: true }).click()
  await expect(page.getByRole('button', { name: '解決済み' })).toBeVisible()
  files = await disk(page)
  expect(sidecar(files, MY_REPLY_FILE).resolutions).toEqual([{ reviewId: SATO_REVIEW, commentId: 'c-sato-1', resolved: true }])
  // The reviewer's own file is never written by someone else.
  expect(files[`${DOC}.review.${SATO_REVIEW}.json`]).toBe(before[`${DOC}.review.${SATO_REVIEW}.json`])
  expect(Object.keys(files).sort()).toEqual([DOC, `${DOC}.reply.qtm6lc.json`, `${DOC}.review.${SATO_REVIEW}.json`].sort())

  await page.getByRole('button', { name: '閉じる' }).click()
  await expect(page.getByText('1件のコメント（1件解決済み）')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a new review: comment on selected text, complete; one review file with the comment and a snapshot', async ({ page }) => {
  const state = await openPreview(page, 'doc-review')
  await expect(page.getByText('来期のご提案です。')).toBeVisible()

  await page.getByRole('button', { name: 'レビューする' }).click()
  await expect(page.getByText('レビュー中 — テキストを選択してコメントを追加')).toBeVisible()
  await expect(page.getByText(/コメントを追加してください/)).toBeVisible()

  let files = await disk(page)
  const reviewPaths = Object.keys(files).filter(p => p !== `${DOC}.review.${SATO_REVIEW}.json` && /\.review\./.test(p))
  expect(reviewPaths).toHaveLength(1)
  const myReviewPath = reviewPaths[0]
  expect(myReviewPath).toMatch(new RegExp(`^${DOC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.review\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`))
  let mine = sidecar(files, myReviewPath)
  expect(Object.keys(mine)).toEqual(['version', 'review'])
  expect(mine.version).toBe(1)
  expect(Object.keys(mine.review)).toEqual(REVIEW_KEYS)
  expect(mine.review).toMatchObject({ reviewerName: '山田', reviewerEmail: 'demo@example.com', status: 'in_progress', completedAt: null, comments: [] })
  expect(myReviewPath.endsWith(`.review.${mine.review.id}.json`)).toBe(true)

  await selectText(page, '担当は営業部です')
  await page.getByRole('button', { name: 'できれば' }).click()
  await page.getByPlaceholder('コメントを入力... (⌘+Enter で送信)').fill('部署名を正式名称に')
  await page.getByRole('button', { name: 'コメント', exact: true }).click()
  await expect(page.getByText('部署名を正式名称に')).toBeVisible()
  await expect(page.getByText('(1件')).toBeVisible()

  files = await disk(page)
  mine = sidecar(files, myReviewPath)
  expect(mine.review.comments).toHaveLength(1)
  const comment = mine.review.comments[0]
  expect(Object.keys(comment)).toEqual(COMMENT_KEYS)
  const docText = files[DOC]
  expect(comment).toMatchObject({
    authorName: '山田', severity: 'should_fix', selectedText: '担当は営業部です', body: '部署名を正式名称に',
    startOffset: docText.indexOf('担当は営業部です'), endOffset: docText.indexOf('担当は営業部です') + '担当は営業部です'.length,
    resolved: false, replies: [],
  })

  await page.getByRole('button', { name: 'レビュー完了' }).click()
  await expect(page.getByText('レビュー中 — テキストを選択してコメントを追加')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'レビュー履歴 (2)' })).toBeVisible()
  files = await disk(page)
  mine = sidecar(files, myReviewPath)
  expect(Object.keys(mine.review)).toEqual([...REVIEW_KEYS, 'snapshot'])
  expect(mine.review.status).toBe('completed')
  expect(typeof mine.review.completedAt).toBe('string')
  expect(mine.review.snapshot).toBe(docText)
  expectNoPageErrors(state)
})

test('cancelling a review deletes its file', async ({ page }) => {
  const state = await openPreview(page, 'doc-review')
  await page.getByRole('button', { name: 'レビューする' }).click()
  await expect(page.getByText('レビュー中 — テキストを選択してコメントを追加')).toBeVisible()
  expect(Object.keys(await disk(page)).filter(p => p.includes('.review.'))).toHaveLength(2)
  await page.getByRole('button', { name: 'キャンセル' }).click()
  await expect(page.getByRole('button', { name: 'レビューする' })).toBeVisible()
  expect(Object.keys(await disk(page)).filter(p => p.includes('.review.'))).toEqual([`${DOC}.review.${SATO_REVIEW}.json`])
  expectNoPageErrors(state)
})

test('starting a review removes an existing review request', async ({ page }) => {
  const state = await openPreview(page, 'doc-review', { request: '1' })
  const hasRequest = async () => Object.keys(await disk(page)).includes(`${DOC}.review-request.json`)
  // The history button appears once the first load (which also reads the request) is done.
  await expect(page.getByRole('button', { name: 'レビュー履歴 (1)' })).toBeVisible()
  expect(await hasRequest()).toBe(true)
  await page.getByRole('button', { name: 'レビューする' }).click()
  await expect(page.getByText('レビュー中 — テキストを選択してコメントを追加')).toBeVisible()
  await expect.poll(hasRequest).toBe(false)
  expectNoPageErrors(state)
})

test('opening and viewing reviews changes no file: all-resolved reviews stay, 「位置不明」 is shown, not written', async ({ page }) => {
  const state = await openPreview(page, 'doc-review', { history: '1' })
  const before = await disk(page)
  await expect(page.getByRole('button', { name: 'レビュー履歴 (3)' })).toBeVisible()

  const views: Array<[name: string, shows: string]> = [
    ['佐藤', '根拠となる数字を添えてください'],
    ['鈴木', '1件のコメント（1件解決済み）'],
    ['田中', '位置不明'],
  ]
  for (const [name, shows] of views) {
    await page.getByRole('button', { name: /^レビュー履歴/ }).click()
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await expect(page.getByText(shows)).toBeVisible()
    await page.getByRole('button', { name: '閉じる' }).click()
  }
  await page.waitForLoadState('networkidle')
  expect(await disk(page)).toEqual(before)
  expectNoPageErrors(state)
})

// ---- Saves that fail, and what the member sees (api.test.ts pins the retries) ----

const failNextWrites = (page: Page, n: number) => page.evaluate(count => (window as unknown as { __acbFailWrites: (n: number) => void }).__acbFailWrites(count), n)
const saveAlert = (page: Page) => page.getByRole('alert').filter({ hasText: '保存できませんでした' })

async function startOwnReview(page: Page) {
  await expect(page.getByRole('button', { name: 'レビュー履歴 (1)' })).toBeVisible()
  await page.getByRole('button', { name: 'レビューする' }).click()
  await expect(page.getByText('レビュー中 — テキストを選択してコメントを追加')).toBeVisible()
}

test('a comment that cannot be saved: plain message, the text stays; pressing コメント again saves it', async ({ page }) => {
  const state = await openPreview(page, 'doc-review')
  await startOwnReview(page)
  await selectText(page, '担当は営業部です')
  const box = page.getByPlaceholder('コメントを入力... (⌘+Enter で送信)')
  await box.fill('部署名を正式名称に')
  await failNextWrites(page, 3) // every retry fails
  await page.getByRole('button', { name: 'コメント', exact: true }).click()
  await expect(saveAlert(page)).toHaveText('コメントを保存できませんでした。書いた内容は残っています。少し待ってから、もう一度「コメント」を押してください。')
  await expect(box).toHaveValue('部署名を正式名称に')
  await expect(page.getByText('(1件')).toHaveCount(0)

  await page.getByRole('button', { name: 'コメント', exact: true }).click()
  await expect(saveAlert(page)).toHaveCount(0)
  await expect(box).toHaveCount(0)
  await expect(page.getByText('部署名を正式名称に')).toBeVisible()
  const files = await disk(page)
  const mine = Object.entries(files).find(([p]) => p.includes('.review.') && !p.includes(SATO_REVIEW))!
  expect(JSON.parse(mine[1]).review.comments.map((c: { body: string }) => c.body)).toEqual(['部署名を正式名称に'])
  expect(Object.keys(files).filter(p => p.includes('.acb-tmp-'))).toEqual([])
  expectNoPageErrors(state)
})

test('a brief failure is retried without the member noticing', async ({ page }) => {
  const state = await openPreview(page, 'doc-review')
  await startOwnReview(page)
  await selectText(page, '担当は営業部です')
  await page.getByPlaceholder('コメントを入力... (⌘+Enter で送信)').fill('一度だけ失敗')
  await failNextWrites(page, 2)
  await page.getByRole('button', { name: 'コメント', exact: true }).click()
  await expect(page.getByText('一度だけ失敗')).toBeVisible()
  await expect(saveAlert(page)).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a reply that cannot be saved keeps the reply box and its text', async ({ page }) => {
  const state = await openPreview(page, 'doc-review')
  await page.getByRole('button', { name: 'レビュー履歴 (1)' }).click()
  await page.getByRole('button', { name: /佐藤/ }).click()
  await page.getByRole('button', { name: '返信', exact: true }).click()
  const box = page.getByPlaceholder('返信... (⌘+Enter)')
  await box.fill('前年の実績を追記します')
  await failNextWrites(page, 3)
  await page.getByRole('button', { name: '返信', exact: true }).first().click()
  await expect(saveAlert(page)).toHaveText('返信を保存できませんでした。書いた内容は残っています。少し待ってから、もう一度「返信」を押してください。')
  await expect(box).toHaveValue('前年の実績を追記します')
  await page.getByRole('button', { name: '返信', exact: true }).first().click()
  await expect(box).toHaveCount(0)
  await expect(page.getByText('前年の実績を追記します')).toBeVisible()
  await expect(saveAlert(page)).toHaveCount(0)
  expectNoPageErrors(state)
})

test('completing fails: the review stays open with 「もう一度試す」, which completes it', async ({ page }) => {
  const state = await openPreview(page, 'doc-review')
  await startOwnReview(page)
  await failNextWrites(page, 3)
  await page.getByRole('button', { name: 'レビュー完了' }).click()
  await expect(saveAlert(page)).toHaveText(/^レビューを保存できませんでした。少し待ってから「もう一度試す」を押してください。/)
  await expect(page.getByText('レビュー中 — テキストを選択してコメントを追加')).toBeVisible()
  await saveAlert(page).getByRole('button', { name: 'もう一度試す' }).click()
  await expect(saveAlert(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'レビュー履歴 (2)' })).toBeVisible()
  expectNoPageErrors(state)
})

test('the reviewer\'s file changed underneath (another computer, the AI): a new comment keeps the other one', async ({ page }) => {
  const state = await openPreview(page, 'doc-review')
  await startOwnReview(page)
  const path = Object.keys(await disk(page)).find(p => p.includes('.review.') && !p.includes(SATO_REVIEW))!
  await page.evaluate(p => {
    const files = (window as unknown as { __acbFiles: Record<string, string> }).__acbFiles
    const data = JSON.parse(files[p])
    data.review.comments.push({
      id: 'from-elsewhere', authorName: '山田', severity: 'note', selectedText: '来期', startOffset: 7, endOffset: 9,
      body: '別のパソコンで書いたコメント', createdAt: '2026-10-29T00:00:00.000Z', resolved: false, replies: [],
    })
    files[p] = JSON.stringify(data, null, 2)
  }, path)
  await selectText(page, '担当は営業部です')
  await page.getByPlaceholder('コメントを入力... (⌘+Enter で送信)').fill('このパソコンのコメント')
  await page.getByRole('button', { name: 'コメント', exact: true }).click()
  await expect(page.getByText('別のパソコンで書いたコメント')).toBeVisible()
  await expect(page.getByText('このパソコンのコメント')).toBeVisible()
  const saved = JSON.parse((await disk(page))[path])
  expect(saved.review.comments.map((c: { body: string }) => c.body)).toEqual(['このパソコンのコメント', '別のパソコンで書いたコメント'])
  expectNoPageErrors(state)
})

test('switching documents while the previous one still loads shows only the current one\'s reviews', async ({ page }) => {
  const state = await openPreview(page, 'doc-review', { second: '1', slow: '1' })
  await page.getByText('議事録.md').click()
  await page.getByRole('button', { name: 'レビュー履歴 (1)' }).click()
  await expect(page.getByRole('button', { name: /高橋/ })).toBeVisible()
  await page.getByRole('button', { name: 'レビュー履歴 (1)' }).click() // closes the list
  await page.waitForTimeout(1200) // the slow listing for 提案書.md has finished by now
  await page.getByRole('button', { name: 'レビュー履歴 (1)' }).click()
  await expect(page.getByRole('button', { name: /高橋/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /佐藤/ })).toHaveCount(0)
  expectNoPageErrors(state)
})
