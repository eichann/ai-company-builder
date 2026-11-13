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
  // 済んだ ends it: the screen closes its tab and automatic consultations (owner FB #29).
  await expect(page.locator('#opened')).toHaveText('act interaction-0000bb settle@3\nended interaction-0000bb')
  await expect(card).toContainText('対応済み')
  await expect(card.getByRole('button', { name: '済んだ', exact: true })).toHaveCount(0)
  await card.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#opened')).toHaveText('act interaction-0000bb settle@3\nended interaction-0000bb\nundo interaction-0000bb 4@4')
  await expect(card).toContainText('確認待ち')

  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /取り込まない/ }).click()
  await expect(page.locator('#opened')).toContainText('act interaction-0000bb drop@5')
  // 取り込まない only moves it aside: nothing closes.
  await expect(page.locator('#opened')).not.toContainText('drop@5\nended')
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
  await expect(page.locator('#opened')).toHaveText('act reply_request-0000c1 close@3\nended reply_request-0000c1')
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

// 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト"): 参加者 on the 案件's card.
test('a 非公開 案件 shows who takes part; who may change it adds and takes off, others only see the names', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'bundle', private: 'edit' })
  const box = page.getByRole('region', { name: '参加者' })
  await expect(box).toContainText('見られる人：『A社 研修導入』の参加者（3人）')
  await expect(box).toContainText('佐藤')
  await expect(box).toContainText('ほかに管理者 1人')
  await box.getByRole('button', { name: '参加者を足す' }).click()
  await box.getByLabel('足す人').selectOption({ label: '加藤' })
  await expect(page.locator('#opened')).toHaveText('members scope-1 viewers=u-sato|u-abe|u-kato editors=u-sato|u-kato')
  await expect(box).toContainText('加藤')
  await box.getByRole('button', { name: '阿部さんを外す' }).click()
  await expect(page.getByText('阿部さんのパソコンにあるこの案件のフォルダも消えます')).toBeVisible()
  await page.getByRole('button', { name: '外す', exact: true }).click()
  await expect(page.locator('#opened')).toContainText('members scope-1 viewers=u-sato|u-kato editors=u-sato|u-kato')
  expectNoPageErrors(state)

  const reader = await openPreview(page, 'record-card', { record: 'bundle', private: 'read' })
  const named = page.getByRole('region', { name: '参加者' })
  await expect(named).toContainText('阿部')
  await expect(named.getByRole('button', { name: '参加者を足す' })).toHaveCount(0)
  await expect(named.getByRole('button', { name: /を外す$/ })).toHaveCount(0)
  expectNoPageErrors(reader)
})

// 「使う機能」 (owner decision 2026-11-07): a record of a feature turned off is 「見るだけ」 — the card
// says so and offers nothing to press. Catches the note missing and ［済んだ］ / ［取り込まない］ still shown.
test('a record of a feature turned off: 「この機能は今オフです」 and nothing to press', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'slack', off: '1' })
  const card = page.getByTestId('record-card')
  await expect(card.getByTestId('feature-off')).toContainText('この機能は今オフです')
  await expect(card.getByText('資料送付のお願い').first()).toBeVisible()
  await expect(card.getByRole('button', { name: '済んだ', exact: true })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a record whose feature is on has no such note', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'slack' })
  const card = page.getByTestId('record-card')
  await expect(card.getByRole('button', { name: '済んだ', exact: true })).toBeVisible()
  await expect(card.getByTestId('feature-off')).toHaveCount(0)
  expectNoPageErrors(state)
})

// Owner FB #30: a プロジェクト could not be ended in the app. Its 責任者 gets ［終える］ beside the title and
// ［やめる］ (with an optional reason), 責任者を替える, 期限を変える, なんのためを書く in 「…」; ending tells the screen
// (its tab and automatic consultations close); a finished one offers ［もう一度始める］, which does not.
test('a プロジェクト: its 責任者 ends it with ［終える］ (the screen is told), 取り消す; ［やめる］ in 「…」 asks for an optional reason; ［もう一度始める］', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'project' })
  const card = page.getByTestId('record-card')
  const opened = page.locator('#opened')
  await card.getByRole('button', { name: '終える', exact: true }).click()
  await expect(opened).toHaveText('act project-0000p1 finish@3\nended project-0000p1')
  await expect(card.getByRole('button', { name: '終える', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'もう一度始める' })).toBeVisible()
  await expect(card.getByRole('status')).toContainText('終えました')
  // 取り消す is offered like the other record actions (the real screen has closed the tab by then).
  await card.getByRole('status').getByRole('button', { name: '取り消す' }).click()
  await expect(opened).toContainText('undo project-0000p1 4@4')
  await expect(card.getByRole('button', { name: '終える', exact: true })).toBeVisible()

  await card.getByRole('button', { name: 'その他の操作' }).click()
  for (const name of ['責任者を替える', '期限を変える', 'なんのためを書く']) await expect(page.getByRole('menuitem', { name: new RegExp(name) })).toBeVisible()
  await page.getByRole('menuitem', { name: /やめる/ }).click()
  const dialog = page.getByRole('dialog', { name: 'やめる' })
  await expect(dialog).toContainText('一覧から外れ、このタブは閉じます。消しません')
  await dialog.getByRole('textbox', { name: '理由' }).fill('予算がなくなった')
  await dialog.getByRole('button', { name: 'やめる' }).click()
  await expect(opened).toContainText('act project-0000p1 cancel@5 note=予算がなくなった\nended project-0000p1')
  await expect(dialog).toHaveCount(0)

  // A finished one: only ［もう一度始める］, and bringing it back closes nothing.
  await card.getByRole('button', { name: 'もう一度始める' }).click()
  await expect(opened).toContainText('act project-0000p1 reopen@6')
  await expect(opened).not.toContainText('reopen@6\nended')
  await expect(card.getByRole('button', { name: '終える', exact: true })).toBeVisible()
  expectNoPageErrors(state)
})

