// The task list (tests/tasks-list-ui.tsx, features/tasks, tasks-ui.md). Guards: the sections by
// turn with today's meetings mixed in (to come with the member's turn, over with today's done);
// the far future folded until opened; the date view; 引き受ける from the list; finishing one's own
// task (start then complete at the versions it moves through); the one line adds a task with its
// due and tags; a tag narrows the list; a row opens its card; the 案件ごと view.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('by turn: sections, meetings mixed in, the far future folded, the date view', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const section = (name: string) => page.getByRole('region', { name, exact: true })
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

  // 〇〇ごと takes its word from the kinds in the list; each 案件 with its items, then 「案件なし」.
  await page.getByRole('button', { name: '案件ごと' }).click()
  await expect(section('A社 問い合わせ対応')).toContainText('お礼メールを確かめて送る')
  await expect(section('案件なし')).toContainText('見積書を作り直す')

  await page.getByRole('button', { name: '日付ごと' }).click()
  await expect(section('今日')).toContainText('お礼メールを確かめて送る')
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

  // ☑ completes at once from any state (task v9: no made-up start); not offered where the card decides.
  await expect(page.getByRole('button', { name: '「お礼メールを確かめて送る」を完了にする' })).toHaveCount(0)
  await page.getByRole('button', { name: '「見積書を作り直す」を完了にする' }).click()
  await expect(page.locator('#acted')).toHaveText('task-acc001:accept@2,task-mine02:complete@2')
  await expect(page.getByRole('region', { name: '今日終わったこと' })).toContainText('見積書を作り直す')
  await expect(page.getByRole('button', { name: '「見積書を作り直す」をやり直す' })).toBeVisible()
  // Asked with 確かめてから: the ☑ is 「終わったので見てもらう」 and it becomes the checker's turn.
  await page.getByRole('button', { name: '「提案書の数字を直す」を終わったので見てもらう' }).click()
  await expect(page.locator('#acted')).toContainText('task-chk001:request_review@2>u-abe')
  await expect(page.getByRole('region', { name: 'ほかの人の番・返事待ち' })).toContainText('提案書の数字を直す')

  await page.getByRole('button', { name: /日程の候補を探す/ }).click()
  await expect(page.getByTestId('card')).toHaveText('カード：task-ai0001')
  // The small chip of what it belongs to opens that 案件.
  await page.getByRole('link', { name: /A社 問い合わせ対応/ }).first().click()
  await expect(page.getByTestId('card')).toHaveText('カード：deal-a00001')
  expectNoPageErrors(state)
})

