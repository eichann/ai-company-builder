// Meetings seen by their attendees (tests/meetings-ui.tsx, minutes.md "Meetings for their attendees",
// design §4-5). Guards: ［AI に読ませる］ only changes the banner (no consultation opens) and goes at
// the version shown; 「読み終わりました」 says what was made and ［見る］ opens the card; ［読まない］
// hides the line with 元に戻す (the undo of that entry); another attendee sees who chose it; a
// member whose Google cannot open the minutes is told another attendee can press it; ［招待する］
// says what the invited will see and that it cannot be undone before anything is sent; the
// consultation opens only from the card's button; linking a 案件 says who will see part of it and
// links only on ［つなぐ］ (from the question's ［はい］ too); a first discovery of many meetings shows two
// one-line rows and 「ほか N 件」, never taking the pane from the list; the card keeps its order and says
// each thing once (「ごちゃついてる」, 2026-11-05); 「やることを足す」 makes the meeting's task and a close one
// is only a quiet line — ［まとめる］ puts the new one away with its note and opens the earlier one,
// ［元に戻す］ undoes that entry, ［このまま］ keeps both.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const finish = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(i => (window as unknown as { __acbMeetings: { finish: (id: string) => void } }).__acbMeetings.finish(i), id)

test('read → 「AI が読んでいます…」 → 「読み終わりました」 → ［見る］ opens the card with the proposals', async ({ page }) => {
  const state = await openPreview(page, 'meetings')
  const line = page.locator('[data-banner="meeting-teirei01"]')
  await expect(page.getByRole('region', { name: '議事録が届きました' })).toContainText('議事録が届きました')
  await expect(line).toContainText('定例ミーティング・今日 12:00')
  await expect(line).not.toContainText('人')
  await line.getByRole('button', { name: 'AI に読ませる' }).click()
  await expect(page.locator('#log')).toHaveText('read meeting-teirei01@1')
  await expect(line).toContainText('AI が読んでいます…')
  await expect(line.getByRole('button', { name: '読まない' })).toBeVisible()
  // Nothing else opened: the card (and any consultation) only on ［見る］.
  await expect(page.getByTestId('record-card')).toHaveCount(0)

  await finish(page, 'meeting-teirei01')
  await expect(line).toContainText('読み終わりました')
  await expect(line).toContainText('定例ミーティング：決めたこと2・やることの案3')
  await line.getByRole('button', { name: '見る' }).click()
  await expect(line).toHaveCount(0)
  const card = page.getByTestId('record-card')
  await expect(card.getByRole('region', { name: 'やることの案' })).toContainText('11月の勉強会の会場を押さえる')
  await expect(card).toContainText('参加者のうち ACB の人 3人')
  // The one-time offer for a series; ［この定例は次から自動で読む］ is the member's own choice.
  await card.getByRole('button', { name: 'この定例は次から自動で読む' }).click()
  await expect(page.locator('#log')).toContainText('auto meeting-teirei01 true')
  await expect(card.locator('[data-auto-offer]')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('［読まない］ hides the line with 元に戻す, which undoes that one entry', async ({ page }) => {
  const state = await openPreview(page, 'meetings')
  const line = page.locator('[data-banner="meeting-mensetu1"]')
  await line.getByRole('button', { name: '読まない' }).click()
  await expect(line).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('「採用面接」は読まないにしました')
  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#log')).toHaveText('skip meeting-mensetu1@1\nundo meeting-mensetu1 2@2')
  await expect(line.getByRole('button', { name: 'AI に読ませる' })).toBeVisible()
  expectNoPageErrors(state)
})

test('another attendee sees who chose ［読まない］, without buttons', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { viewer: 'suzuki' })
  const line = page.locator('[data-banner="meeting-mensetu1"]')
  await expect(line).toContainText('阿部さんが読まないにしました')
  await expect(line.getByRole('button')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('the member\'s Google cannot open the minutes: told another attendee can press it, nothing changes', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { noaccess: '1' })
  const line = page.locator('[data-banner="meeting-teirei01"]')
  await line.getByRole('button', { name: 'AI に読ませる' }).click()
  await expect(line.getByRole('alert')).toContainText('ほかの参加者が［AI に読ませる］を押すと、その人の AI が読めます')
  await expect(line.getByRole('button', { name: 'AI に読ませる' })).toBeVisible()
  expectNoPageErrors(state)
})

test('the card: ［招待する］ says what the invited see and that it cannot be undone; 相談 only from its button; 案件 linked only after the sentence', async ({ page }) => {
  const state = await openPreview(page, 'meetings')
  await page.getByRole('button', { name: '定例ミーティングを開く' }).click()
  const card = page.getByTestId('record-card')
  await expect(card.getByRole('button', { name: 'AI に読ませる' })).toBeVisible()

  await card.getByRole('button', { name: '招待する' }).click()
  const dialog = page.getByRole('dialog', { name: '会議に人を招待する' })
  await expect(dialog).toContainText('招待した人は会議の記録と要約・決めたこと・やることを見られます。Google の議事録そのものは、Google で共有されていないと読めません。一度招待すると、取り消すことはできません')
  await expect(dialog.getByRole('button', { name: '招待する' })).toBeDisabled()
  // Groups and departments, with the strict rule said before anything is chosen; what is on the list already is named, not offered.
  await expect(dialog).toContainText('オーナーや管理者も、入れなければ見られません。')
  await expect(dialog).toContainText('いま見られる人には、「面接官」の人も入っています。')
  await expect(dialog.getByLabel('「面接官」の人')).toHaveCount(0)
  await dialog.getByLabel('田中部長さん').check()
  await dialog.getByLabel('「採用チーム」の人').check()
  await dialog.getByRole('button', { name: '招待する' }).click()
  await expect(page.locator('#log')).toHaveText('invite meeting-teirei01 u-boss,group:grp-1@1')
  await expect(card).toContainText('田中部長さん、「採用チーム」の人を招待しました。')

  await card.getByRole('button', { name: 'この会議について相談する' }).click()
  await expect(page.locator('#log')).toContainText('consult meeting-teirei01')

  await card.getByRole('button', { name: '案件につなぐ' }).click()
  await page.getByRole('button', { name: /B社 研修導入/ }).click()
  await expect(page.getByText('案件につなぐと、この会議の内容の一部（次のアクションなど）が営業部のみんなに見えます。')).toBeVisible()
  await page.getByRole('button', { name: 'やめる' }).click()
  await expect(page.locator('#log')).not.toContainText('link ')
  await card.getByRole('button', { name: '案件につなぐ' }).click()
  await page.getByRole('button', { name: /B社 研修導入/ }).click()
  await page.getByRole('button', { name: 'つなぐ', exact: true }).click()
  await expect(page.locator('#log')).toContainText('link meeting-teirei01=deal-bsha0001')
  expectNoPageErrors(state)
})

const readCard = async (page: import('@playwright/test').Page, params?: Record<string, string>) => {
  const state = await openPreview(page, 'meetings', params)
  await finish(page, 'meeting-teirei01')
  await page.locator('[data-banner="meeting-teirei01"]').getByRole('button', { name: '見る' }).click()
  const card = page.getByTestId('record-card')
  await expect(card.getByRole('region', { name: 'やることの案' })).toBeVisible()
  return { state, card }
}

for (const [where, width] of [['wide', 1300], ['narrow', 900]] as const) {
  test(`a read meeting reads top to bottom in the owner's order (${where})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const { state, card } = await readCard(page)
    const top = async (l: import('@playwright/test').Locator) => (await l.boundingBox())!.y
    const order = [
      card.getByRole('heading', { level: 1, name: '定例ミーティング' }),
      card.getByRole('region', { name: '要約' }),
      card.getByRole('article').getByRole('region', { name: '決めたこと' }),
      card.getByRole('region', { name: 'やることの案' }),
      card.locator('[data-auto-offer]'),
      card.getByRole('button', { name: 'この会議について相談する' }),
      card.getByRole('group', { name: 'どの案件の会議ですか？' }),
    ]
    if (where === 'narrow') order.push(card.getByRole('complementary', { name: 'つながっているもの' }), card.getByRole('region', { name: '経緯' }))
    else order.push(card.getByRole('region', { name: '経緯' }))
    const ys = []
    for (const l of order) ys.push(await top(l))
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    // Who attended and who can see it belong to the head.
    expect(await top(card.locator('[data-seen]'))).toBeLessThan(ys[1])
    expect(await top(card.getByText(/^参加 /))).toBeLessThan(ys[1])
    if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/meeting-card-${where}.png`, fullPage: true })
    expectNoPageErrors(state)
  })
}

