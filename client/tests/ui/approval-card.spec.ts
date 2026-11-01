// The chat's approval card (tests/approval-card-ui.tsx, client/shared/approvals.ts): drawn by
// the app from the request the server answers. Guards: 「承認」 sends the hash of the content the
// card shows (the server acts only when it is still the content it holds) with the reason the
// approver may edit; someone who may not approve gets no approve button; no jargon on the card.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('the approver sees the change, basis, precedents and materials; 「承認」 sends the shown hash and the edited reason', async ({ page }) => {
  const state = await openPreview(page, 'approval-card')
  const card = page.getByRole('group', { name: '承認のお願い' })
  await expect(card).toContainText('1,200,000')
  await expect(card).toContainText('1,500,000')
  await expect(card).toContainText('+25%')
  await expect(card).toContainText('チャット窓口も最初から入れたい')
  await expect(card.getByRole('list', { name: '前例' })).toContainText('対象部署が増えたため')
  await expect(card.getByRole('list', { name: '材料' })).toContainText('11/5 商談')
  await expect(card).toContainText('承認待ち：阿部さんにお願いしました')
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
  await expect(card).toContainText('承認待ち：阿部さんにお願いしました')
  await expect(card.getByRole('button', { name: '承認' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '差し戻す' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '取り下げる' })).toBeVisible()
  expectNoPageErrors(state)
})
