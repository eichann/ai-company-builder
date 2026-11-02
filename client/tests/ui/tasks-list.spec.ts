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

test('a tag suggested for the title (a reading variant) is added to the line only when picked', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const input = page.getByRole('textbox', { name: 'やることを追加' })
  await input.fill('えいぎょう資料を直す')
  const suggested = page.getByLabel('タグの候補')
  await expect(suggested.getByRole('button', { name: '#営業' })).toBeVisible()
  await expect(input).toHaveValue('えいぎょう資料を直す')
  await suggested.getByRole('button', { name: '#営業' }).click()
  await expect(input).toHaveValue('えいぎょう資料を直す #営業 ')
  await expect(page.getByLabel('タグの候補')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a file dragged from the file tree onto a task row is linked to it, named inside the company folder', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const target = page.getByTestId('task-row').filter({ hasText: '見積書を作り直す' })
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.setData('application/x-file-paths', JSON.stringify(['/Users/me/company/営業/見積書_v2.xlsx']))
    return dt
  })
  await target.dispatchEvent('dragover', { dataTransfer: data })
  await target.dispatchEvent('drop', { dataTransfer: data })
  await expect(page.locator('#acted')).toHaveText('task-mine02:link 営業/見積書_v2.xlsx@2')
  await expect(page.getByRole('alert')).toContainText('「見積書_v2.xlsx」を「見積書を作り直す」につなぎました')
  expectNoPageErrors(state)
})

test('a meeting read without a まとまり asks in あなたの番; choosing links it and the item goes', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const mine = page.getByRole('region', { name: 'あなたの番' })
  await expect(mine).toContainText('どのまとまり（案件など）の会議か選んでください')
  await mine.getByTestId('task-row').filter({ hasText: 'C社 打ち合わせ' }).getByRole('button', { name: 'まとまりを選ぶ', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'どのまとまりの会議ですか？' })
  await dialog.getByLabel('まとまりを探す').fill('研修')
  await dialog.getByRole('button', { name: /C社 研修導入/ }).click()
  await expect(page.locator('#acted')).toHaveText('meeting-00aa11:bundle deal-c00001')
  await expect(dialog).toHaveCount(0)
  await expect(mine).not.toContainText('C社 打ち合わせ')
  expectNoPageErrors(state)
})

test('meetings of one series are one row that opens; 「まとまりはない」 closes a question without choosing', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const mine = page.getByRole('region', { name: 'あなたの番' })
  const group = mine.getByTestId('bundle-group')
  await expect(group).toContainText('まとまりを選ぶ会議 2件')
  await expect(group).toContainText('D社 定例')
  await expect(mine).not.toContainText('D社 定例 第1回')
  await group.getByRole('button', { name: /まとまりを選ぶ会議 2件/ }).click()
  await expect(group.getByTestId('task-row')).toHaveCount(2)
  await group.getByTestId('task-row').filter({ hasText: 'D社 定例 第1回' }).getByRole('button', { name: 'まとまりはない', exact: true }).click()
  await expect(page.locator('#acted')).toHaveText('meeting-00bb21:no bundle')
  // One left of the series: an ordinary row again.
  await expect(mine.getByTestId('bundle-group')).toHaveCount(0)
  const second = mine.getByTestId('task-row').filter({ hasText: 'D社 定例 第2回' })
  await expect(second).toHaveCount(1)
  // From the chooser too.
  await second.getByRole('button', { name: 'まとまりを選ぶ', exact: true }).click()
  await page.getByRole('dialog', { name: 'どのまとまりの会議ですか？' }).getByRole('button', { name: 'まとまりはない（社内の会議など）' }).click()
  await expect(page.locator('#acted')).toHaveText('meeting-00bb21:no bundle,meeting-00bb22:no bundle')
  await expect(mine).not.toContainText('D社 定例')
  expectNoPageErrors(state)
})

test('a task row\'s 「相談する」 asks for a consultation about that task, not opening its card', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const row = page.getByTestId('task-row').filter({ hasText: 'お礼メールを確かめて送る' })
  await row.hover()
  await row.getByRole('button', { name: '相談する' }).click()
  await expect(page.locator('#acted')).toHaveText('consult task-mine01')
  await expect(page.getByTestId('card')).toHaveCount(0)
  expectNoPageErrors(state)
})
