// The chat's approval card (tests/approval-card-ui.tsx, client/shared/approvals.ts): drawn by
// the app from the request the server answers (laid out to decide: owner decision 2026-11-28, 12番 案A). Guards: 「承認する」 sends the hash of the content the
// card shows (the server acts only when it is still the content it holds) with the reason the
// approver may edit; someone who may not approve gets no approve button; no jargon on the card.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

// A press whose answer never came (owner 2026-11-28, outside UX review): the card reads the server again by itself, and while
// it cannot it says so beside the card with ［結果を確かめる］ — never 「開き直すと分かります」. It offers no press meanwhile (never
// sent twice), says nothing is done until a read shows it, and asks for the press again only when a read shows it did not land.
const AUTO_READS_MS = 25_000
test.describe('a press whose answer never came', () => {
  // The automatic reads take about 15 seconds (`AUTO_WAITS`).
  test.describe.configure({ timeout: 60_000 })
  // Codex review: an approval still running on the server reads as pending at first; that is never taken as "not landed".
  test('approval: still running on the server — an early "pending" read is not final, and it shows done when it settles', async ({ page }) => {
    const state = await openPreview(page, 'approval-card', { offline: '1', recover: 'auto', late: '1' })
    const card = page.getByRole('group', { name: '承認のお願い' })
    await card.getByRole('button', { name: '承認する', exact: true }).click()
    await expect(card).toContainText('承認されました', { timeout: AUTO_READS_MS })
    await expect(card).not.toContainText('もう一度押してください')
    await expect(card.getByRole('button', { name: '承認する', exact: true })).toHaveCount(0)
    await expect(page.locator('#presses')).toHaveText('1')
    expectNoPageErrors(state)
  })

  // Independent review: the unknown press is the request's, not one card's — a second card of it offers no press either.
  test('approval: a second card of the same request offers no press while the first one\'s answer is unknown', async ({ page }) => {
    const state = await openPreview(page, 'approval-card', { offline: '1', twice: '1' })
    const cards = page.getByRole('group', { name: '承認のお願い' })
    await expect(cards).toHaveCount(2)
    await cards.nth(0).getByRole('button', { name: '承認する', exact: true }).click()
    for (const i of [0, 1]) await expect(cards.nth(i).getByRole('button', { name: '承認する', exact: true })).toHaveCount(0)
    await expect(cards.nth(1).getByRole('alert')).toContainText('分かりませんでした')
    expectNoPageErrors(state)
  })

  for (const which of ['approval', 'job'] as const) {
    const cardName = which === 'job' ? '定期の仕事の案' : '承認のお願い'
    const pressName = which === 'job' ? 'これで管理者に出す' : '承認する'
    const query: Record<string, string> = which === 'job' ? { card: 'job' } : {}

    test(`${which}: it had landed — the card reads again, and shows it done only after the read`, async ({ page }) => {
      const state = await openPreview(page, 'approval-card', { ...query, offline: '1', landed: '1' })
      const card = page.getByRole('group', { name: cardName })
      await card.getByRole('button', { name: pressName, exact: true }).click()
      // Unknown: no press offered, no success said.
      await expect(card.getByRole('button', { name: pressName, exact: true })).toHaveCount(0)
      await expect(card.getByRole('alert')).toContainText('分かりませんでした')
      await expect(card.getByRole('alert')).toContainText('［結果を確かめる］', { timeout: AUTO_READS_MS })
      await expect(card).not.toContainText(which === 'job' ? '管理者の確認待ち' : '承認されました')
      await expect(card).not.toContainText('開き直')
      await page.evaluate(() => (window as unknown as { __acbOnline: () => void }).__acbOnline())
      await card.getByRole('button', { name: '結果を確かめる' }).click()
      await expect(card).toContainText(which === 'job' ? '管理者の確認待ち' : '承認されました')
      await expect(card.getByRole('alert')).toHaveCount(0)
      await expect(card.getByRole('button', { name: pressName, exact: true })).toHaveCount(0)
      await expect(page.locator('#presses')).toHaveText('1')
      expectNoPageErrors(state)
    })

    test(`${which}: it had not landed — the read says so, and only the member's next press sends it (once)`, async ({ page }) => {
      const state = await openPreview(page, 'approval-card', { ...query, offline: '1', recover: 'auto' })
      const card = page.getByRole('group', { name: cardName })
      await card.getByRole('button', { name: pressName, exact: true }).click()
      // The connection comes back by itself: one of the automatic reads answers, no ［結果を確かめる］ needed.
      await expect(card.getByRole('alert')).toContainText('もう一度押してください', { timeout: AUTO_READS_MS })
      await expect(card.getByRole('button', { name: '結果を確かめる' })).toHaveCount(0)
      await expect(page.locator('#presses')).toHaveText('0')
      await card.getByRole('button', { name: pressName, exact: true }).click()
      await expect(card).toContainText(which === 'job' ? '管理者の確認待ち' : '承認されました')
      await expect(page.locator('#presses')).toHaveText('1')
      expectNoPageErrors(state)
    })
  }
})

