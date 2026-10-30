// The chat's 「<サービス> の鍵がありません」 card (tests/broker-key-card-ui.tsx): a tool
// hit the key broker's "no key" answer. Which services are found is pinned by
// src/features/chat/brokerKeyNeeds.test.ts; here: one card per service, the button
// that opens 「自分の鍵」 for that service where the member may register, the
// ask-the-admin text where they may not, and nothing printed around the marker shown.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('a card per service: register where own keys are allowed (opens 「自分の鍵」 for it), ask the admin where not', async ({ page }) => {
  const state = await openPreview(page, 'broker-key-card')
  const gemini = page.getByRole('group', { name: 'Google Gemini の鍵がありません' })
  const openai = page.getByRole('group', { name: 'OpenAI の鍵がありません' })
  await expect(gemini).toContainText('自分の鍵を登録すると、AI がこのサービスを使えるようになります。')
  await expect(openai).toContainText('会社の鍵だけを使う設定です。使いたいときは、管理者に鍵を使えるようにしてもらってください。')
  await expect(openai.getByRole('button')).toHaveCount(0)
  await gemini.getByRole('button', { name: '自分の鍵を登録する' }).click()
  await expect(page.getByRole('status')).toHaveText('設定を開きました: gemini')
  // The cards show the service only, never what the script printed around the marker.
  for (const card of [gemini, openai]) {
    await expect(card).not.toContainText('NOT-REAL')
    await expect(card).not.toContainText('ACB_NO_KEY')
  }
  expectNoPageErrors(state)
})

test('in a consultation\'s own window (no settings there): says where to register instead of a button', async ({ page }) => {
  const state = await openPreview(page, 'broker-key-card', { handler: '0' })
  const gemini = page.getByRole('group', { name: 'Google Gemini の鍵がありません' })
  await expect(gemini).toContainText('メインの画面の「設定 → 自分の鍵」から登録できます。')
  await expect(gemini.getByRole('button')).toHaveCount(0)
  expectNoPageErrors(state)
})
