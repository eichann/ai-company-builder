// The record screens (tests/record-card-ui.tsx, features/records RecordCard; tasks-ui.md "The card",
// 「Every record opens in one layout」). Guards: a meeting's summary is its body with 決めたこと and やること
// apart, its documents open outside; 「つながっているもの」 shows three per kind and folds the rest;
// a 来た連絡 shows its summary (no body) with 「Slack で開く」 and the screen's thread slot.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('a meeting: the summary as its body, 決めたこと and やること apart, the documents opened outside', async ({ page }) => {
  const state = await openPreview(page, 'record-card')
  const card = page.getByTestId('record-card')
  const body = card.getByRole('article')
  await expect(body.getByRole('region', { name: '要約' })).toContainText('窓口を2つから3つに増やす方向で合意')
  await expect(card).toContainText('参加 佐藤・阿部・社外 2人')
  await expect(card.locator('[data-seen]')).toHaveText('営業部のみんな')
  await expect(body.getByRole('region', { name: '決めたこと' })).toContainText('窓口は3つにする')
  await expect(body.getByRole('region', { name: 'やること' })).toContainText('宿題 4')

  await card.getByRole('button', { name: /Gemini のメモを開く/ }).click()
  await card.getByRole('button', { name: /文字起こしを開く/ }).click()
  await card.getByRole('button', { name: /カレンダーの予定を開く/ }).click()
  await expect(page.locator('#opened')).toHaveText([
    'https://docs.google.com/document/d/notesDoc12345/edit',
    'https://docs.google.com/document/d/transcriptDoc123/edit',
    'https://calendar.google.com/calendar/r/day/2026/11/5',
  ].join('\n'))
  expectNoPageErrors(state)
})

test('「つながっているもの」: three per kind, the rest under 「ほか n 件」 until opened', async ({ page }) => {
  const state = await openPreview(page, 'record-card')
  const tasks = page.getByRole('complementary', { name: 'つながっているもの' }).getByRole('region', { name: 'やること' })
  await expect(tasks.getByRole('listitem')).toHaveCount(3)
  await tasks.getByRole('button', { name: 'ほか 1 件' }).click()
  await expect(tasks.getByRole('listitem')).toHaveCount(4)
  await tasks.getByRole('button', { name: 'たたむ' }).click()
  await expect(tasks.getByRole('listitem')).toHaveCount(3)
  expectNoPageErrors(state)
})

test('a 来た連絡 from Slack: its summary (the body stays in Slack), 「Slack で開く」, the thread slot', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'slack' })
  const card = page.getByTestId('record-card')
  await expect(card).toContainText('来た連絡')
  await expect(card).toContainText('返事が要る')
  await expect(card.locator('[data-seen]')).toHaveText('あなただけ')
  await expect(card).toContainText('山田 様（C社） から・Slack')
  // Owner FB 2026-11-04: the state chip read the raw 「unsure」.
  await expect(card).toContainText('確認待ち')
  await expect(card).not.toContainText('unsure')
  await expect(card.getByRole('region', { name: '要約' })).toContainText('要約（本文は Slack にあります）先日の打ち合わせ資料')
  await expect(page.getByTestId('thread')).toHaveText('スレッドの前後と返事の下書き：資料送付のお願い')
  await card.getByRole('button', { name: /Slack で開く/ }).click()
  await expect(page.locator('#opened')).toHaveText('https://slack.com/archives/C0123ABCD/p1730800000123456')
  expectNoPageErrors(state)
})

// Owner FB #20: a 確認待ち message whose talk was over could not be closed. Catches the main button,
// the 「…」 item or 元に戻す missing, and a press at another version than the one shown.
test('a 来た連絡 to confirm: ［済んだ］ closes it (「済んだ」, ［元に戻す］ brings it back); 「…」 ［取り込まない］', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'slack' })
  const card = page.getByTestId('record-card')
  await card.getByRole('button', { name: '済んだ', exact: true }).click()
  await expect(page.locator('#opened')).toHaveText('act interaction-0000bb settle@3')
  await expect(card).toContainText('対応済み')
  await expect(card.getByRole('button', { name: '済んだ', exact: true })).toHaveCount(0)
  await card.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#opened')).toHaveText('act interaction-0000bb settle@3\nundo interaction-0000bb 4@4')
  await expect(card).toContainText('確認待ち')

  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /取り込まない/ }).click()
  await expect(page.locator('#opened')).toContainText('act interaction-0000bb drop@5')
  await expect(card).toContainText('やることにしなかった')
  await expect(card.getByRole('button', { name: '済んだ', exact: true })).toHaveCount(0)
  // Right after, 取り消す takes it back.
  await card.getByRole('status').getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#opened')).toContainText('undo interaction-0000bb 6@6')
  await expect(card).toContainText('確認待ち')
  expectNoPageErrors(state)

  // Its 返事のお願い still open: the member is told to end it there (［済んだ］ never ends another record).
  const replies = await openPreview(page, 'record-card', { record: 'slack', replies: 'open' })
  await expect(page.getByTestId('record-card').getByRole('note')).toContainText('［もう返した］')
  expectNoPageErrors(replies)
})