test('the approver sees the change, basis, precedents and materials; 「承認する」 sends the shown hash and the edited reason', async ({ page }) => {
  const state = await openPreview(page, 'approval-card')
  const card = page.getByRole('group', { name: '承認のお願い' })
  const change = card.getByRole('region', { name: '何がどう変わるか' })
  await expect(change).toContainText('1,200,000')
  await expect(change).toContainText('1,500,000')
  await expect(change).toContainText('+25%')
  // The basis is one folded line that already shows the quote's first words (owner decision 2026-11-28).
  await expect(card.getByText('根拠：『チャット窓口も最初から入れたい』（材料 2）')).toBeVisible()
  await expect(card.getByRole('list', { name: '材料' })).toBeHidden()
  await card.getByText('根拠：『チャット窓口も最初から入れたい』（材料 2）').click()
  await expect(card.getByRole('list', { name: '材料' })).toContainText('11/5 商談')
  await card.getByText('前例（同じ部署・同じ欄の承認）：1 件').click()
  await expect(card.getByRole('list', { name: '前例' })).toContainText('対象部署が増えたため')
  await expect(card).toContainText('山田さんの承認待ち')
  await expect(card).toContainText('中身が変わっていないことを確かめて承認します')
  const reason = card.getByRole('textbox')
  await expect(reason).toHaveValue('先方が対象を広げたいと言ったため')
  await expect(card).toContainText('AI の下書きが入っています。直せます')
  await reason.fill('')
  await expect(card.getByRole('button', { name: '承認する', exact: true })).toBeDisabled()
  await expect(card).toContainText('理由を書くと押せます')
  await reason.fill('対象拡大のため妥当')
  await card.getByRole('button', { name: '承認する', exact: true }).click()
  await expect(page.locator('#sent')).toHaveText(JSON.stringify({ hash: `sha256:${'9c1e'.repeat(16)}`, reason: '対象拡大のため妥当' }))
  await expect(card).toContainText('承認されました。HubSpot の金額も 1,500,000 になりました')
  await expect(card.getByRole('button', { name: '承認する', exact: true })).toHaveCount(0)
  for (const word of ['ハッシュ', 'プラグイン', '型', 'オントロジー', 'sha256']) await expect(card).not.toContainText(word)
  expectNoPageErrors(state)
})

// What the person saw is what is approved: the card sends the hash of the content it draws. When the server's content
// changed meanwhile it refuses (CONTENT_CHANGED), the card shows the new content, and only a press on that sends its hash.
test('content that changed after the card was drawn is shown again before it can be approved; each approve sends the hash of what was on screen', async ({ page }) => {
  const state = await openPreview(page, 'approval-card', { change: '1', direct: '1' })
  const card = page.getByRole('group', { name: '承認のお願い' })
  const change = card.getByRole('region', { name: '何がどう変わるか' })
  const approve = card.getByRole('button', { name: '承認する', exact: true })
  await expect(change).toContainText('1,500,000')
  await page.evaluate(() => (window as unknown as { __acbChangeContent: () => void }).__acbChangeContent())
  await approve.click()
  await expect(card.getByRole('alert')).toContainText('内容が変わりました。もう一度確かめてください')
  await expect(change).toContainText('1,800,000')
  await expect(change).not.toContainText('1,500,000')
  await expect(page.locator('#done')).toHaveText('0')
  await approve.click()
  await expect(card).toContainText('承認されました')
  await expect(page.locator('#hashes')).toHaveText(`sha256:${'9c1e'.repeat(16)},sha256:${'7d2a'.repeat(16)}`)
  // Where the card is worked through a list (the inbox), only the finished press moves it on.
  await expect(page.locator('#done')).toHaveText('1')
  expectNoPageErrors(state)
})

