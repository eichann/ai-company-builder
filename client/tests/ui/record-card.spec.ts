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
  await expect(card).toContainText('山田 様（C社） から・Slack')
  await expect(card.getByRole('region', { name: '要約' })).toContainText('要約（本文は Slack にあります）先日の打ち合わせ資料')
  await expect(page.getByTestId('thread')).toHaveText('スレッドの前後と返事の下書き：資料送付のお願い')
  await card.getByRole('button', { name: /Slack で開く/ }).click()
  await expect(page.locator('#opened')).toHaveText('https://slack.com/archives/C0123ABCD/p1730800000123456')
  expectNoPageErrors(state)
})
