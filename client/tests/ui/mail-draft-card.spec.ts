// The chat's mail card (tests/mail-draft-card-ui.tsx, outbound-mail.md). Protects: every
// recipient shows where its address came from; 「確かめて送る」 shows the whole mail once more
// before anything is sent, and the send carries exactly the hash of the version shown.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SHOWN_HASH = `sha256:${'a1'.repeat(32)}`

test('each recipient shows its source; 「確かめて送る」 confirms, then sends with the hash shown', async ({ page }) => {
  const state = await openPreview(page, 'mail-draft-card')
  const card = page.getByRole('group', { name: 'メール：本日はありがとうございました' })
  const to = card.getByRole('list', { name: '宛先' })
  await expect(to).toContainText('鈴木 一郎 <suzuki@a-corp.example>（カレンダーの参加者）')
  await expect(to).toContainText('山口 花子 <yamaguchi@a-corp.example>（HubSpot の連絡先）')
  const cc = card.getByRole('list', { name: 'CC' })
  await expect(cc).toContainText('田中 <tanaka@div.example>（ACB のメンバー）')
  await expect(cc).toContainText('partner@third.example（あなたが入力）')
  await expect(card).toContainText('この宛先に送るのは初めてです')
  await expect(card).toContainText('本文にリンクが 1 つあります')
  await expect(card.getByLabel('本文')).toContainText('資料: https://example.com/doc')
  // No jargon on the card.
  await expect(card).not.toContainText('ハッシュ')
  await expect(card).not.toContainText('OAuth')

  await card.getByRole('button', { name: '確かめて送る' }).click()
  // Nothing sent yet: the confirm step shows everything again.
  await expect(page.getByLabel('受け取った印')).toHaveCount(0)
  await expect(card).toContainText('送る前に、もう一度確かめてください')
  await expect(card).toContainText('中身が変わっていないことを確かめて送ります')
  await expect(card.getByRole('list', { name: '宛先' })).toContainText('（HubSpot の連絡先）')
  // A draft without the AI's mark (made before it existed): 「返事を待つ」 offered, unticked; nothing waits.
  await expect(card.getByRole('checkbox', { name: /返事を待つ/ })).not.toBeChecked()
  await card.getByRole('button', { name: 'この内容で送る' }).click()
  await expect(page.getByLabel('受け取った印')).toHaveText(SHOWN_HASH)
  await expect(page.getByLabel('受け取った返事待ち')).toHaveText('null')
  await expect(card).toHaveAttribute('data-state', 'sent')
  await expect(card.getByRole('status')).toHaveText('メールを送りました。')
  await expect(card.getByRole('button', { name: '確かめて送る' })).toHaveCount(0)
  await expect(card).not.toContainText('相手の返事を待っています')
  expectNoPageErrors(state)
})

test('「返事を待つ」: pre-ticked when the AI marked the mail, the day can be changed, and the send carries that day', async ({ page }) => {
  const state = await openPreview(page, 'mail-draft-card')
  const card = page.getByRole('group', { name: 'メール：お見積りのご送付' })
  // Not on the view step: chosen at the confirm step only.
  await expect(card.getByRole('checkbox')).toHaveCount(0)
  await card.getByRole('button', { name: '確かめて送る' }).click()
  const box = card.getByRole('checkbox', { name: /返事を待つ/ })
  await expect(box).toBeChecked()
  await expect(box).toHaveAccessibleName(/来なければ 1月7日（.）の朝に知らせる/)
  const day = card.getByLabel('知らせる日')
  await expect(day).toHaveValue('2099-01-07')
  await day.fill('2099-01-09')
  await expect(box).toHaveAccessibleName(/1月9日（.）の朝/)
  if (process.env.MAIL_CARD_SCREENSHOT) await card.screenshot({ path: process.env.MAIL_CARD_SCREENSHOT })
  // Unticked and ticked again: still the picked day.
  await box.uncheck()
  await expect(day).toHaveCount(0)
  await box.check()
  await card.getByRole('button', { name: 'この内容で送る' }).click()
  await expect(page.getByLabel('受け取った返事待ち')).toHaveText('{"until":"2099-01-09"}')
  await expect(card).toContainText('相手の返事を待っています（来なければ 1月9日')
  expectNoPageErrors(state)
})
