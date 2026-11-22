// The title bar's one ［受け箱］ (I2, tests/title-bar-notices-ui.tsx, features/inbox): where 「あなたの番 N」 and
// the bell were (owner decision ①). Guards: the number is あなた待ち exactly as the list counts it (meetings
// waiting for the member included, the one the AI reads not); the dot says something new came and goes once the
// inbox was on screen, and comes back for the next new thing; the button opens and closes the panel; everything
// the bell and 「あなたの番」 did has a place — opening a notice marks only it read and opens its record, a meeting's
// own buttons, ［元に戻す］ of exactly that entry (replied_done, the two Gmail kinds, ai_changed — and no other
// notice), 「知らせの設定」 without a kind of a feature that is off.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const button = (page: Page) => page.locator('[data-inbox-button]')
const panel = (page: Page) => page.getByRole('region', { name: '受け箱' })
const openInbox = async (page: Page) => { await button(page).click(); await expect(panel(page)).toBeVisible() }

test('the number is あなた待ち as the list counts it; the dot is for something new and goes once the inbox was shown', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices')
  // An approval and a task wait (the done notice is not counted); an unread notice at the start is new.
  await expect(button(page)).toHaveAccessibleName('受け箱（あなた待ち 2 件・新着あり）')
  await expect(page.getByTestId('inbox-news-dot')).toBeVisible()
  await expect(page.getByText(/あなたの番 \d/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /起きたこと/ })).toHaveCount(0)

  await openInbox(page)
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(panel(page).getByRole('button', { name: /^あなた待ち/ })).toContainText('2')
  await expect(panel(page).getByRole('region', { name: 'あなた待ち' }).locator('[data-inbox-row]')).toHaveCount(2)
  await expect(page.getByTestId('inbox-news-dot')).toHaveCount(0)

  await button(page).click()
  await expect(panel(page)).toHaveCount(0)
  await expect(page.getByTestId('inbox-news-dot')).toHaveCount(0)
  await expect(button(page)).toHaveAccessibleName('受け箱（あなた待ち 2 件）')
  // The next new thing lights it again, though nothing was opened.
  await page.evaluate(() => (window as unknown as { __acbTitleBar: { arrive(): void } }).__acbTitleBar.arrive())
  await expect(page.getByTestId('inbox-news-dot')).toBeVisible()

  // A task that left while the inbox was on screen and comes back after it closed is new again; leaving is not.
  await openInbox(page)
  await page.evaluate(() => (window as unknown as { __acbTitleBar: { task(on: boolean): void } }).__acbTitleBar.task(false))
  await expect(button(page)).toHaveAccessibleName('受け箱（あなた待ち 1 件）')
  await button(page).click()
  await expect(page.getByTestId('inbox-news-dot')).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { __acbTitleBar: { task(on: boolean): void } }).__acbTitleBar.task(true))
  await expect(button(page)).toHaveAccessibleName('受け箱（あなた待ち 2 件・新着あり）')
  expectNoPageErrors(state)
})

test('opening a notice opens its record and marks only it read on the server (both PCs agree)', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices')
  await openInbox(page)
  const done = panel(page).getByRole('region', { name: 'できた・未確認' })
  await expect(done).toContainText('佐藤さんが「提案書を作る」を完了にしました')
  await done.locator('[data-inbox-row="notice:n-1"]').getByRole('button', { name: '開く' }).click()
  await expect(page.locator('#opened')).toHaveText('record task-preview03')
  // Only the opened (unread) notice, never the one already read.
  await expect(page.locator('#read')).toHaveText('n-1')
  await expect(panel(page).getByRole('region', { name: 'できた・未確認' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a department without the task list: meetings waiting for the member are counted and keep their buttons; one the AI reads is 作業中', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { meetings: '1' })
  // 2 records + the まとまり to choose + the minutes the AI could not read (not the one it is reading).
  await expect(button(page)).toHaveAccessibleName(/あなた待ち 4 件/)
  await openInbox(page)
  const waiting = panel(page).getByRole('region', { name: 'あなた待ち' })
  await expect(waiting.locator('[data-inbox-row="record:meeting-new002"]')).toContainText('AI が読み取れませんでした：議事録が空でした')
  await waiting.getByRole('button', { name: '案件を選ぶ' }).click()
  await expect(page.locator('#opened')).toHaveText('choose meeting-read01')
  await waiting.getByRole('button', { name: '自分で読み取る' }).click()
  await expect(page.locator('#opened')).toHaveText('read meeting-new002')
  await expect(waiting).not.toContainText('B社 打合せ')
  const working = panel(page).getByRole('region', { name: '作業中' })
  await expect(working).toContainText('B社 打合せ')
  await expect(panel(page).getByRole('button', { name: /^作業中/ })).toContainText('1')
  expectNoPageErrors(state)
})

test('「返事をしたので完了にしました」 offers ［元に戻す］: the undo of that entry, at its version; other notices have none', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: '1' })
  await openInbox(page)
  const list = panel(page)
  await expect(list).toContainText('返事をしたので完了にしました：「見積書を送る」')
  await expect(list.getByRole('button', { name: '元に戻す' })).toHaveCount(1)
  await list.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('task-preview05|7|7')
  // Marked seen, the row folds away; a line still says it was undone.
  await expect(page.locator('#read')).toHaveText('n-r')
  await expect(list.getByRole('status')).toHaveText('「見積書を送る」を元に戻しました。')
  await expect(page.locator('#opened')).toHaveText('')
  expectNoPageErrors(state)
})

