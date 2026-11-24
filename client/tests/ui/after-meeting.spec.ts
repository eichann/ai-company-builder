// 「会議のあと」 (4b-4 PR6-A, tests/after-meeting-ui.tsx; jobs.md "The 4b-4 screens (PR6-A)"). Guards: with the company's switch off
// nothing of it is drawn or read; ［反映する］ hands one consultation only the ticked items with the member's values, never the
// minutes' quote unless chosen, after a last check, once (a double press records one press); an approval waits by its id with
// ［開く］; the weekly report's ［作り直す］ first says to delete this week's section by hand.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const asked = (page: Page) => page.evaluate(() => (window as unknown as { __acbAfterMeeting: Array<Record<string, unknown>> }).__acbAfterMeeting)

test('the company\'s switch off: nothing is drawn and nothing is read', async ({ page }) => {
  const state = await openPreview(page, 'after-meeting', { off: '1' })
  await expect(page.getByRole('region', { name: '会議のあとの更新案' })).toHaveCount(0)
  expect(await asked(page)).toEqual([])
  expectNoPageErrors(state)
})

test('［反映する］ hands only the ticked items with the member\'s values after a last check, once', async ({ page }) => {
  const state = await openPreview(page, 'after-meeting')
  const card = page.getByRole('region', { name: '会議のあとの更新案' })
  await card.getByRole('combobox', { name: '1001 の 確度' }).selectOption('A（高）')
  await expect(card.getByText('直しました')).toBeVisible()
  await card.getByRole('listitem', { name: '1001 の 金額' }).getByRole('checkbox').uncheck()
  await card.getByRole('button', { name: '反映する' }).click()
  const dialog = page.getByRole('dialog', { name: 'この内容で反映しますか？' })
  await expect(dialog).toContainText('次の 2 件だけを')
  await expect(dialog).not.toContainText('来月から始めたい')
  await dialog.getByRole('button', { name: 'この内容で反映する' }).dblclick()
  await expect(card.getByRole('button', { name: '反映中…' })).toBeVisible()
  await expect(card.getByRole('button', { name: '反映する' })).toHaveCount(0)
  const presses = (await asked(page)).filter(a => 'note' in a || 'consult' in a)
  expect(presses).toHaveLength(2)
  const consult = presses[1].consult as { purpose: string; detail: string }
  expect(consult.purpose).toBe('work')
  expect(consult.detail).toContain('"値": "A（高）"')
  expect(consult.detail).not.toContain('"項目": "金額"')
  expect(consult.detail).not.toContain('来月から始めたい')
  expect(consult.detail).toContain('導入時期が決まった')
  expectNoPageErrors(state)
})

test('a consultation that does not start takes the press back and says so', async ({ page }) => {
  const state = await openPreview(page, 'after-meeting', { nostart: '1' })
  const card = page.getByRole('region', { name: '会議のあとの更新案' })
  await card.getByRole('button', { name: '反映する' }).click()
  await page.getByRole('button', { name: 'この内容で反映する' }).click()
  await expect(card.getByText('相談を始められませんでした')).toBeVisible()
  await expect(card.getByRole('button', { name: '反映する' })).toBeEnabled()
  expect((await asked(page)).filter(a => 'note' in a).map(a => (a.note as { kind: string }).kind)).toEqual(['apply', 'cancel'])
  expectNoPageErrors(state)
})

test('the minutes\' quote goes only when the member ticks it', async ({ page }) => {
  const state = await openPreview(page, 'after-meeting')
  const card = page.getByRole('region', { name: '会議のあとの更新案' })
  await card.getByRole('checkbox', { name: '議事録の引用も渡す' }).check()
  await card.getByRole('button', { name: '反映する' }).click()
  await expect(page.getByRole('dialog')).toContainText('来月から始めたい')
  await page.getByRole('button', { name: 'この内容で反映する' }).click()
  const consult = (await asked(page)).find(a => 'consult' in a)!.consult as { detail: string }
  expect(consult.detail).toContain('来月から始めたい')
  expectNoPageErrors(state)
})

test('an approval waits by its id: 〇〇さんの承認待ち with ［開く］', async ({ page }) => {
  const state = await openPreview(page, 'after-meeting', { result: 'approval' })
  const item = page.getByRole('listitem', { name: '1001 の 金額' })
  await expect(item).toContainText('田中さんの承認待ち')
  await item.getByRole('button', { name: '開く' }).click()
  expect((await asked(page)).find(a => 'open' in a)).toEqual({ open: { recordId: 'approval-abc123' } })
  expectNoPageErrors(state)
})

test('the weekly report: ［作り直す］ first says to delete this week\'s section by hand; ［今週は作らない］ completes the やること', async ({ page }) => {
  const state = await openPreview(page, 'after-meeting', { weekly: '1' })
  const part = page.getByRole('region', { name: '今週の定例レポート' })
  await part.getByRole('button', { name: '作り直す' }).click()
  await expect(page.getByRole('dialog')).toContainText('今週分を手で消してください')
  expect((await asked(page)).filter(a => 'consult' in a)).toEqual([])
  await page.getByRole('button', { name: '消したので作り直す' }).click()
  const consult = (await asked(page)).find(a => 'consult' in a)!.consult as { detail: string; madeAt: string }
  expect(consult.detail).toContain('私が手で消しました')
  expect(consult.madeAt).toBe('2026-11-27T00:05:00.000Z')
  await part.getByRole('button', { name: '今週は作らない' }).click()
  await page.getByRole('button', { name: '今週は作らない' }).last().click()
  await expect.poll(async () => (await asked(page)).some(a => 'complete' in a)).toBe(true)
  expectNoPageErrors(state)
})