test('a read meeting says each thing once: one 案件 element, the chip without the band, one list, the documents on the right', async ({ page }) => {
  const { state, card } = await readCard(page)
  // The 案件: the question is the field; no second 「なし」 row.
  await expect(card.getByRole('group', { name: 'どの案件の会議ですか？' })).toHaveCount(1)
  await expect(page.getByText('どの案件の会議ですか？')).toHaveCount(1)
  await expect(card.getByRole('group', { name: '案件', exact: true })).toHaveCount(0)
  // The AI: the chip alone.
  await expect(card.getByText('AI が読み終えた')).toHaveCount(1)
  await expect(card.getByText(/AI が反映しました/)).toHaveCount(0)
  // One list: each task once in the body, the proposal put away too, its review task not at all.
  await expect(card.getByRole('region', { name: 'AI のタスクの案' })).toHaveCount(0)
  await expect(card.getByRole('region', { name: '宿題' })).toHaveCount(0)
  await expect(card.getByRole('region', { name: '決めたこと（AI が残した）' })).toHaveCount(0)
  const body = card.getByRole('region', { name: 'この会議の議事録' })
  for (const title of ['新しい日報の書き方を部署に案内する', '議事録の置き場所を決める', '日報のひな形を直す', '日報は 11月から AI の下書きを使う']) {
    await expect(body.getByText(title)).toHaveCount(1)
  }
  await expect(body.getByText('議事録を確認する：定例ミーティング')).toHaveCount(0)
  const list = card.getByRole('region', { name: 'やることの案' })
  await expect(list.getByRole('listitem').filter({ hasText: '議事録の置き場所を決める' })).toContainText('しまった')
  await expect(list.getByRole('button', { name: '全部足す' })).toBeVisible()
  // The documents: rows of 「つながっているもの」, not buttons in the body.
  const links = card.getByRole('complementary', { name: 'つながっているもの' })
  for (const name of ['文字起こしを開く', 'Gemini のメモを開く', 'カレンダーの予定を開く']) {
    await expect(links.getByRole('button', { name })).toHaveCount(1)
    await expect(body.getByRole('button', { name })).toHaveCount(0)
  }
  expectNoPageErrors(state)
})