test('mail closed here because it was archived in Gmail, and mail archived there: each offers ［元に戻す］ of exactly its entry', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: 'mail' })
  await openInbox(page)
  const list = panel(page)
  await expect(list.getByRole('button', { name: '元に戻す' })).toHaveCount(2)
  await list.locator('[data-inbox-row="notice:n-a"]').getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('interaction-preview02|6|6')
  await list.locator('[data-inbox-row="notice:n-l"]').getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('interaction-preview01|4|4')
  await expect(page.locator('#opened')).toHaveText('')
  expectNoPageErrors(state)
})

test('「AI が変えました」 offers ［元に戻す］ through its operation (the outside system too), not once it was written back', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: 'ai' })
  await openInbox(page)
  const list = panel(page)
  await expect(list).toContainText('理由：先方が予算を確保したため')
  await expect(list.getByRole('button', { name: '元に戻す' })).toHaveCount(1)
  await list.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('corporate-sales|op-preview01')
  await expect(page.locator('#read')).toHaveText('n-ai')
  await expect(list.getByRole('status')).toContainText('元に戻しました')
  await expect(page.locator('#opened')).toHaveText('')
  expectNoPageErrors(state)
})

test('「知らせの設定」 (from the inbox) lists no kind of a feature that is off; with everything on, all are listed', async ({ page }) => {
  const settings = async () => {
    await openInbox(page)
    await panel(page).getByRole('button', { name: '知らせの設定' }).click()
    const dialog = page.getByRole('dialog', { name: '知らせの設定' })
    await expect(dialog.getByText('頼んだことが終わった・中止になった')).toBeVisible()
    return dialog
  }
  const state = await openPreview(page, 'title-bar-notices', { features: 'off' })
  let dialog = await settings()
  await expect(dialog.getByText('出た会議の議事録が届いた')).toHaveCount(0)
  await expect(dialog.getByText('返事を待っていた連絡に、相手から返事が来た')).toHaveCount(0)

  await openPreview(page, 'title-bar-notices')
  dialog = await settings()
  await expect(dialog.getByText('出た会議の議事録が届いた')).toBeVisible()
  await expect(dialog.getByText('返事を待っていた連絡に、相手から返事が来た')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expectNoPageErrors(state)
})

// The independent review of I2: what the bell showed must not disappear.
type TitleBarPage = { __acbTitleBar: { task(on: boolean): void; load(): void; changeAgain(): void } }

test('the AI changed a task that is the member\'s turn: its ［元に戻す］ is on that one row', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: 'turn' })
  await openInbox(page)
  const row = panel(page).getByRole('region', { name: 'あなた待ち' }).locator('[data-inbox-row="record:task-preview02"]')
  await expect(row).toContainText('期限 11/5 → 11/6')
  await row.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('corporate-sales|op-turn01')
  await expect(page.locator('#read')).toHaveText('n-ait')
  await expect(page.locator('#opened')).toHaveText('')
  // The AI changes it again: the new change can be undone on the same row (undone is per notice, not per row).
  await page.evaluate(() => (window as unknown as TitleBarPage).__acbTitleBar.changeAgain())
  await expect(row).toContainText('期限 11/6 → 11/7')
  await row.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('corporate-sales|op-turn02')
  expectNoPageErrors(state)
})

test('read notices from before today are in 「前に確認したもの」 (folded) with their ［元に戻す］; unread ones past the list are told', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: 'turn' })
  await openInbox(page)
  await expect(panel(page).locator('[data-inbox-unlisted]')).toHaveText('ほかに未読 3 件（古いもの）')
  const before = panel(page).getByRole('region', { name: '前に確認したもの' })
  await expect(before.locator('[data-inbox-row]')).toHaveCount(0)
  await before.getByRole('button', { name: /前に確認したもの/ }).click()
  await before.locator('[data-inbox-row="notice:n-old"]').getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('corporate-sales|op-old01')
  expectNoPageErrors(state)
})

test('the dot clears only for what the chosen chip showed; the undo line is gone when the panel opens again', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: '1' })
  await openInbox(page)
  await panel(page).getByRole('button', { name: /^できた・未確認/ }).click()
  // A task leaves and comes back while only できた・未確認 is shown: the member has not seen it.
  await page.evaluate(() => (window as unknown as TitleBarPage).__acbTitleBar.task(false))
  await expect(button(page)).toHaveAccessibleName('受け箱（あなた待ち 1 件）')
  await page.evaluate(() => (window as unknown as TitleBarPage).__acbTitleBar.task(true))
  await expect(button(page)).toHaveAccessibleName('受け箱（あなた待ち 2 件）')
  await panel(page).getByRole('button', { name: '元に戻す' }).click()
  await expect(panel(page).getByRole('status')).toContainText('元に戻しました')
  await button(page).click()
  await expect(page.getByTestId('inbox-news-dot')).toBeVisible()
  await openInbox(page)
  await expect(panel(page).getByRole('status')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('the dot\'s baseline waits for every source: meetings that answer late are not news', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { late: '1' })
  await expect(button(page)).toHaveAccessibleName('受け箱（あなた待ち 2 件）')
  await page.evaluate(() => (window as unknown as TitleBarPage).__acbTitleBar.load())
  await expect(button(page)).toHaveAccessibleName('受け箱（あなた待ち 4 件）')
  expectNoPageErrors(state)
})
