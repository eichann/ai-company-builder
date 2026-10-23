// The choice card above the composer and its record in the transcript
// (tests/choice-prompt-ui.tsx: AgentInteractionCard + AssistantMessageParts).
// Answer mapping and card state rules are pinned by tests/choice-prompt.test.ts;
// here: ARIA groups, focus of 「その他」, the submit gate, ⌘+Enter, and the
// answered / closed records rendered in place.
import { test, expect } from '@playwright/test'
import { openPreview } from './helpers'

test('answering: radio + checkboxes + 「その他」 text, sent with ⌘+Enter, then shown answered in place', async ({ page }) => {
  await openPreview(page, 'choice-prompt')
  const card = page.getByRole('region', { name: 'Claudeからの質問' })
  await expect(card).toContainText('回答待ち')
  const submit = card.getByRole('button', { name: '回答する' })
  await expect(submit).toBeDisabled()

  const format = card.getByRole('group', { name: /^1\/2 出力形式/ })
  await format.getByRole('radio', { name: /^PDF/ }).check()
  await format.getByRole('radio', { name: /^PowerPoint/ }).check()
  await expect(format.getByRole('radio', { name: /^PDF/ })).not.toBeChecked()
  // One answered, one not: still gated.
  await expect(submit).toBeDisabled()

  const sources = card.getByRole('group', { name: /^2\/2 参考資料/ })
  await sources.getByRole('checkbox', { name: /^価格表/ }).check()
  await sources.getByRole('checkbox', { name: /^導入事例/ }).check()
  await sources.getByRole('checkbox', { name: 'その他' }).check()
  const other = sources.getByRole('textbox', { name: '参考資料：その他の回答' })
  await expect(other).toBeFocused()
  await other.fill('競合比較も')
  await expect(submit).toBeEnabled()

  await page.keyboard.press('Meta+Enter')
  await expect(card).toHaveCount(0)
  await expect(page.getByText('選択肢の質問 · 回答済み')).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: '提案書はどの形式で作成しますか？' }).last()).toContainText('→ PowerPoint')
  await expect(page.getByRole('listitem').filter({ hasText: '盛り込む資料' })).toContainText('→ 価格表, 導入事例, 競合比較も')
  // The member's answer bubble comes before the AI's continuation.
  const text = await page.locator('main').innerText()
  expect(text.indexOf('出力形式：PowerPoint')).toBeGreaterThan(text.indexOf('ユーザーに質問'))
  expect(text.indexOf('出力形式：PowerPoint')).toBeLessThan(text.indexOf('ありがとうございます'))
})

test('closing without an answer records it as closed', async ({ page }) => {
  await openPreview(page, 'choice-prompt')
  await page.getByRole('button', { name: '回答せずに閉じる' }).click()
  await expect(page.getByRole('region', { name: 'Claudeからの質問' })).toHaveCount(0)
  await expect(page.getByText(/選択肢の質問 · /)).toHaveCount(2)
  await expect(page.getByText('選択肢の質問 · 回答済み')).toHaveCount(0)
})

test('a restored conversation shows answered and timed-out prompts without a card', async ({ page }) => {
  await openPreview(page, 'choice-prompt', { state: 'answered' })
  await expect(page.getByRole('region', { name: 'Claudeからの質問' })).toHaveCount(0)
  await expect(page.getByText('選択肢の質問 · 10分間回答がなかったため終了しました')).toBeVisible()
  await expect(page.getByText('出力形式：PowerPoint 参考資料：価格表, 導入事例, 競合比較も')).toBeVisible()
})
