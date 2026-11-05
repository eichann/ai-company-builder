// The title bar's 「あなたの番 N」 and bell (tests/title-bar-notices-ui.tsx, features/notifications).
// Guards: the count and the unread dot come from what main read; opening a notice marks only that
// notice read (on the server, so the member's other PC agrees) and opens its record; the dot goes
// once the server says nothing is unread; 「あなたの番」 lists what waits by kind with what to do (I.2);
// the bell is only what happened (I.1): a meeting waiting for the member is in 「あなたの番」 with its
// buttons, one the AI is reading in the bell, and the bell's dot is only for unread notices; a notice
// that the member's AI completed a task their reply finished offers ［元に戻す］ — the undo of exactly
// that entry (owner FB #19); so do a mail closed because it was archived in Gmail and one archived
// there (2026-11-05, `UNDOABLE_NOTIFICATION_KINDS`) — and no other notice does.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('a notice opens its record and is read on the server; the dot goes; 「あなたの番」 lists what waits', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices')
  const turn = page.getByRole('button', { name: /あなたの番/ })
  await expect(turn).toContainText('2')
  const bell = page.getByRole('button', { name: '起きたこと（未読 1 件）' })
  await expect(page.getByTestId('notices-unread-dot')).toBeVisible()

  await bell.click()
  const list = page.getByRole('menu', { name: '起きたこと' })
  await expect(list).toContainText('佐藤さんが「提案書を作る」を完了にしました')
  await expect(list).toContainText('佐藤さんが「請求書」の期限を11月7日に変えました')
  await list.getByRole('menuitem', { name: /提案書を作る/ }).click()
  await expect(page.locator('#opened')).toHaveText('task-preview03|提案書を作る')
  // Only the opened (unread) notice, never the one already read.
  await expect(page.locator('#read')).toHaveText('n-1')
  await expect(page.getByTestId('notices-unread-dot')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '起きたこと', exact: true })).toBeVisible()

  await turn.click()
  const waiting = page.getByRole('menu', { name: 'あなたの番' })
  await expect(waiting.getByRole('menuitem')).toHaveCount(2)
  // By kind, with what to do: the count in the title bar is the list's.
  await expect(waiting.getByRole('region', { name: '承認のお願い 1件 — 承認してください' })).toContainText('値引きの承認')
  await expect(waiting.getByRole('region', { name: 'やること 1件' })).toContainText('見積書を作る')
  await expect(waiting).toContainText('ここは押すものだけです')
  await expect(waiting).toContainText('期限 11/5 15:00')
  await waiting.getByRole('menuitem', { name: /見積書を作る/ }).click()
  await expect(page.locator('#opened')).toHaveText('task-preview02|見積書を作る')
  await expect(page.getByRole('menu')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('the morning’s 「今日のあなたの番」 opens the task list, not a record', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices')
  await page.getByRole('button', { name: /^起きたこと/ }).click()
  await page.getByRole('menu', { name: '起きたこと' }).getByRole('menuitem', { name: /今日のあなたの番 2件/ }).click()
  await expect(page.locator('#opened')).toHaveText('task list')
  expectNoPageErrors(state)
})

test('a department without the task list: meetings waiting for the member are in 「あなたの番」 with their buttons; one the AI reads is in the bell', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { meetings: '1' })
  const turn = page.getByRole('button', { name: /あなたの番/ })
  // 2 records + the まとまり to choose + the minutes the AI could not read (not the one it is reading).
  await expect(turn).toContainText('4')
  await turn.click()
  const meetings = page.getByRole('menu', { name: 'あなたの番' }).getByRole('region', { name: '会議' })
  await expect(meetings).toContainText('会議：A社 定例')
  await expect(meetings).toContainText('AI が読み取れませんでした：議事録が空でした')
  await expect(meetings).not.toContainText('B社 打合せ')
  await meetings.getByRole('button', { name: '案件を選ぶ' }).click()
  await expect(page.locator('#opened')).toHaveText('choose meeting-read01')
  await turn.click()
  await page.getByRole('menu', { name: 'あなたの番' }).getByRole('button', { name: '自分で読み取る' }).click()
  await expect(page.locator('#opened')).toHaveText('read meeting-new002')

  await page.getByRole('button', { name: /^起きたこと/ }).click()
  const bell = page.getByRole('menu', { name: '起きたこと' }).getByRole('region', { name: '会議' })
  await expect(bell).toContainText('議事録：B社 打合せ')
  await expect(bell).not.toContainText('A社 定例')
  expectNoPageErrors(state)
})

test('the bell\'s dot is only for unread notices: a meeting waiting counts in 「あなたの番」 instead', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { meetings: '1' })
  await page.getByRole('button', { name: /^起きたこと/ }).click()
  await page.getByRole('button', { name: 'すべて読んだ' }).click()
  await expect(page.getByRole('button', { name: '起きたこと', exact: true })).toBeVisible()
  await expect(page.getByTestId('notices-unread-dot')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /あなたの番/ })).toContainText('4')
  expectNoPageErrors(state)
})

test('「返事をしたので完了にしました」 offers ［元に戻す］: the undo of that entry, at its version; other notices have none', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: '1' })
  await page.getByRole('button', { name: /^起きたこと/ }).click()
  const list = page.getByRole('menu', { name: '起きたこと' })
  await expect(list).toContainText('返事をしたので完了にしました：「見積書を送る」')
  await expect(list.getByRole('button', { name: '元に戻す' })).toHaveCount(1)
  await list.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('task-preview05|7|7')
  await expect(list).toContainText('元に戻しました')
  await expect(page.locator('#opened')).toHaveText('')
  expectNoPageErrors(state)
})

test('mail closed here because it was archived in Gmail, and mail archived there: each offers ［元に戻す］ of exactly its entry', async ({ page }) => {
  const state = await openPreview(page, 'title-bar-notices', { undo: 'mail' })
  await page.getByRole('button', { name: /^起きたこと/ }).click()
  const list = page.getByRole('menu', { name: '起きたこと' })
  await expect(list.getByRole('button', { name: '元に戻す' })).toHaveCount(2)
  const archived = list.locator('div', { hasText: 'Gmail でもアーカイブしました' }).last()
  await archived.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('interaction-preview02|6|6')
  const closed = list.locator('div', { hasText: 'Gmail ではアーカイブ済みのため、閉じました' }).last()
  await closed.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#undone')).toHaveText('interaction-preview01|4|4')
  await expect(page.locator('#opened')).toHaveText('')
  expectNoPageErrors(state)
})
