// Meetings seen by their attendees (tests/meetings-ui.tsx, minutes.md "Meetings for their attendees",
// design §4-5), as the inbox's rows since 2026-11-26. Guards: ［AI に読ませる］ only changes the row's line (no
// consultation opens) and goes at the version shown, and the row is no longer counted as 新着 while the AI reads;
// 「読み終わりました」 says what was made and is 新着 again, ［見る］ opens the card; ［読まない］
// hides the row with 元に戻す (the undo of that entry); another attendee sees who chose it; a
// member whose Google cannot open the minutes is told another attendee can press it; ［招待する］
// says what the invited will see and that it cannot be undone before anything is sent; the
// consultation opens only from the card's button; linking a 案件 says who will see part of it and
// links only on ［つなぐ］ (from the question's ［はい］ too); one meeting is one row; the card keeps its order and says
// each thing once (「ごちゃついてる」, 2026-11-05); 「やることを足す」 makes the meeting's task and a close one
// is only a quiet line — ［まとめる］ puts the new one away with its note and opens the earlier one,
// ［元に戻す］ undoes that entry, ［このまま］ keeps both. 「届いた議事録を AI が自動で読む」 (4b-4 A2b): a
// member who never chose is offered 「社外の人がいる会議だけ」 above the meetings, and choosing it sends that
// and hides the offer, a choice made meanwhile (Settings) is never replaced and the offer goes; a server keeping a series' three choices shows them on the card, the current one
// marked, and 「設定に従う」 sends none (null).
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const finish = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(i => (window as unknown as { __acbMeetings: { finish: (id: string) => void } }).__acbMeetings.finish(i), id)

test('read → 「AI が読んでいます…」 → 「読み終わりました」 → ［見る］ opens the card with the proposals', async ({ page }) => {
  const state = await openPreview(page, 'meetings')
  const line = page.locator('[data-inbox-row="record:meeting-teirei01"]')
  const news = page.getByRole('region', { name: '新着' }).first()
  await expect(news.locator('[data-inbox-row="record:meeting-teirei01"]')).toContainText('議事録が届きました')
  await expect(line).toContainText('定例ミーティング')
  // One meeting is one row, its notice included.
  await expect(page.locator('[data-inbox-row="record:meeting-teirei01"]')).toHaveCount(1)
  await expect(line).not.toContainText('人')
  await expect(news.getByRole('heading')).toContainText('新着 2')
  await line.getByRole('button', { name: 'AI に読ませる', exact: true }).click()
  await expect(page.locator('#log')).toHaveText('read meeting-teirei01@1')
  await expect(line).toContainText('AI が読んでいます…')
  await expect(line.getByRole('button', { name: '読まない', exact: true })).toBeVisible()
  // While the AI reads it the row stays, not counted as 新着.
  await expect(news.getByRole('heading')).toContainText('新着 1')
  // Nothing else opened: the card (and any consultation) only on ［見る］.
  await expect(page.getByTestId('record-card')).toHaveCount(0)

  await finish(page, 'meeting-teirei01')
  await expect(line).toContainText('読み終わりました：決めたこと2・やることの案3')
  await expect(news.getByRole('heading')).toContainText('新着 2')
  await line.getByRole('button', { name: '見る', exact: true }).click()
  // Looked at: 確認したもの, never 新着 again.
  await expect(news.locator('[data-inbox-row="record:meeting-teirei01"]')).toHaveCount(0)
  await expect(news.getByRole('heading')).toContainText('新着 1')
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
  const line = page.locator('[data-inbox-row="record:meeting-mensetu1"]')
  await line.getByRole('button', { name: '読まない', exact: true }).click()
  // Gone from 新着 (its notice stays findable in 確認したもの), with no buttons left anywhere.
  await expect(page.getByRole('region', { name: '新着' }).first().locator('[data-inbox-row="record:meeting-mensetu1"]')).toHaveCount(0)
  await expect(line.getByRole('button', { name: '読まない', exact: true })).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('「採用面接」は読まないにしました')
  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('#log')).toHaveText('skip meeting-mensetu1@1\nundo meeting-mensetu1 2@2')
  await expect(line.getByRole('button', { name: 'AI に読ませる', exact: true })).toBeVisible()
  expectNoPageErrors(state)
})