// Owner 2026-11-02: a task asked of someone else showed the task icon in a box-like shape, read as
// 「もう済んだ」. It shows 「人に頼んだもの」, and no row has a box it cannot press.
test('a task asked of someone else shows 「人に頼んだもの」, not a box', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const row = page.getByTestId('task-row').filter({ hasText: 'セキュリティ資料を送る' })
  await expect(row.getByRole('img', { name: '人に頼んだもの' })).toBeVisible()
  await expect(row.getByLabel('やること', { exact: true })).toHaveCount(0)
  await expect(row.getByRole('button', { name: /を完了にする/ })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('the one line adds a task with its due and tags; a tag narrows the list', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const input = page.getByRole('textbox', { name: 'やることを足す' })
  await input.fill('請求書を出す 明日15時まで #ｴｲｷﾞｮｳ')
  // What the line says shows in the chips under it (no window): 期限, the tag, 担当 自分.
  const preview = page.getByTestId('quick-add-chips')
  await expect(preview.getByRole('button', { name: '期限 明日 15:00' })).toBeVisible()
  await expect(preview).toContainText('担当 自分')
  await expect(preview).toContainText('あなただけに見えます')
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

test('担当 another person makes it 「頼む」 with 「終わったら」; the 案件 chip picks what it belongs to', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const input = page.getByRole('textbox', { name: 'やることを足す' })
  await input.fill('見積を直す')
  const chips = page.getByTestId('quick-add-chips')
  await chips.getByRole('button', { name: '担当 自分' }).click()
  await chips.getByRole('button', { name: '田中さん' }).click()
  await expect(chips.getByRole('button', { name: '田中さんに頼む' })).toBeVisible()
  await expect(chips.getByRole('button', { name: '終わったら：知らせるだけ' })).toBeVisible()
  await chips.getByRole('button', { name: '終わったら：知らせるだけ' }).click()
  await page.getByRole('button', { name: /確かめてから/ }).click()
  await chips.locator('[data-quick-chip="bundle"]').click()
  await page.getByRole('button', { name: 'C社 研修導入' }).click()
  await expect(page.getByText('Enter で頼む')).toBeVisible()
  await input.press('Enter')
  await expect(page.locator('#acted')).toContainText('"assignee":"u-tanaka","whenDone":"check","bundleId":"deal-c00001"')
  await expect(input).toHaveValue('')
  await expect(chips.getByRole('button', { name: '担当 自分' })).toBeVisible()
  expectNoPageErrors(state)
})

test('a tag suggested for the title (a reading variant) is added to the line only when picked', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const input = page.getByRole('textbox', { name: 'やることを足す' })
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
  // In the department's kind's name (営業部 → 案件), never 「まとまり」 (owner 2026-11-02).
  await expect(mine).toContainText('どの案件の会議か選んでください')
  await expect(mine).not.toContainText('まとまり')
  await mine.getByTestId('task-row').filter({ hasText: 'C社 打ち合わせ' }).getByRole('button', { name: '案件を選ぶ', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'どの案件の会議ですか？' })
  await dialog.getByLabel('案件を探す').fill('研修')
  await dialog.getByRole('button', { name: /C社 研修導入/ }).click()
  await expect(page.locator('#acted')).toHaveText('meeting-00aa11:bundle deal-c00001')
  await expect(dialog).toHaveCount(0)
  await expect(mine).not.toContainText('C社 打ち合わせ')
  expectNoPageErrors(state)
})

test('「『…』の会議ですか？」: はい links the suggested まとまり; ちがう／選ぶ opens the chooser instead', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const row = page.getByRole('region', { name: 'あなたの番' }).getByTestId('task-row').filter({ hasText: 'E社 打ち合わせ' })
  await expect(row).toContainText('『E社 研修導入』の会議ですか？')
  await row.getByRole('button', { name: 'ちがう／選ぶ' }).click()
  const dialog = page.getByRole('dialog', { name: 'どの案件の会議ですか？' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '閉じる' }).click()
  await expect(page.locator('#acted')).toHaveText('')
  await row.getByRole('button', { name: 'はい', exact: true }).click()
  await expect(page.locator('#acted')).toHaveText('meeting-00cc31:bundle deal-e00001')
  await expect(page.getByRole('region', { name: 'あなたの番' })).not.toContainText('E社 打ち合わせ')
  expectNoPageErrors(state)
})

test('meetings of one series are one row 「案件を選ぶ会議 n件」 that opens; 「案件はない」 closes a question without choosing', async ({ page }) => {
  const state = await openPreview(page, 'tasks-list')
  const mine = page.getByRole('region', { name: 'あなたの番' })
  const group = mine.getByTestId('bundle-group')
  await expect(group).toContainText('案件を選ぶ会議 2件')
  await expect(group).toContainText('D社 定例')
  await expect(mine).not.toContainText('D社 定例 第1回')
  await group.getByRole('button', { name: /案件を選ぶ会議 2件/ }).click()
  await expect(group.getByTestId('task-row')).toHaveCount(2)
  await group.getByTestId('task-row').filter({ hasText: 'D社 定例 第1回' }).getByRole('button', { name: '案件はない', exact: true }).click()
  await expect(page.locator('#acted')).toHaveText('meeting-00bb21:no bundle')
  // One left of the series: an ordinary row again.
  await expect(mine.getByTestId('bundle-group')).toHaveCount(0)
  const second = mine.getByTestId('task-row').filter({ hasText: 'D社 定例 第2回' })
  await expect(second).toHaveCount(1)
  // From the chooser too.
  await second.getByRole('button', { name: '案件を選ぶ', exact: true }).click()
  await page.getByRole('dialog', { name: 'どの案件の会議ですか？' }).getByRole('button', { name: '案件はない（社内の会議など）' }).click()
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
