// A やること a scheduled job made, on its card (tests/task-card-ui.tsx `?setwatch=…`, the job's part as AppShell composes it;
// jobs.md "The set watch (schema 5)" "The app (PR6)"). Guards: the meeting's name is said beside the date-only title from the
// card's own read; ［確かめて完了］ is the member's own press of the card's 完了 (never done for them); ［まだ早かった］ keeps the
// correction first, then takes the やること away (要らない) through the card at its version with the note; ［作ってもらう］ after a gate that could not
// judge starts 「この作業をする」 with when the やること was made and records nothing; a job's やること with no judgement on the
// member's view offers 「この作業をする」.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const OCC = 'occ.' + 'b'.repeat(32)
const TASK = 'task-' + 'b'.repeat(32)

test('進める: the meeting beside the title, ［確かめて完了］ completes through the card, ［まだ早かった］ records then takes it away', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { setwatch: 'proceed' })
  const card = page.getByTestId('task-card')
  await expect(card.getByRole('heading', { level: 1 })).toHaveText('11月24日の会議のたたき台を確かめる（A社 打ち合わせ）')
  const part = card.getByRole('region', { name: '定期の仕事から' })
  await expect(part).toContainText('AI がたたき台を作りました（AI は迷いました：確からしさ 低）')
  await expect(part.getByRole('button', { name: '作ってもらう' })).toHaveCount(0)
  await part.getByRole('button', { name: '確かめて完了' }).click()
  await expect(page.locator('#acted')).toHaveText('complete@3')
  await part.getByRole('button', { name: 'まだ早かった' }).click()
  await expect(page.locator('#acted')).toHaveText(`complete@3,feedback ${OCC} too_early,dismiss@3:AI のたたき台が早すぎたため`)
  expectNoPageErrors(state)
})

test('［まだ早かった］ refused by the server takes nothing away and says the server\'s words', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { setwatch: 'proceed', refuse: '1' })
  const part = page.getByTestId('task-card').getByRole('region', { name: '定期の仕事から' })
  await part.getByRole('button', { name: 'まだ早かった' }).click()
  await expect(part.getByRole('status')).toHaveText('定期の仕事が見つかりません。')
  await expect(page.locator('#acted')).toHaveText(`feedback ${OCC} too_early`)
  expectNoPageErrors(state)
})

test('［確かめて完了］ refused by the server says why where it was pressed', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { setwatch: 'proceed', refuse: 'complete' })
  const part = page.getByTestId('task-card').getByRole('region', { name: '定期の仕事から' })
  await part.getByRole('button', { name: '確かめて完了' }).click()
  await expect(part.getByRole('status')).toHaveText('サーバーに接続できませんでした。')
  expectNoPageErrors(state)
})

test('判断できなかった: ［作ってもらう］ starts the work fixed to when it was made, with no correction', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { setwatch: 'gate' })
  const part = page.getByTestId('task-card').getByRole('region', { name: '定期の仕事から' })
  await expect(part).toContainText('AI が判断できなかったため')
  await expect(part.getByRole('button', { name: 'まだ早かった' })).toHaveCount(0)
  await part.getByRole('button', { name: '作ってもらう' }).click()
  await expect(page.locator('#acted')).toHaveText(`consult ${TASK} work 2026-11-24T06:10:00.000Z`)
  expectNoPageErrors(state)
})

test('a job\'s やること with no judgement on the member\'s view offers 「この作業をする」', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { setwatch: 'none' })
  const part = page.getByTestId('task-card').getByRole('region', { name: '定期の仕事から' })
  await part.getByRole('button', { name: 'この作業をする' }).click()
  await expect(page.locator('#acted')).toHaveText(new RegExp(`^consult ${TASK} work `))
  await expect(part.getByRole('button', { name: '確かめて完了' })).toHaveCount(0)
  expectNoPageErrors(state)
})
