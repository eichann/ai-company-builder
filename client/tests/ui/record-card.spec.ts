// The record screens (tests/record-card-ui.tsx, features/records RecordCard; tasks-ui.md "The card",
// 「Every record opens in one layout」). Guards: a meeting's summary is its body with 決めたこと and 宿題
// apart, its documents open outside; 「つながっているもの」 shows three per kind and folds the rest;
// a 来た連絡 shows its summary (no body) with 「Slack で開く」 and the screen's thread slot.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('a meeting: the summary as its body, 決めたこと and 宿題 apart, the documents opened outside', async ({ page }) => {
  const state = await openPreview(page, 'record-card')
  const card = page.getByTestId('record-card')
  const body = card.getByRole('article')
  await expect(body.getByRole('region', { name: '要約' })).toContainText('窓口を2つから3つに増やす方向で合意')
  await expect(card).toContainText('参加 佐藤・阿部・社外 2人')
  await expect(card.locator('[data-seen]')).toHaveText('営業部のみんな')
  await expect(body.getByRole('region', { name: '決めたこと' })).toContainText('窓口は3つにする')
  await expect(body.getByRole('region', { name: '宿題' })).toContainText('宿題 4')

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
  await expect(card.getByRole('region', { name: '要約' })).toContainText('要約（本文は Slack にあります）先日の打ち合わせ資料')
  await expect(page.getByTestId('thread')).toHaveText('スレッドの前後と返事の下書き：資料送付のお願い')
  await card.getByRole('button', { name: /Slack で開く/ }).click()
  await expect(page.locator('#opened')).toHaveText('https://slack.com/archives/C0123ABCD/p1730800000123456')
  expectNoPageErrors(state)
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
  await expect(card.getByRole('status')).toContainText('AI が反映しました：承認のお願い 1件を作りました')
  // The right column starts with the 案件's own やること, each saying whose turn it is.
  const side = card.getByRole('complementary', { name: 'つながっているもの' })
  await expect(side.getByRole('region').first()).toHaveAccessibleName('やること')
  await expect(side.getByRole('region', { name: 'やること' })).toContainText('スケジュール案を出す阿部さんの番')
  expectNoPageErrors(state)

  const working = await openPreview(page, 'record-card', { record: 'bundle', ai: 'working' })
  await expect(page.getByTestId('record-card').getByRole('status')).toHaveText('AI が反映しています…（あと少し）')
  expectNoPageErrors(working)
})

test('「AIへの相談」 in 「つながっているもの」: the consultations about it, 「相談する」 and 「＋新しい相談」', async ({ page }) => {
  const state = await openPreview(page, 'record-card')
  const group = page.getByRole('complementary', { name: 'つながっているもの' }).getByRole('region', { name: 'AIへの相談' })
  await expect(group).toContainText('A社 打ち合わせのあと')
  await group.getByRole('button', { name: '相談する' }).click()
  await group.getByRole('button', { name: '新しい相談' }).click()
  await expect(page.locator('#opened')).toHaveText('consult meeting-0000aa false\nconsult meeting-0000aa true')
  expectNoPageErrors(state)
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