// Owner report 2026-11-05: a 返事のお願い sat in 「AI が確かめている」 after the member's reply, with nothing to press.
test('a 返事のお願い in the AI\'s turn: its person\'s ［終わりにする］ ends it (「終わった」), 取り消す gives it back; 「…」 ［もう返した］', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'reply' })
  const card = page.getByTestId('record-card')
  await expect(card).toContainText('AI が確かめている')
  await card.getByRole('button', { name: '終わりにする' }).click()
  await expect(page.locator('#opened')).toHaveText('act reply_request-0000c1 close@3')
  await expect(card).toContainText('終わった')
  await expect(card.getByRole('button', { name: '終わりにする' })).toHaveCount(0)
  await card.getByRole('status').getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#opened')).toContainText('undo reply_request-0000c1 4@4')
  await expect(card).toContainText('AI が確かめている')
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await expect(page.getByRole('menuitem', { name: /もう返した/ })).toBeVisible()
  expectNoPageErrors(state)

  // An older server's type (close only from 返事をする / 返事待ち): no button it would refuse.
  const older = await openPreview(page, 'record-card', { record: 'reply', type: 'v4' })
  await expect(page.getByTestId('record-card')).toContainText('AI が確かめている')
  await expect(page.getByTestId('record-card').getByRole('button', { name: '終わりにする' })).toHaveCount(0)
  expectNoPageErrors(older)
})

test('a 案件: what for, who and how far, the approval request as its card, everyone\'s やること by turn, what the AI did', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'bundle' })
  const card = page.getByTestId('record-card')
  const body = card.getByRole('article')
  await expect(body).toContainText('なんのため新人研修の窓口を3つにする')
  await expect(body).toContainText('責任者阿部さん')
  await expect(body).toContainText('進み具合3つのうち 1つ終わった')
  await expect(page.getByTestId('approval')).toHaveText('承認のお願いのカード：approval-0000dd')
  const everyone = body.getByRole('region', { name: 'みんなのやること' })
  await expect(everyone.getByRole('region', { name: 'あなたの番' })).toContainText('見積書を作り直すあなたの番・11/7 17:00')
  await expect(everyone.getByRole('region', { name: 'ほかの人の番・返事待ち' })).toContainText('スケジュール案を出す阿部さんの番')
  await expect(everyone.getByRole('region', { name: '終わったこと' })).toContainText('お礼メールを送る')
  // One line in fixed words; what it did (and the AI's step names) only in 経緯, opened from the band.
  const band = card.getByRole('status')
  await expect(band).toHaveText(/^AI が反映しました（11\/5 15:38）経緯で見る$/)
  await band.getByRole('button', { name: '経緯で見る' }).click()
  await expect(card.getByRole('region', { name: '経緯' })).toContainText('承認のお願い 1件を作りました')
  // The right column starts with the 案件's own やること, each saying whose turn it is.
  const side = card.getByRole('complementary', { name: 'つながっているもの' })
  await expect(side.getByRole('region').first()).toHaveAccessibleName('やること')
  await expect(side.getByRole('region', { name: 'やること' })).toContainText('スケジュール案を出す阿部さんの番')
  expectNoPageErrors(state)

  const working = await openPreview(page, 'record-card', { record: 'bundle', ai: 'working' })
  await expect(page.getByTestId('record-card').getByRole('status')).toHaveText('AI が反映しています…（あと少し）')
  expectNoPageErrors(working)
})

// Owner 2026-11-02: with a consultation already, its row opens it, so 「相談する」 would only repeat
// it — only 「＋新しい相談」 (fresh); with none, only 「相談する」. Catches both buttons shown again.
test('「AIへの相談」 in 「つながっているもの」: with consultations only 「＋新しい相談」, with none only 「相談する」', async ({ page }) => {
  const state = await openPreview(page, 'record-card')
  const group = page.getByRole('complementary', { name: 'つながっているもの' }).getByRole('region', { name: 'AIへの相談' })
  await expect(group).toContainText('A社 打ち合わせのあと')
  await expect(group.getByRole('button', { name: '相談する' })).toHaveCount(0)
  await group.getByRole('button', { name: '新しい相談' }).click()
  await expect(page.locator('#opened')).toHaveText('consult meeting-0000aa true')
  expectNoPageErrors(state)

  const none = await openPreview(page, 'record-card', { consult: 'none' })
  const empty = page.getByRole('complementary', { name: 'つながっているもの' }).getByRole('region', { name: 'AIへの相談' })
  await expect(empty.getByRole('button', { name: '新しい相談' })).toHaveCount(0)
  await empty.getByRole('button', { name: '相談する' }).click()
  await expect(page.locator('#opened')).toHaveText('consult meeting-0000aa false')
  expectNoPageErrors(none)
})

