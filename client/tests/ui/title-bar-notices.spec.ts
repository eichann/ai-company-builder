// The title bar's ［受け箱］ and the inbox (tests/title-bar-notices-ui.tsx, features/inbox; redesign 2026-11-26). Guards:
// the button shows a blue count of 新着 and a red count of あなた待ち (no word, none at 0) and names both; the red count
// is only what is stopped until the member acts (an approval, a stopped job) — a task of the member's turn is never a
// row or a count; opening or ［確認した］ on a 新着 row marks exactly its notices read and lowers the blue count by one;
// 「すべて確認した」 takes it to 0 and never touches あなた待ち; a stop is not done by being opened, only by ［済んだ］ or the
// server settling it; meetings keep their buttons, a reading one is shown but not counted; ［元に戻す］ of exactly that
// entry (replied_done, the two Gmail kinds, ai_changed); 「確認したもの」 keeps what was looked at; 「知らせの設定」 without
// a kind of a feature that is off.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const button = (page: Page) => page.locator('[data-inbox-button]')
const panel = (page: Page) => page.getByRole('region', { name: '受け箱' })
const news = (page: Page) => panel(page).getByRole('region', { name: '新着' })
const waiting = (page: Page) => panel(page).getByRole('region', { name: 'あなた待ち' })
const openInbox = async (page: Page) => { await button(page).click(); await expect(panel(page)).toBeVisible() }
type TitleBarPage = { __acbTitleBar: { task(on: boolean): void; arrive(): void; settle(): void; changeAgain(): void } }
const call = (page: Page, f: 'arrive' | 'settle') => page.evaluate(n => (window as unknown as TitleBarPage).__acbTitleBar[n](), f)

test('the button: a blue 新着 count and a red あなた待ち count, both named, no word and none at 0; a task of the turn is never counted', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices')
  // An approval waits; the task due today is the left list's; one unread notice is 新着.
  await expect(button(page)).toHaveAccessibleName('受け箱：新着 1 件・あなた待ち 1 件 (⌘J)')
  await expect(button(page)).toHaveAttribute('title', '受け箱：新着 1 件・あなた待ち 1 件 (⌘J)')
  await expect(button(page).locator('[data-inbox-news]')).toHaveText('1')
  await expect(button(page).locator('[data-inbox-waiting]')).toHaveText('1')
  await expect(button(page)).not.toContainText('受け箱')

  await openInbox(page)
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(waiting(page).locator('[data-inbox-row]')).toHaveCount(1)
  await expect(panel(page).locator('[data-inbox-row="record:task-preview02"]')).toHaveCount(0)
  // The task leaving the turn changes nothing here.
  await page.evaluate(() => (window as unknown as TitleBarPage).__acbTitleBar.task(false))
  await expect(button(page)).toHaveAccessibleName('受け箱：新着 1 件・あなた待ち 1 件 (⌘J)')
  // Only a new notice raises the blue count.
  await call(page, 'arrive')
  await expect(button(page).locator('[data-inbox-news]')).toHaveText('2')
  await button(page).click()
  await expect(panel(page)).toHaveCount(0)
  expectNoPageErrors(state)
})

test('opening a 新着 row opens its record, marks only its notice read and lowers the blue count by one; it stays in 確認したもの', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices')
  await openInbox(page)
  const row = news(page).locator('[data-inbox-row="record:task-preview03"]')
  await expect(row).toContainText('佐藤さんが「提案書を作る」を完了にしました')
  await row.getByRole('button', { name: '開く' }).click()
  await expect(page.locator('#opened')).toHaveText('record task-preview03')
  await expect(page.locator('#read')).toHaveText('n-1')
  await expect(news(page).locator('[data-inbox-row]')).toHaveCount(0)
  // 0 is not shown.
  await expect(button(page).locator('[data-inbox-news]')).toHaveCount(0)
  await panel(page).getByRole('button', { name: /^確認したもの/ }).click()
  await expect(panel(page).getByRole('region', { name: '確認したもの' }).locator('[data-inbox-row="record:task-preview03"]')).toBeVisible()
  expectNoPageErrors(state)
})

test('［確認した］ marks a row seen without opening it; 「すべて確認した」 takes 新着 to 0 and leaves あなた待ち as it is', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices')
  await call(page, 'arrive')
  await openInbox(page)
  await news(page).locator('[data-inbox-row="record:task-preview09"]').getByRole('button', { name: '確認した' }).click()
  await expect(page.locator('#read')).toHaveText('n-new')
  await expect(page.locator('#opened')).toHaveText('')
  await expect(button(page).locator('[data-inbox-news]')).toHaveText('1')
  await news(page).getByRole('button', { name: 'すべて確認した' }).click()
  await expect(page.locator('#read')).toHaveText('n-new,n-1')
  await expect(button(page)).toHaveAccessibleName('受け箱：新着 0 件・あなた待ち 1 件 (⌘J)')
  expectNoPageErrors(state)
})

