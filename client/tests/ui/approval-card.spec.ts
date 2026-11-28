// The chat's approval card (tests/approval-card-ui.tsx, client/shared/approvals.ts): drawn by
// the app from the request the server answers. Guards: 「承認」 sends the hash of the content the
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
    await card.getByRole('button', { name: '承認', exact: true }).click()
    await expect(card).toContainText('承認されました', { timeout: AUTO_READS_MS })
    await expect(card).not.toContainText('もう一度押してください')
    await expect(card.getByRole('button', { name: '承認', exact: true })).toHaveCount(0)
    await expect(page.locator('#presses')).toHaveText('1')
    expectNoPageErrors(state)
  })

  // Independent review: the unknown press is the request's, not one card's — a second card of it offers no press either.
  test('approval: a second card of the same request offers no press while the first one\'s answer is unknown', async ({ page }) => {
    const state = await openPreview(page, 'approval-card', { offline: '1', twice: '1' })
    const cards = page.getByRole('group', { name: '承認のお願い' })
    await expect(cards).toHaveCount(2)
    await cards.nth(0).getByRole('button', { name: '承認', exact: true }).click()
    for (const i of [0, 1]) await expect(cards.nth(i).getByRole('button', { name: '承認', exact: true })).toHaveCount(0)
    await expect(cards.nth(1).getByRole('alert')).toContainText('分かりませんでした')
    expectNoPageErrors(state)
  })

  for (const which of ['approval', 'job'] as const) {
    const cardName = which === 'job' ? '定期の仕事の案' : '承認のお願い'
    const pressName = which === 'job' ? 'これで管理者に出す' : '承認'
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

test('the approver sees the change, basis, precedents and materials; 「承認」 sends the shown hash and the edited reason', async ({ page }) => {
  const state = await openPreview(page, 'approval-card')
  const card = page.getByRole('group', { name: '承認のお願い' })
  await expect(card).toContainText('1,200,000')
  await expect(card).toContainText('1,500,000')
  await expect(card).toContainText('+25%')
  await expect(card).toContainText('チャット窓口も最初から入れたい')
  await expect(card.getByRole('list', { name: '前例' })).toContainText('対象部署が増えたため')
  await expect(card.getByRole('list', { name: '材料' })).toContainText('11/5 商談')
  await expect(card).toContainText('山田さんの承認待ち')
  await expect(card).toContainText('中身が変わっていないことを確かめて承認します')
  const reason = card.getByRole('textbox')
  await expect(reason).toHaveValue('先方が対象を広げたいと言ったため')
  await reason.fill('対象拡大のため妥当')
  await card.getByRole('button', { name: '承認' }).click()
  await expect(page.locator('#sent')).toHaveText(JSON.stringify({ hash: `sha256:${'9c1e'.repeat(16)}`, reason: '対象拡大のため妥当' }))
  await expect(card).toContainText('承認されました。HubSpot の金額も 1,500,000 になりました')
  await expect(card.getByRole('button', { name: '承認' })).toHaveCount(0)
  for (const word of ['ハッシュ', 'プラグイン', '型', 'オントロジー', 'sha256']) await expect(card).not.toContainText(word)
  expectNoPageErrors(state)
})

test('the requester (not the approver) has no approve or send-back button, only 取り下げる', async ({ page }) => {
  const state = await openPreview(page, 'approval-card', { viewer: 'requester' })
  const card = page.getByRole('group', { name: '承認のお願い' })
  await expect(card).toContainText('山田さんの承認待ち')
  await expect(card.getByRole('button', { name: '承認' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '差し戻す' })).toHaveCount(0)
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
  await expect(card.getByRole('button', { name: '承認' })).toBeDisabled()
  await card.getByRole('button', { name: '別の案件として作る' }).click()
  await expect(card.getByRole('button', { name: '承認' })).toBeEnabled()
  await expect(card.getByRole('button', { name: 'これと同じ案件です（作らない）' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('「これと同じ案件です（作らない）」 sends that record and, by default, the meeting link', async ({ page }) => {
  const state = await openPreview(page, 'approval-card', { kind: 'create' })
  const card = page.getByRole('group', { name: '承認のお願い' })
  await card.getByRole('button', { name: 'これと同じ案件です（作らない）' }).first().click()
  await expect(page.locator('#sent')).toHaveText(JSON.stringify({ recordId: 'deal-preview02', linkMeeting: true }))
  await expect(card).toContainText('作りませんでした。会議もこの記録につなぎました。')
  await expect(card).toContainText('取り下げられました')
  await expect(card.getByRole('button', { name: '承認' })).toHaveCount(0)
  expectNoPageErrors(state)
})