test('the question\'s ［はい］ says who will see part of it and links only on ［つなぐ］', async ({ page }) => {
  const { state, card } = await readCard(page, { bundle: 'suggest' })
  const field = card.getByRole('group', { name: '『B社 研修導入』の会議ですか？' })
  await field.getByRole('button', { name: 'はい' }).click()
  await expect(page.getByText('案件につなぐと、この会議の内容の一部（次のアクションなど）が営業部のみんなに見えます。')).toBeVisible()
  await expect(page.locator('#log')).not.toContainText('link ')
  await page.getByRole('button', { name: 'やめる' }).click()
  await expect(page.locator('#log')).not.toContainText('link ')
  await field.getByRole('button', { name: 'はい' }).click()
  await page.getByRole('button', { name: 'つなぐ', exact: true }).click()
  await expect(page.locator('#log')).toContainText('link meeting-teirei01=deal-bsha0001')

  expectNoPageErrors(state)
})

test('［案件はない］ closes the question and a 案件 can still be chosen', async ({ page }) => {
  const { state, card } = await readCard(page)
  await card.getByRole('group', { name: 'どの案件の会議ですか？' }).getByRole('button', { name: '案件はない（社内の会議など）' }).click()
  await expect(page.locator('#log')).toContainText('nobundle meeting-teirei01')
  await expect(card.getByText('案件はない、と決めた会議です。あとからでも選べます。')).toBeVisible()
  await expect(card.getByRole('button', { name: '案件につなぐ' })).toBeVisible()
  expectNoPageErrors(state)
})