test('a プロジェクト: 期限を変える and 責任者を替える send the values chosen, prefilled with today\'s, and end nothing', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'project' })
  const card = page.getByTestId('record-card')
  const opened = page.locator('#opened')
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /期限を変える/ }).click()
  const due = page.getByRole('dialog', { name: '期限を変える' })
  await expect(due.getByLabel('期限')).toHaveValue('2026-12-01')
  await due.getByLabel('期限').fill('2026-12-15')
  await due.getByRole('button', { name: '期限を変える' }).click()
  await expect(opened).toHaveText('act project-0000p1 set_due@3 {"due":"2026-12-15"}')
  await expect(card.getByRole('status')).toContainText('期限を変えました')

  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /責任者を替える/ }).click()
  const owner = page.getByRole('dialog', { name: '責任者を替える' })
  await owner.getByLabel('責任者').selectOption({ label: '阿部さん' })
  await owner.getByRole('button', { name: '責任者を替える' }).click()
  await expect(opened).toContainText('act project-0000p1 set_owner@4 {"owner":"u-abe"}')
  await expect(opened).not.toContainText('ended')
  // No longer its 責任者: nothing left to press (the server would refuse it).
  await expect(card.getByRole('button', { name: '終える', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'その他の操作' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a プロジェクト someone else is responsible for: no button to end or change it', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'project', owner: 'other' })
  const card = page.getByTestId('record-card')
  await expect(card).toContainText('新人研修の見直し')
  await expect(card.getByRole('button', { name: '終える', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'その他の操作' })).toHaveCount(0)
  expectNoPageErrors(state)
})

// A プロジェクト links Google Drive files like a やること (owner decision 2026-11-13; records.md "Drive and PC file links"):
// ［Google Drive のファイルをつなぐ］ offers the member's own files first, then Google's chooser; a pasted or dropped Drive link
// opens the chooser on that file; the member's own linked file by name, someone else's as 「Google Drive のファイル」, both
// opened in Drive, and taken off from 「…」. Not set up for the company: the button is off with the plain note.
test('a プロジェクト links Google Drive files: own list, chooser, a pasted / dropped link; names only for the linker; opened in Drive; taken off', async ({ page }) => {
  const ID = '1AbC-def_GhIjKlMnOpQrStUv'
  const state = await openPreview(page, 'record-card', { record: 'project', drive: '1' })
  const links = page.getByTestId('record-card').getByRole('complementary', { name: 'つながっているもの' })
  const opened = page.locator('#opened')
  await expect(links).toContainText('研修の進め方（作業中）')
  await expect(links).toContainText('Google Drive のファイルは、このプロジェクトを見られる人みんなにリンクが見えます（名前は、つないだ人だけ）。開けるのは Drive で共有されている人だけで、つないでも共有はされません')
  await links.getByRole('button', { name: 'Google Drive のファイルをつなぐ' }).click()
  const list = links.getByRole('group', { name: 'つなぐ Google Drive のファイル' })
  await list.getByRole('checkbox', { name: /去年の研修資料\.pdf/ }).check()
  await list.getByRole('button', { name: 'つなぐ', exact: true }).click()
  await expect(opened).toHaveText('drive project-0000p1@3 chosen=1PickedEarlier001')
  await expect(page.getByTestId('record-card').getByRole('status').filter({ hasText: '「去年の研修資料.pdf」をつなぎました' })).toBeVisible()

  const box = links.getByRole('textbox', { name: 'Google Drive のリンクを貼りつけてつなぐ' })
  await box.fill(`https://docs.google.com/document/d/${ID}/edit`)
  await box.press('Enter')
  await expect(opened).toContainText(`drive project-0000p1@3 show=${ID}`)
  await box.fill('https://example.com/not-drive')
  await box.press('Enter')
  await expect(links.getByRole('alert')).toHaveText('Google Drive のファイルのリンクではないため、つなげません。')
  const data = await page.evaluateHandle(url => { const dt = new DataTransfer(); dt.setData('text/uri-list', url); return dt }, `https://drive.google.com/file/d/${ID}/view`)
  await links.dispatchEvent('dragover', { dataTransfer: data })
  await links.dispatchEvent('drop', { dataTransfer: data })
  await expect(opened).toHaveText(`drive project-0000p1@3 chosen=1PickedEarlier001\ndrive project-0000p1@3 show=${ID}\ndrive project-0000p1@3 show=${ID}`)

  // Someone else's file: neutral words; opened in Drive.
  await links.getByRole('button', { name: /^Google Drive のファイル(?!をつなぐ)/ }).first().click()
  await expect(opened).toContainText('https://drive.google.com/file/d/1ProjDocOther001/view')
  await page.getByRole('button', { name: '「研修の進め方（作業中）」の操作' }).click()
  await page.getByRole('menuitem', { name: /つながりを外す/ }).click()
  await expect(opened).toContainText('unlinkTarget project-0000p1 drive 1ProjDocMine0001@3')
  await expect(page.getByTestId('record-card').getByRole('status').filter({ hasText: '「研修の進め方（作業中）」とのつながりを外しました' })).toBeVisible()
  expectNoPageErrors(state)

  await openPreview(page, 'record-card', { record: 'project', drive: 'off' })
  await expect(links.getByRole('button', { name: 'Google Drive のファイルをつなぐ' })).toBeDisabled()
  await expect(links.locator('[data-drive-link-note]')).toContainText('会社の管理者による準備が必要です')
})

test('a プロジェクト whose type offers no Drive link (or any other record card) has no Drive button', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'project' })
  const links = page.getByTestId('record-card').getByRole('complementary', { name: 'つながっているもの' })
  await expect(page.getByTestId('record-card')).toBeVisible()
  await expect(links.getByRole('button', { name: 'Google Drive のファイルをつなぐ' })).toHaveCount(0)
  await openPreview(page, 'record-card', { record: 'meeting' })
  await expect(page.getByTestId('record-card').getByRole('button', { name: 'Google Drive のファイルをつなぐ' })).toHaveCount(0)
  expectNoPageErrors(state)
})