test('a meeting\'s 案件 sits at its head (not on the right); a link is taken off from its 「…」 and put back', async ({ page }) => {
  const state = await openPreview(page, 'record-card')
  await expect(page.getByTestId('bundle-field')).toHaveText('A社 研修導入・外せる')
  const side = page.getByRole('complementary', { name: 'つながっているもの' })
  await expect(side).not.toContainText('A社 研修導入')
  await side.getByRole('button', { name: '「窓口は3つにする」の操作' }).click()
  await page.getByRole('menuitem', { name: /つながりを外す/ }).click()
  await expect(page.locator('#opened')).toHaveText('unlink decision-000001 meeting=meeting-0000aa@3')
  await side.getByRole('status').getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#opened')).toHaveText('unlink decision-000001 meeting=meeting-0000aa@3\nundo decision-000001 4@4')
  expectNoPageErrors(state)
})

test('「新しいプロジェクトにする」: the name from the meeting, its 相手, similar ones first, and the 宿題 put in', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { field: 'real' })
  const field = page.getByTestId('record-card').getByRole('group', { name: 'プロジェクト' })
  await field.getByRole('button', { name: '新しいプロジェクトにする' }).click()
  const dialog = page.getByRole('dialog', { name: '新しいプロジェクトにする' })
  await expect(dialog.getByLabel('名前')).toHaveValue('A社 研修導入のお打ち合わせ')
  await expect(dialog).toContainText('株式会社エー（A社）')
  await expect(dialog.getByRole('group', { name: '似たプロジェクト' })).toContainText('A社 研修導入の相談（去年）')
  await expect(dialog.getByRole('group', { name: '似たプロジェクト' })).not.toContainText('B社 新人研修')
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await expect(dialog).toContainText('この会議の宿題（3）も入れる')
  await dialog.getByRole('button', { name: '作る' }).click()
  // A meeting is seen by its attendees only: who will see part of it is said before anything is made.
  await expect(page.getByText('プロジェクトにつなぐと、この会議の内容の一部（次のアクションなど）がこのプロジェクトを見られる人に見えます。')).toBeVisible()
  await expect(page.locator('#opened')).toHaveText('')
  await page.getByRole('button', { name: 'つなぐ', exact: true }).click()
  await expect(page.locator('#opened')).toHaveText([
    'create project A社 研修導入のお打ち合わせ folder=営業部 counterpart=company-0000ff',
    'linkMeeting meeting-0000aa=project-0000nn',
    'link task-000001 bundle=project-0000nn@2', 'link task-000002 bundle=project-0000nn@2', 'link task-000003 bundle=project-0000nn@2',
  ].join('\n'))
  await expect(page.getByRole('status')).toContainText('「A社 研修導入のお打ち合わせ」を作り、つなぎました（宿題 3件も入れました）')
  expectNoPageErrors(state)
})

test('a row of 「つながっているもの」 says no raw type name under it (never 「タスク」)', async ({ page }) => {
  const state = await openPreview(page, 'record-card')
  await expect(page.getByRole('complementary', { name: 'つながっているもの' })).not.toContainText('タスク')
  expectNoPageErrors(state)
})

// 「落とすと、つながります」 on any record (owner decision 2026-11-03): a やること from the list dropped on
// a 案件 becomes that 案件's (the link is the やること's own `bundle`), with ［取り消す］ on the やること.
test('a やること dropped on a 案件 is linked to it, held by the やること, with ［取り消す］', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'bundle' })
  const links = page.getByRole('complementary', { name: 'つながっているもの' })
  const data = await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.setData('application/x-acb-record', JSON.stringify({ id: 'task-0000zz', title: '会場を押さえる' })); return dt })
  await links.dispatchEvent('dragover', { dataTransfer: data })
  await links.dispatchEvent('drop', { dataTransfer: data })
  await expect(page.locator('#opened')).toHaveText('drop deal-0000cc task-0000zz dropped:bundle')
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/drop-on-deal.png` })
  await links.getByRole('status').filter({ hasText: 'をつなぎました' }).getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#opened')).toContainText('undo task-0000zz 9@9')
  expectNoPageErrors(state)
})