test('another attendee sees who chose ［読まない］, without buttons', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { viewer: 'suzuki' })
  const line = page.locator('[data-inbox-row="record:meeting-mensetu1"]')
  await expect(line).toContainText('阿部さんが読まないにしました')
  await expect(line.getByRole('button', { name: 'AI に読ませる', exact: true })).toHaveCount(0)
  await expect(line.getByRole('button', { name: '読まない', exact: true })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('the member\'s Google cannot open the minutes: told another attendee can press it, nothing changes', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { noaccess: '1' })
  const line = page.locator('[data-inbox-row="record:meeting-teirei01"]')
  await line.getByRole('button', { name: 'AI に読ませる', exact: true }).click()
  await expect(line).toContainText('ほかの参加者が［AI に読ませる］を押すと、その人の AI が読めます')
  await expect(line.getByRole('button', { name: 'AI に読ませる', exact: true })).toBeVisible()
  expectNoPageErrors(state)
})

test('a meeting only the clock asked for the organiser: named 「（主催）」, and the member\'s own ［AI に読ませる］ takes it; a press too late is said plainly', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { clock: '1' })
  const line = page.locator('[data-inbox-row="record:meeting-teirei01"]')
  await expect(line).toContainText('鈴木さん（主催）の AI が読む予定です')
  await line.getByRole('button', { name: 'AI に読ませる', exact: true }).click()
  await expect(page.locator('#log')).toHaveText('read meeting-teirei01@1')
  await expect(line).toContainText('AI が読んでいます…')
  await expect(line.getByRole('button', { name: 'AI に読ませる', exact: true })).toHaveCount(0)

  await page.goto(page.url().replace('clock=1', 'clock=taken'))
  const again = page.locator('[data-inbox-row="record:meeting-teirei01"]')
  await again.getByRole('button', { name: 'AI に読ませる', exact: true }).click()
  await expect(again).toContainText('この会議は、もう AI が読んでいるか、読み終わっています。')
  expectNoPageErrors(state)
})

test('the card: ［招待する］ says what the invited see and that it cannot be undone; 相談 only from its button; 案件 linked only after the sentence', async ({ page }) => {
  const state = await openPreview(page, 'meetings')
  await page.getByRole('button', { name: '定例ミーティングを開く' }).click()
  const card = page.getByTestId('record-card')
  await expect(card.getByRole('button', { name: 'AI に読ませる', exact: true })).toBeVisible()

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
  await page.locator('[data-inbox-row="record:meeting-teirei01"]').getByRole('button', { name: '見る', exact: true }).click()
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
  await expect(card.getByRole('region', { name: 'AI のやることの案' })).toHaveCount(0)
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

test('many meetings at once: one row each in 新着, and 「すべて確認した」 takes the count to 0 without pressing anything', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { flood: '12' })
  const news = page.getByRole('region', { name: '新着' }).first()
  await expect(news.locator('[data-inbox-row^="record:meeting-"]')).toHaveCount(14)
  await expect(news.getByRole('heading')).toContainText('新着 14')
  await news.getByRole('button', { name: 'すべて確認した' }).click()
  await expect(news.getByRole('heading')).toContainText('新着 0')
  // Looked at, not decided: nothing was sent, and each still offers ［AI に読ませる］, in sight but no longer counted.
  await expect(page.locator('#log')).toHaveText('')
  await expect(page.getByRole('region', { name: '新着' }).first().locator('[data-inbox-row="record:meeting-teirei01"]').getByRole('button', { name: 'AI に読ませる', exact: true })).toBeVisible()
  expectNoPageErrors(state)
})

