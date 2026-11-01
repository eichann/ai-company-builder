// The title bar's 「あなたの番 N」 and bell (tests/title-bar-notices-ui.tsx, features/notifications).
// Guards: the count and the unread dot come from what main read; opening a notice marks only that
// notice read (on the server, so the member's other PC agrees) and opens its record; the dot goes
// once the server says nothing is unread; 「あなたの番」 lists what waits, an approval named as one;
// where the department shows no task list, its meetings are there and in the bell, with their buttons.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('a notice opens its record and is read on the server; the dot goes; 「あなたの番」 lists what waits', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices')
  const turn = page.getByRole('button', { name: /あなたの番/ })
  await expect(turn).toContainText('2')
  const bell = page.getByRole('button', { name: '知らせ（未読 1 件）' })
  await expect(page.getByTestId('notices-unread-dot')).toBeVisible()

  await bell.click()
  const list = page.getByRole('menu', { name: '知らせ' })
  await expect(list).toContainText('佐藤さんが「提案書を作る」を完了にしました')
  await expect(list).toContainText('佐藤さんが「請求書」の期限を11月7日に変えました')
  await list.getByRole('menuitem', { name: /提案書を作る/ }).click()
  await expect(page.locator('#opened')).toHaveText('task-preview03|提案書を作る')
  // Only the opened (unread) notice, never the one already read.
  await expect(page.locator('#read')).toHaveText('n-1')
  await expect(page.getByTestId('notices-unread-dot')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '知らせ', exact: true })).toBeVisible()

  await turn.click()
  const waiting = page.getByRole('menu', { name: 'あなたの番' })
  await expect(waiting.getByRole('menuitem')).toHaveCount(2)
  await expect(waiting).toContainText('承認のお願い：値引きの承認')
  await expect(waiting).toContainText('期限 11/5 15:00')
  await waiting.getByRole('menuitem', { name: /見積書を作る/ }).click()
  await expect(page.locator('#opened')).toHaveText('task-preview02|見積書を作る')
  await expect(page.getByRole('menu')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a department without the task list: its meetings wait in 「あなたの番」 and the bell, with their buttons', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { meetings: '1' })
  const turn = page.getByRole('button', { name: /あなたの番/ })
  // 2 records + the まとまり to choose + the minutes the AI could not read (not the one it is reading).
  await expect(turn).toContainText('4')
  await turn.click()
  const meetings = page.getByRole('menu', { name: 'あなたの番' }).getByRole('region', { name: '会議' })
  await expect(meetings).toContainText('会議：A社 定例')
  await expect(meetings).toContainText('議事録：B社 打合せ')
  await expect(meetings).toContainText('AI が読み取れませんでした：議事録が空でした')
  await meetings.getByRole('button', { name: 'まとまりを選ぶ' }).click()
  await expect(page.locator('#opened')).toHaveText('choose meeting-read01')

  await page.getByRole('button', { name: /^知らせ/ }).click()
  const bell = page.getByRole('menu', { name: '知らせ' }).getByRole('region', { name: '会議' })
  await bell.getByRole('button', { name: '自分で読み取る' }).click()
  await expect(page.locator('#opened')).toHaveText('read meeting-new002')
  expectNoPageErrors(state)
})

test('the dot stays while a meeting waits, even with every notice read', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { meetings: '1' })
  await page.getByRole('button', { name: /^知らせ/ }).click()
  await page.getByRole('button', { name: 'すべて既読にする' }).click()
  await expect(page.getByRole('button', { name: '知らせ（会議が待っています）' })).toBeVisible()
  await expect(page.getByTestId('notices-unread-dot')).toBeVisible()
  expectNoPageErrors(state)
})