test('a stopped job waits until it is done: opening it is not enough, ［済んだ］ is; settled by the server it is news that it is over', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { stop: '1' })
  await openInbox(page)
  const row = waiting(page).locator('[data-inbox-row="notice:n-stop"]')
  await expect(row).toContainText('うまくできませんでした')
  await row.getByRole('button', { name: /定期の仕事/ }).click()
  await expect(page.locator('#read')).toHaveText('')
  await expect(button(page)).toHaveAccessibleName('受け箱：新着 1 件・あなた待ち 2 件 (⌘J)')
  // 「すべて確認した」 never takes it.
  await news(page).getByRole('button', { name: 'すべて確認した' }).click()
  await expect(page.locator('#read')).toHaveText('n-1')
  await expect(row).toBeVisible()
  await call(page, 'settle')
  await expect(button(page)).toHaveAccessibleName('受け箱：新着 1 件・あなた待ち 1 件 (⌘J)')
  await expect(news(page).locator('[data-inbox-row="notice:n-stop"]')).toContainText('片付きました')
  expectNoPageErrors(state)
})

test('［済んだ］ on a stop marks it read and it leaves あなた待ち', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { stop: '1' })
  await openInbox(page)
  await waiting(page).locator('[data-inbox-row="notice:n-stop"]').getByRole('button', { name: '済んだ' }).click()
  await expect(page.locator('#read')).toHaveText('n-stop')
  await expect(button(page)).toHaveAccessibleName('受け箱：新着 1 件・あなた待ち 1 件 (⌘J)')
  expectNoPageErrors(state)
})

test('meetings keep their buttons: a stopped reading waits, a finished one is 新着, one the AI reads or a question is shown but not counted', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { meetings: '1' })
  // The approval + C社 (the AI could not read it); 新着: the done notice + D社 finished.
  await expect(button(page)).toHaveAccessibleName('受け箱：新着 2 件・あなた待ち 2 件 (⌘J)')
  await openInbox(page)
  await expect(waiting(page).locator('[data-inbox-row="record:meeting-new002"]')).toContainText('AI が読み取れませんでした：議事録が空でした')
  await waiting(page).getByRole('button', { name: '自分で読み取る' }).click()
  await expect(page.locator('#opened')).toHaveText('read meeting-new002')
  await expect(news(page).locator('[data-inbox-row="record:meeting-new003"]')).toContainText('読み終わりました')
  await news(page).getByRole('button', { name: '案件を選ぶ' }).click()
  await expect(page.locator('#opened')).toHaveText('choose meeting-read01')
  await expect(news(page).locator('[data-inbox-row="record:meeting-new001"]')).toContainText('B社 打合せ')
  await expect(news(page).getByRole('heading')).toContainText('新着 2')
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
  // Marked seen, the row goes to 確認したもの; a line still says it was undone, gone once the panel opens again.
  await expect(page.locator('#read')).toHaveText('n-r')
  await expect(list.getByRole('status')).toHaveText('「見積書を送る」を元に戻しました。')
  await expect(page.locator('#opened')).toHaveText('')
  await button(page).click()
  await openInbox(page)
  await expect(panel(page).getByRole('status')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('mail closed here because it was archived in Gmail, and mail archived there: each offers ［元に戻す］ of exactly its entry', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: 'mail' })
  await openInbox(page)
  const list = panel(page)
  await expect(list.getByRole('button', { name: '元に戻す' })).toHaveCount(2)
  await list.locator('[data-inbox-row="record:interaction-preview02"]').getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('interaction-preview02|6|6')
  await list.locator('[data-inbox-row="record:interaction-preview01"]').getByRole('button', { name: '元に戻す' }).click()
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

test('the AI changed a task again: the new change can be undone on the same one row', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: 'turn' })
  await openInbox(page)
  const row = panel(page).locator('[data-inbox-row="record:task-preview02"]')
  await expect(row).toContainText('期限 11/5 → 11/6')
  await row.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('corporate-sales|op-turn01')
  await expect(page.locator('#read')).toHaveText('n-ait')
  await page.evaluate(() => (window as unknown as TitleBarPage).__acbTitleBar.changeAgain())
  await expect(news(page).locator('[data-inbox-row="record:task-preview02"]')).toContainText('期限 11/6 → 11/7')
  await news(page).locator('[data-inbox-row="record:task-preview02"]').getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('corporate-sales|op-turn02')
  expectNoPageErrors(state)
})

test('確認したもの keeps read notices with their ［元に戻す］; unread ones past the server\'s list are told there', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: 'turn' })
  await openInbox(page)
  await panel(page).getByRole('button', { name: /^確認したもの/ }).click()
  const seen = panel(page).getByRole('region', { name: '確認したもの' })
  await expect(seen.locator('[data-inbox-unlisted]')).toHaveText('ほかに未読 3 件（古いもの）')
  await seen.locator('[data-inbox-row="record:deal-preview03"]').getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('corporate-sales|op-old01')
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