// Owner FB #34 (2026-11-13): a プロジェクト the AI made without a 責任者 had no button for anyone. Project v2's
// 責任者を替える has `who_fallback: [anyone]`: every reader gets that one action (never 終える / やめる);
// once a 責任者 is named, the card is the 責任者's as before.
test('a プロジェクト without a 責任者: only 責任者を替える, and after naming oneself ［終える］', async ({ page }) => {
  const state = await openPreview(page, 'record-card', { record: 'project', owner: 'none' })
  const card = page.getByTestId('record-card')
  const opened = page.locator('#opened')
  await expect(card.getByRole('button', { name: '終える', exact: true })).toHaveCount(0)
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await expect(page.getByRole('menuitem')).toHaveCount(1)
  await page.getByRole('menuitem', { name: /責任者を替える/ }).click()
  const owner = page.getByRole('dialog', { name: '責任者を替える' })
  await owner.getByLabel('責任者').selectOption({ label: '自分（佐藤）' })
  await owner.getByRole('button', { name: '責任者を替える' }).click()
  await expect(opened).toContainText('act project-0000p1 set_owner@3 {"owner":"u-sato"}')
  await expect(card.getByRole('button', { name: '終える', exact: true })).toBeVisible()
  expectNoPageErrors(state)
})

// FB #36: a long URL in なんのため ran into the next tile (進み具合). It wraps inside its own tile now.
test('a プロジェクト: a long URL in なんのため wraps inside its tile', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 })
  const state = await openPreview(page, 'record-card', { record: 'project', purpose: 'url' })
  const card = page.getByTestId('record-card')
  await expect(card).toContainText('https://docs.google.com/document/d/')
  const boxes = await card.evaluate(root => {
    const label = (t: string) => [...root.querySelectorAll('div')].find(d => d.children.length === 0 && d.textContent === t)?.parentElement ?? null
    const purpose = label('なんのため')
    const next = label('責任者')
    const text = purpose?.lastElementChild as HTMLElement | null
    if (!purpose || !next || !text) return null
    return { right: Math.max(text.getBoundingClientRect().right, purpose.getBoundingClientRect().left + purpose.scrollWidth), tileRight: purpose.getBoundingClientRect().right, nextLeft: next.getBoundingClientRect().left, overflow: text.scrollWidth - text.clientWidth }
  })
  expect(boxes).not.toBeNull()
  expect(boxes!.overflow).toBeLessThanOrEqual(0)
  expect(boxes!.right).toBeLessThanOrEqual(boxes!.tileRight + 0.5)
  expect(boxes!.tileRight).toBeLessThanOrEqual(boxes!.nextLeft)
  expectNoPageErrors(state)
})
