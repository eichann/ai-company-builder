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
  await card.getByRole('button', { name: 'この内容で送る' }).click()
  await expect(page.getByLabel('受け取った印')).toHaveText(SHOWN_HASH)
  await expect(card).toHaveAttribute('data-state', 'sent')
  await expect(card.getByRole('status')).toHaveText('メールを送りました。')
  await expect(card.getByRole('button', { name: '確かめて送る' })).toHaveCount(0)
  expectNoPageErrors(state)
})