test('many meetings at once: two one-line rows, the rest folded in a bounded area, the list always there and scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 640 })
  const state = await openPreview(page, 'meetings', { flood: '12' })
  const block = page.getByRole('region', { name: '議事録が届きました' })
  const list = page.getByTestId('task-list')
  const rows = block.locator('[data-banner]')
  await expect(rows).toHaveCount(2)
  // One line each, buttons included, however long the title.
  await expect(block.getByRole('button', { name: 'ほか 12 件' })).toBeVisible()
  for (const h of await rows.evaluateAll(els => els.map(e => e.getBoundingClientRect().height))) expect(h).toBeLessThan(32)
  const pane = (await page.getByRole('complementary', { name: 'やること' }).boundingBox())!
  const skip = (await rows.first().getByRole('button', { name: '読まない' }).boundingBox())!
  expect(skip.x + skip.width).toBeLessThanOrEqual(pane.x + pane.width)
  const scrollsDown = async () => {
    const box = (await list.boundingBox())!
    expect(box.height).toBeGreaterThan(page.viewportSize()!.height * 0.5)
    await list.evaluate(el => { el.scrollTop = 200 })
    expect(await list.evaluate(el => el.scrollTop)).toBe(200)
  }
  await scrollsDown()

  // Opened: the rest scroll inside their own area, and the list keeps its place.
  await block.getByRole('button', { name: 'ほか 12 件' }).click()
  const folded = page.getByTestId('meetings-folded')
  await expect(folded.locator('[data-banner]')).toHaveCount(12)
  expect(await folded.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  await scrollsDown()
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/meetings-flood.png`, clip: { x: 0, y: 0, width: 320, height: 640 } })
  // A short window: the block gives way, the list does not.
  await page.setViewportSize({ width: 1000, height: 400 })
  await scrollsDown()
  await page.setViewportSize({ width: 1000, height: 640 })

  // ［まとめて読まない］: the folded ones only, one 元に戻す for them all.
  await block.getByRole('button', { name: 'まとめて読まない' }).click()
  await expect(page.getByRole('status')).toContainText('12件を読まないにしました')
  await expect(rows).toHaveCount(2)
  await expect(page.locator('#log')).toContainText('skip meeting-flood011@1')
  await expect(page.locator('#log')).not.toContainText('skip meeting-teirei01')
  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(block.getByRole('button', { name: 'ほか 12 件' })).toBeVisible()
  await expect(page.locator('#log')).toContainText('undo meeting-flood011 2@2')
  expectNoPageErrors(state)
})

test('a Google permission from before the Docs API: one line on the card, and its button asks the 議事録 feature again', async ({ page }) => {
  await openPreview(page, 'meetings', { renew: '1' })
  await page.locator('[data-banner="meeting-teirei01"]').getByRole('button', { name: 'AI に読ませる' }).click()
  await finish(page, 'meeting-teirei01')
  await page.locator('[data-banner="meeting-teirei01"]').getByRole('button', { name: '見る' }).click()
  await expect(page.getByTestId('record-card')).toContainText('Google の許可をし直すと、メモも読めるようになります')
  await page.getByRole('button', { name: '許可をし直す' }).click()
  await expect(page.locator('#log')).toContainText('google minutes')
  await expect(page.getByTestId('record-card')).toContainText('ブラウザで Google の画面を開きました')
})

test('「やることを足す」: a close item is a quiet line; ［まとめる］ puts the new one away, opens the earlier, and 元に戻す undoes it', async ({ page }) => {
  const state = await openPreview(page, 'meetings')
  await finish(page, 'meeting-teirei01')
  await page.locator('[data-banner="meeting-teirei01"]').getByRole('button', { name: '見る' }).click()
  const list = page.getByTestId('record-card').getByRole('region', { name: 'やることの案' })
  await list.getByRole('button', { name: 'やることを足す' }).click()
  const line = list.getByRole('textbox', { name: 'この会議のやること' })
  // Nothing close: made, nothing said.
  await line.fill('名刺を注文する')
  await line.press('Enter')
  await expect(page.locator('#log')).toContainText('create 名刺を注文する meeting=meeting-teirei01')
  await expect(list.getByRole('note', { name: '似ているやること' })).toHaveCount(0)
  // Close to a proposal: made all the same (never refused), then the line; no dialog.
  await line.fill('勉強会の会場を押さえる')
  await line.press('Enter')
  const hint = list.getByRole('note', { name: '似ているやること' })
  await expect(hint).toContainText('似ているやることがあります：「11月の勉強会の会場を押さえる」')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await hint.getByRole('button', { name: 'このまま' }).click()
  await expect(hint).toHaveCount(0)
  await line.fill('勉強会の会場を押さえる')
  await line.press('Enter')
  await hint.getByRole('button', { name: 'まとめる' }).click()
  await expect(page.locator('#log')).toContainText('act task-hand0001 dismiss@1 「11月の勉強会の会場を押さえる」とまとめたため\nopen task-prop0002')
  await expect(list.getByRole('status')).toContainText('「11月の勉強会の会場を押さえる」とまとめました')
  await list.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#log')).toContainText('undo task-hand0001 2@2')
  await expect(list.getByRole('status')).toHaveCount(0)
  expectNoPageErrors(state)
})
