// 「ブラウザ操作」's approval card (tests/browser-plan-card-ui.html; agent-browser.md "The card, the IPC and
// the request tool"). Guards: the card shows what the app read from the site — the timing with its fixed
// sentence, an unread count as 「読み取れませんでした」 (never 0), the shared-reminder warning — apart from
// the AI's words; ［任せる］ sends only the plan and the shown hash, and only where the site's window is
// open and logged in (else a plain reason); a result nobody knows says what to check, offers no resend,
// and the confirm only once its time came; no jargon.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SCREENSHOTS = process.env.SCREENSHOTS
// THEME=dark reruns the specs in dark mode (the screenshots of both themes).
const q = (o: Record<string, string> = {}) => (process.env.THEME ? { ...o, theme: process.env.THEME } : o)
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (SCREENSHOTS) await page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' }).screenshot({ path: `${SCREENSHOTS}/${name}.png` })
}

test('waiting for approval: the facts the app read, the unread count, the shared warning; ［任せる］ sends only the plan and the shown hash', async ({ page }) => {
  const state = await openPreview(page, 'browser-plan-card', q({ shared: '1' }))
  const card = page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' })
  await expect(card).toContainText('承認を待っています')
  await expect(card).toContainText('サイトから読み取った情報')
  await expect(card).toContainText('見本セミナーのリマインダ')
  await expect(card).toContainText('前日のご案内')
  await expect(card).toContainText('当日は筆記用具をお持ちください。')
  await expect(card).toContainText('1日前 19:00')
  await expect(card).toContainText('この段の時刻をこれから迎える人に、その時刻に届きます。すでに過ぎた人には届きません。')
  await expect(card.locator('[data-audience="unknown"]')).toHaveText('読み取れませんでした')
  await expect(card).not.toContainText('0人')
  await expect(card).toContainText('全部の回で共有のリマインダです。ほかの回でも、この段をまだ迎えていない人に届きます（もう過ぎた人には届きません）。')
  await expect(card).toContainText('AI の説明（サイトから読んだ情報ではありません）')
  await shot(page, `draft-ready-${process.env.THEME ?? 'light'}`)
  await card.getByRole('button', { name: '任せる' }).click()
  await expect(page.locator('#sent')).toHaveText(JSON.stringify({ companyId: 'co-preview', planId: `bp_${'5e'.repeat(16)}`, contentHash: `sha256:${'7a'.repeat(32)}` }))
  await expect(card).toContainText('計画どおりの状態になっています。')
  await expect(card.getByRole('button', { name: '任せる' })).toHaveCount(0)
  for (const word of ['ハッシュ', 'sha256', '安全です', 'トークン', 'secret']) await expect(card).not.toContainText(word)
  expectNoPageErrors(state)
})

test('a known count is shown as it is (a known 0 too)', async ({ page }) => {
  const state = await openPreview(page, 'browser-plan-card', q({ audience: '0' }))
  const card = page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' })
  await expect(card).toContainText('0人')
  await expect(card.locator('[data-audience="unknown"]')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('the site\'s window not open on this PC: ［任せる］ cannot be pressed, the reason is said, 「開いてログイン」 opens it', async ({ page }) => {
  const state = await openPreview(page, 'browser-plan-card', q({ ready: 'no-window' }))
  const card = page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' })
  await expect(card.getByRole('button', { name: '任せる' })).toBeDisabled()
  await expect(card).toContainText('このパソコンではLステップの窓が開いていません。開いてログインしてから任せてください。')
  await shot(page, `draft-no-window-${process.env.THEME ?? 'light'}`)
  await card.getByRole('button', { name: '開いてログイン' }).click()
  await expect(page.locator('#sent')).toHaveText(JSON.stringify({ open: 'manager.linestep.net' }))
  expectNoPageErrors(state)
})

test('logged out or another account: ［任せる］ stays off with the reason; ［やめる］ closes the plan', async ({ page }) => {
  const state = await openPreview(page, 'browser-plan-card', q({ ready: 'not-logged-in' }))
  const card = page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' })
  await expect(card.getByRole('button', { name: '任せる' })).toBeDisabled()
  await expect(card.getByRole('button', { name: '開いてログイン' })).toHaveCount(0)
  await expect(card).toContainText('計画と同じアカウントにログインしていることを確かめられませんでした')
  await card.getByRole('button', { name: 'やめる' }).click()
  await expect(card).toContainText('やめました。サイトには何も送っていません。')
  await expect(card.getByRole('button', { name: '任せる' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a result nobody knows: what to check, the hint of this PC, no resend; the confirm only once its time came', async ({ page }) => {
  const state = await openPreview(page, 'browser-plan-card', q({ state: 'unknown-early', hint: '1' }))
  const card = page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' })
  await expect(card).toContainText('届いたか分かりません。')
  await expect(card).toContainText('Lステップで「見本セミナーのリマインダ」の「前日」の段を開いて、テンプレート「持ち物のお知らせ」が足されているか確かめてください。')
  await expect(card).toContainText('このパソコンの記録では、送る前に止めています')
  await expect(card).toContainText('もう一度は送りません')
  await expect(card.getByRole('button', { name: '済んでいた' })).toHaveCount(0)
  await expect(card).toContainText('から、確かめた結果を押せます。')
  for (const name of ['任せる', 'もう一度送る', '送り直す']) await expect(card.getByRole('button', { name })).toHaveCount(0)
  await shot(page, `unknown-early-${process.env.THEME ?? 'light'}`)
  expectNoPageErrors(state)
})

test('a result nobody knows: the confirm opens by itself once its time comes (the card reads again while unsettled)', async ({ page }) => {
  await page.clock.install()
  const state = await openPreview(page, 'browser-plan-card', q({ state: 'unknown-early' }))
  const card = page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' })
  await expect(card).toContainText('から、確かめた結果を押せます。')
  await expect(card.getByRole('button', { name: '済んでいた' })).toHaveCount(0)
  await page.clock.runFor(21 * 60_000)
  await expect(card.getByRole('button', { name: '済んでいた' })).toBeVisible()
  expectNoPageErrors(state)
})

test('a result nobody knows, past its time: ［済んでいた］［されていなかった］ say what the member saw', async ({ page }) => {
  const state = await openPreview(page, 'browser-plan-card', q({ state: 'unknown' }))
  const card = page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' })
  await shot(page, `unknown-confirm-${process.env.THEME ?? 'light'}`)
  await card.getByRole('button', { name: 'されていなかった' }).click()
  await expect(page.locator('#sent')).toHaveText(JSON.stringify({ executionId: `bx_${'3c'.repeat(16)}`, result: 'not_done' }))
  await expect(card).toContainText('確かめました：されていませんでした。')
  await expect(card.getByRole('button', { name: '済んでいた' })).toHaveCount(0)
  expectNoPageErrors(state)
})

test('stopped before sending and sent: the plain result, no buttons', async ({ page }) => {
  for (const [name, words] of [['failed', '送る前に止めました。この操作の送信は行っていません。'], ['succeeded', '計画どおりの状態になっています。']] as const) {
    const state = await openPreview(page, 'browser-plan-card', q({ state: name }))
    const card = page.getByRole('group', { name: '承認のお願い（ブラウザ操作）' })
    await expect(card).toContainText(words)
    await expect(card.getByRole('button')).toHaveCount(0)
    await shot(page, `${name}-${process.env.THEME ?? 'light'}`)
    expectNoPageErrors(state)
  }
})
