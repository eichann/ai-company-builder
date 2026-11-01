// The card's 元のスレッド (tests/record-thread-ui.tsx, outbound-mail.md "Replies"). Protects: the
// thread is shown on the card with who wrote what (the member's own marked); a Slack reply draft
// is a body only — no recipients or subject to choose — and its 「確かめて送る」 confirms first and
// sends exactly the hash shown; a record whose 連絡 the member cannot see shows nothing at all.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SHOWN_HASH = `sha256:${'b2'.repeat(32)}`

test('the Slack thread and its reply: body only, confirmed, sent with the hash shown', async ({ page }) => {
  const state = await openPreview(page, 'record-thread')
  const panel = page.getByRole('region', { name: '元のスレッド' })
  await expect(panel).toContainText('鈴木 一郎')
  await expect(panel).toContainText('見積をいただけますか？')
  await expect(panel).toContainText('あなた')

  const card = panel.getByRole('group', { name: 'Slack の返事の下書き' })
  await expect(card).toContainText('元の Slack のスレッドに、あなたとして返します。')
  await expect(card.getByLabel('本文')).toHaveText('承知しました。明日までにお送りします。')
  await expect(card.getByRole('list', { name: '宛先' })).toHaveCount(0)

  // Editing changes the body only.
  await card.getByRole('button', { name: '直す' }).click()
  await expect(card.getByLabel('件名')).toHaveCount(0)
  await expect(card.getByLabel('宛先を入力')).toHaveCount(0)
  await card.getByLabel('本文').fill('承知しました。本日中にお送りします。')
  await card.getByRole('button', { name: '保存する' }).click()
  await expect(page.getByRole('list', { name: 'メインが受け取ったもの' })).toContainText('edit {"expectedVersion":1,"body":"承知しました。本日中にお送りします。"}')

  await card.getByRole('button', { name: '確かめて送る' }).click()
  await expect(page.getByRole('list', { name: 'メインが受け取ったもの' })).not.toContainText('send')
  await card.getByRole('button', { name: 'この内容で送る' }).click()
  await expect(page.getByRole('list', { name: 'メインが受け取ったもの' })).toContainText(`send ${SHOWN_HASH}`)
  await expect(card.getByRole('status')).toHaveText('Slack に返事を送りました。')

  // A task whose 連絡 the member cannot see: nothing, not even an error.
  const hidden = page.getByRole('region', { name: '見えない連絡のタスク' })
  await expect(hidden).toHaveText('ここまで')
  expectNoPageErrors(state)
})
