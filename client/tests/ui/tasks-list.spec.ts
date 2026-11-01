// The task list (tests/tasks-list-ui.tsx, features/tasks, tasks-ui.md). Guards: the sections by
// turn with today's meetings mixed in (to come with the member's turn, over with today's done);
// the far future folded until opened; the date view; 引き受ける from the list; finishing one's own
// task (start then complete at the versions it moves through); the one line adds a task with its
// due and tags; a tag narrows the list; a row opens its card beside the list.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('by turn: sections, meetings mixed in, the far future folded, the date view', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const section = (name: string) => page.getByRole('region', { name })
  await expect(section('引き受け待ち')).toContainText('セキュリティのチェックシート')
  await expect(section('あなたの番')).toContainText('お礼メールを確かめて送る')
  await expect(section('あなたの番')).toContainText('B社 見積のオンライン確認')
  await expect(section('あなたの番')).toContainText('A社 問い合わせ対応')
  await expect(section('AI の番')).toContainText('日程の候補を探す')
  await expect(section('ほかの人の番・返事待ち')).toContainText('阿部さんの番')
  await expect(section('今日終わったこと')).toContainText('営業部 週次定例')
  await expect(section('今日終わったこと')).toContainText('経費の申請')

  const later = section('先のこと')
  await expect(later).not.toContainText('来期の研修メニュー')
  await later.getByRole('button', { name: /先のこと/ }).click()
  await expect(later).toContainText('来期の研修メニュー')

  await page.getByRole('button', { name: '日付ごと' }).click()
  await expect(section('今日まで')).toContainText('お礼メールを確かめて送る')
  await expect(section('期限なし')).toContainText('日程の候補を探す')
  await expect(page.getByRole('region', { name: 'あなたの番' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('accepting and finishing from the list; a row opens its card', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  await page.getByRole('region', { name: '引き受け待ち' }).getByRole('button', { name: '引き受ける' }).click()
  await expect(page.locator('#acted')).toHaveText('task-acc001:accept@2')
  await expect(page.getByRole('region', { name: 'あなたの番' })).toContainText('セキュリティのチェックシート')
  await expect(page.getByRole('region', { name: '引き受け待ち' })).toHaveCount(0)

  // Only the member's own task offers 「終わった」; it is started first, then completed.
  await expect(page.getByRole('button', { name: '「お礼メールを確かめて送る」を終わったにする' })).toHaveCount(0)
  await page.getByRole('button', { name: '「見積書を作り直す」を終わったにする' }).click()
  await expect(page.locator('#acted')).toHaveText('task-acc001:accept@2,task-mine02:start@2,task-mine02:complete@3')
  await expect(page.getByRole('region', { name: '今日終わったこと' })).toContainText('見積書を作り直す')

  await page.getByRole('button', { name: /日程の候補を探す/ }).click()
  await expect(page.getByTestId('card')).toHaveText('カード：task-ai0001')
  await page.getByRole('button', { name: 'A社 問い合わせ対応' }).click()
  await expect(page.getByTestId('card')).toHaveText('カード：deal-a00001')
  expectNoPageErrors(state)
})

test('the one line adds a task with its due and tags; a tag narrows the list', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const input = page.getByRole('textbox', { name: 'やることを追加' })
  await input.fill('請求書を出す 明日15時まで #ｴｲｷﾞｮｳ')
  const preview = page.getByTestId('quick-add-preview')
  await expect(preview).toContainText('期限 明日 15:00')
  await expect(preview).toContainText('自分だけに見えるやることになります')
  await input.fill('請求書を出す 明日15時まで #経理')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByRole('region', { name: 'あなたの番' })).toContainText('請求書を出す')

  await page.getByRole('group', { name: 'タグで絞る' }).getByRole('button', { name: /#経理/ }).click()
  await expect(page.getByTestId('task-row')).toHaveCount(1)
  await expect(page.getByTestId('event-row')).toHaveCount(0)
  await page.getByRole('group', { name: 'タグで絞る' }).getByRole('button', { name: 'すべて' }).click()
  await expect(page.getByTestId('event-row')).toHaveCount(2)
  expectNoPageErrors(state)
})