test('a Google permission from before the Docs API: one line on the card, and its button asks the 議事録 feature again', async ({ page }) => {
  await openPreview(page, 'meetings', { renew: '1' })
  await page.locator('[data-inbox-row="record:meeting-teirei01"]').getByRole('button', { name: 'AI に読ませる', exact: true }).click()
  await finish(page, 'meeting-teirei01')
  await page.locator('[data-inbox-row="record:meeting-teirei01"]').getByRole('button', { name: '見る', exact: true }).click()
  await expect(page.getByTestId('record-card')).toContainText('Google の許可をし直すと、メモも読めるようになります')
  await page.getByRole('button', { name: '許可をし直す' }).click()
  await expect(page.locator('#log')).toContainText('google minutes')
  await expect(page.getByTestId('record-card')).toContainText('ブラウザで Google の画面を開きました')
})

test('「やることを足す」: a close item is a quiet line; ［まとめる］ puts the new one away, opens the earlier, and 元に戻す undoes it', async ({ page }) => {
  const state = await openPreview(page, 'meetings')
  await finish(page, 'meeting-teirei01')
  await page.locator('[data-inbox-row="record:meeting-teirei01"]').getByRole('button', { name: '見る', exact: true }).click()
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

test('a member who never chose is offered 「社外の人がいる会議だけ」 above the meetings; choosing it sends that, and the offer goes', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { autoread: 'new' })
  const offer = page.locator('[data-auto-read-suggestion]')
  await expect(offer).toContainText('押さなくても、届いた議事録を AI が読めます。')
  await offer.getByRole('button', { name: '社外の人がいる会議だけ自動で読む' }).click()
  await expect(page.locator('#log')).toHaveText('auto-read outside')
  await expect(offer).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('社外の人がいる会議は、次から AI が自動で読みます')
  expectNoPageErrors(state)
})

test('a server that keeps three choices: the card shows them for a series, marks the current one, 「設定に従う」 sends none', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { three: '1' })
  const line = page.locator('[data-inbox-row="record:meeting-teirei01"]')
  await line.getByRole('button', { name: 'AI に読ませる', exact: true }).click()
  await finish(page, 'meeting-teirei01')
  await line.getByRole('button', { name: '見る', exact: true }).click()
  const card = page.getByTestId('record-card')
  const choice = card.getByRole('radiogroup', { name: 'この定例の議事録を自動で読むか' })
  await expect(choice.getByRole('radio', { name: '設定に従う' })).toHaveAttribute('aria-checked', 'true')
  // The older one-time offer is not shown beside it: each thing once.
  await expect(card.locator('[data-auto-offer]')).toHaveCount(0)
  await choice.getByRole('radio', { name: '読まない', exact: true }).click()
  await expect(choice.getByRole('radio', { name: '読まない', exact: true })).toHaveAttribute('aria-checked', 'true')
  await choice.getByRole('radio', { name: '設定に従う' }).click()
  await expect(page.locator('#log')).toContainText('auto meeting-teirei01 false\nauto meeting-teirei01 null')
  await expect(choice.getByRole('radio', { name: '設定に従う' })).toHaveAttribute('aria-checked', 'true')
  expectNoPageErrors(state)
})

test('a choice made meanwhile is never replaced by the offer: pressing it sends nothing, and Settings\' change takes the offer away', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { autoread: 'new' })
  const offer = page.locator('[data-auto-read-suggestion]')
  await expect(offer).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbMeetings: { chooseAutoRead: (m: string) => void } }).__acbMeetings.chooseAutoRead('all'))
  await offer.getByRole('button', { name: '社外の人がいる会議だけ自動で読む' }).click()
  await expect(offer).toHaveCount(0)
  await expect(page.locator('#log')).toHaveText('')
  expectNoPageErrors(state)
})

test('Settings changing the setting takes the offer away at once', async ({ page }) => {
  const state = await openPreview(page, 'meetings', { autoread: 'new' })
  const offer = page.locator('[data-auto-read-suggestion]')
  await expect(offer).toBeVisible()
  await page.evaluate(() => {
    (window as unknown as { __acbMeetings: { chooseAutoRead: (m: string) => void } }).__acbMeetings.chooseAutoRead('off')
    window.dispatchEvent(new CustomEvent('acb:meeting-auto-read-changed', { detail: 'co' }))
  })
  await expect(offer).toHaveCount(0)
  expectNoPageErrors(state)
})