test('the buttons stay at the bottom of a short screen while a long card is on it', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 420 })
  const state = await openPreview(page, 'approval-card', { kind: 'create' })
  const card = page.getByRole('group', { name: '承認のお願い' })
  await card.getByRole('region', { name: '何がどう変わるか' }).scrollIntoViewIfNeeded()
  const bar = card.locator('[data-approval-bar]')
  await expect(bar.getByRole('button', { name: '承認する', exact: true })).toBeInViewport()
  const cardBox = (await card.boundingBox())!
  const barBox = (await bar.boundingBox())!
  // The card runs past the screen's bottom; the bar is drawn at the screen's bottom, not the card's.
  expect(cardBox.y + cardBox.height).toBeGreaterThan(420)
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(421)
  expectNoPageErrors(state)
})

test('［大きく開く（タブ）］ opens the same request as a tab, and is not offered where nothing opens one', async ({ page }) => {
  let state = await openPreview(page, 'approval-card', { openLarge: '1' })
  let card = page.getByRole('group', { name: '承認のお願い' })
  await card.getByRole('button', { name: '大きく開く（タブ）' }).click()
  await expect(page.locator('#opened')).toHaveText('approval-preview0001')
  expectNoPageErrors(state)
  state = await openPreview(page, 'approval-card')
  card = page.getByRole('group', { name: '承認のお願い' })
  await expect(card.getByRole('button', { name: '承認する', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: '大きく開く（タブ）' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('the requester (not the approver) has no approve or send-back button, only 取り下げる', async ({ page }) => {
  const state = await openPreview(page, 'approval-card', { viewer: 'requester' })
  const card = page.getByRole('group', { name: '承認のお願い' })
  await expect(card).toContainText('山田さんの承認待ち')
  await expect(card.getByRole('button', { name: '承認する' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '差し戻す' })).toHaveCount(0)
  // Their AI's draft is shown as what it is, not as a reason box.
  await expect(card).toContainText('AI のまとめ（参考）：先方が対象を広げたいと言ったため')
  await expect(card.getByRole('textbox')).toHaveCount(0)
  await expect(card.getByRole('button', { name: '取り下げる' })).toBeVisible()
  expectNoPageErrors(state)
})

test('a new deal with similar ones: the approver first says whether it is the same; 「同じ」 makes nothing and links the meeting', async ({ page }) => {
  const state = await openPreview(page, 'approval-card', { kind: 'create' })
  const card = page.getByRole('group', { name: '承認のお願い' })
  const similar = card.getByRole('list', { name: '似ているもの' })
  await expect(similar).toContainText('研修導入（検証A社）')
  await expect(similar).toContainText('提案・担当 佐藤さん・更新 2026-10-30・同じ相手')
  await expect(similar).toContainText('名前が似ています')
  await card.getByRole('textbox').fill('新しい研修の相談のため')
  // Not before choosing: approving a possible duplicate is one click away from a second deal.
  await expect(card.getByRole('button', { name: '承認する', exact: true })).toBeDisabled()
  await expect(card).toContainText('先に「同じかどうか」を選ぶと承認できます')
  await card.getByRole('button', { name: '別の案件として作る' }).click()
  await expect(card.getByRole('button', { name: '承認する', exact: true })).toBeEnabled()
  await expect(card.getByRole('button', { name: 'これと同じ案件です（作らない）' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('「別の案件として作る」 holds only for the content it was chosen on: new content asks again', async ({ page }) => {
  const state = await openPreview(page, 'approval-card', { kind: 'create', change: '1' })
  const card = page.getByRole('group', { name: '承認のお願い' })
  const approve = card.getByRole('button', { name: '承認する', exact: true })
  await card.getByRole('button', { name: '別の案件として作る' }).click()
  await page.evaluate(() => (window as unknown as { __acbChangeContent: () => void }).__acbChangeContent())
  await approve.click()
  await expect(card.getByRole('alert')).toContainText('内容が変わりました')
  await expect(approve).toBeDisabled()
  await expect(card.getByRole('button', { name: 'これと同じ案件です（作らない）' }).first()).toBeVisible()
  expectNoPageErrors(state)
})

test('「これと同じ案件です（作らない）」 sends that record and, by default, the meeting link', async ({ page }) => {
  const state = await openPreview(page, 'approval-card', { kind: 'create' })
  const card = page.getByRole('group', { name: '承認のお願い' })
  await card.getByRole('button', { name: 'これと同じ案件です（作らない）' }).first().click()
  await expect(page.locator('#sent')).toHaveText(JSON.stringify({ recordId: 'deal-preview02', linkMeeting: true }))
  await expect(card).toContainText('作りませんでした。会議もこの記録につなぎました。')
  await expect(card).toContainText('取り下げられました')
  await expect(card.getByRole('button', { name: '承認する' })).toHaveCount(0)
  expectNoPageErrors(state)
})
