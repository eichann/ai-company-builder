// The inbox (受け箱, I1; features/inbox): one list by what it needs from the member, chips by state,
// approvals only through their card, opening marks seen, stale rows leave, the 14-day fold and the
// bulk 「確認済み」 for できた・未確認 only (tests/inbox-ui.html). The panel in the real screen
// (⌘J, the wide tab spanning the left side) is in skill-layout-state.spec.ts.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SHOTS = process.env.INBOX_SHOTS
const rows = (page: Page, section: string) => page.getByRole('region', { name: section }).locator('[data-inbox-row]')
const chip = (page: Page, name: RegExp) => page.getByRole('group', { name: '受け箱の絞り込み' }).getByRole('button', { name })
const read = (page: Page) => page.locator('#read')

test('あなた待ち comes first and in order of need: stopped, approval, mail, check, then the rest; one row per record', async ({ page }) => {
  const state = await openPreview(page, 'inbox')
  await expect(rows(page, 'あなた待ち')).toHaveCount(5)
  const keys = await rows(page, 'あなた待ち').evaluateAll(els => els.map(e => e.getAttribute('data-inbox-row')))
  expect(keys).toEqual(['notice:n-stop', 'record:approval-preview0001', 'record:outbound_message-preview01', 'record:task-check0001', 'record:task-asked0001'])
  // The notice about a record waiting for the member is that row's line (and its new mark), not a row of its own.
  const asked = rows(page, 'あなた待ち').nth(4)
  await expect(asked).toContainText('佐藤さんから「見積書を作る」を頼まれました')
  await expect(asked.getByRole('img', { name: '新しい知らせ' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'あなた待ち' }).getByText('止まりました')).toBeVisible()
  // The chips count by state; できた・未確認 includes the folded older one.
  await expect(chip(page, /^すべて 8$/)).toHaveAttribute('aria-pressed', 'true')
  await expect(chip(page, /^あなた待ち 5$/)).toBeVisible()
  await expect(chip(page, /^作業中 0$/)).toBeVisible()
  await expect(chip(page, /^できた・未確認 3$/)).toBeVisible()
  await chip(page, /^できた・未確認/).click()
  await expect(page.getByRole('region', { name: 'あなた待ち' })).toHaveCount(0)
  await expect(rows(page, 'できた・未確認')).toHaveCount(2)
  await chip(page, /^作業中/).click()
  await expect(page.getByRole('region', { name: '作業中' })).toContainText('まだ受け箱に出ません')
  expectNoPageErrors(state)
})

test('［承認する…］ opens the approval card and approves nothing; the card\'s own button is the only way', async ({ page }) => {
  await openPreview(page, 'inbox')
  const row = page.locator('[data-inbox-row="record:approval-preview0001"]')
  await row.getByRole('button', { name: '承認する…' }).click()
  const dialog = page.getByRole('dialog', { name: '承認のお願い' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('一覧からは承認できません')
  await expect(dialog.getByRole('button', { name: '承認', exact: true })).toBeVisible()
  await expect(page.locator('#acted')).toHaveText('')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // Pressing the row itself opens the same card, never an approval.
  await row.getByRole('button', { name: /金額の変更/ }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '閉じる' }).click()
  // The mail draft likewise only opens its card.
  await page.locator('[data-inbox-row="record:outbound_message-preview01"]').getByRole('button', { name: '確かめて送る…' }).click()
  await expect(page.getByRole('dialog', { name: '送るメールの下書き' })).toContainText('一覧からは送れません')
  await expect(page.locator('#acted')).toHaveText('')
})

test('opening a row marks exactly its notices seen: a stop leaves, a done one goes to today\'s seen', async ({ page }) => {
  await openPreview(page, 'inbox')
  await page.locator('[data-inbox-row="record:task-asked0001"]').getByRole('button', { name: '開く' }).click()
  await expect(page.locator('#opened')).toHaveText('record task-asked0001')
  await expect(read(page)).toHaveText('n-asked')
  await expect(page.locator('[data-inbox-row="record:task-asked0001"]').getByRole('img', { name: '新しい知らせ' })).toHaveCount(0)

  await page.locator('[data-inbox-row="notice:n-stop"]').getByRole('button', { name: '確認した' }).click()
  await expect(read(page)).toHaveText('n-asked|n-stop')
  await expect(page.locator('[data-inbox-row="notice:n-stop"]')).toHaveCount(0)

  await page.locator('[data-inbox-row="notice:n-done"]').getByRole('button', { name: '開く' }).click()
  await expect(page.locator('#opened')).toHaveText('record task-done0001')
  await expect(rows(page, 'できた・未確認')).toHaveCount(1)
  const seen = page.getByRole('region', { name: 'きょう確認したもの' })
  await seen.getByRole('button', { name: /きょう確認したもの/ }).click()
  // Today's seen: the one read before, and the ask and the stop just read (all made today) — the done one was made
  // yesterday and is in 「前に確認したもの」 (every read notice stays findable, as the bell listed them).
  await expect(seen.locator('[data-inbox-row]')).toHaveCount(3)
  await expect(seen.locator('[data-inbox-row="notice:n-stop"]')).toHaveCount(1)
  await expect(page.getByRole('region', { name: '前に確認したもの' })).toContainText('前に確認したもの（1 件）')
})

test('a request approved on another PC leaves the list; its card then says it was approved', async ({ page }) => {
  await openPreview(page, 'inbox')
  await expect(page.locator('[data-inbox-row="record:approval-preview0001"]')).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbInbox: { approvedElsewhere(): void } }).__acbInbox.approvedElsewhere())
  await expect(page.locator('[data-inbox-row="record:approval-preview0001"]')).toHaveCount(0)
  await expect(chip(page, /^あなた待ち 4$/)).toBeVisible()
})

test('できた・未確認 older than 14 days is one line; 「まとめて確認済み」 marks only できた・未確認', async ({ page }) => {
  await openPreview(page, 'inbox')
  const older = page.locator('[data-inbox-older]')
  await expect(older).toHaveText(/14 日より前のもの 1 件/)
  await expect(page.locator('[data-inbox-row="notice:n-old"]')).toHaveCount(0)
  await older.getByRole('button', { name: 'まとめて確認済みにする' }).click()
  await expect(read(page)).toHaveText('n-old')
  await expect(older).toHaveCount(0)

  await page.getByRole('region', { name: 'できた・未確認' }).getByRole('button', { name: 'まとめて確認済みにする' }).click()
  await expect(read(page)).toHaveText('n-old|n-done,n-due')
  // あなた待ち keeps its stop and its row's news: no bulk ever reaches them.
  await expect(page.locator('[data-inbox-row="notice:n-stop"]')).toBeVisible()
  await expect(page.locator('[data-inbox-row="record:task-asked0001"]').getByRole('img', { name: '新しい知らせ' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'あなた待ち' }).getByRole('button', { name: /まとめて/ })).toHaveCount(0)
})

test('when marking seen cannot reach the server, a plain message says so and nothing pretends it was seen', async ({ page }) => {
  await openPreview(page, 'inbox', { offline: '1' })
  await page.locator('[data-inbox-older]').getByRole('button', { name: 'まとめて確認済みにする' }).click()
  await expect(page.getByRole('alert')).toHaveText('サーバーにつながりませんでした。少し待ってからもう一度お試しください。')
  await expect(page.locator('[data-inbox-older]')).toBeVisible()
})

// 「ブラウザ操作」 plans (agent-browser.md "The card, the IPC and the request tool"; the inbox's rows).
const DRAFT = `bp_${'1a'.repeat(16)}`
const UNSURE = `bp_${'2b'.repeat(16)}`

test('switched off, no plan row appears and the plans are never read', async ({ page }) => {
  const state = await openPreview(page, 'inbox', { plans: 'off' })
  await expect(rows(page, 'あなた待ち')).toHaveCount(5)
  await expect(page.locator('[data-inbox-row^="browser:"]')).toHaveCount(0)
  await expect(page.locator('#plan-reads')).toHaveText('0')
  expectNoPageErrors(state)
})

test('a browser plan waits for the member: ［承認する…］ / ［確かめる…］ open the plan\'s card, and nothing runs from the row', async ({ page }) => {
  const state = await openPreview(page, 'inbox', { plans: '1' })
  await expect(rows(page, 'あなた待ち')).toHaveCount(7)
  const keys = await rows(page, 'あなた待ち').evaluateAll(els => els.map(e => e.getAttribute('data-inbox-row')))
  // After the stop: the result nobody knows, then the approvals (the plan's newer than the request).
  expect(keys.slice(0, 4)).toEqual(['notice:n-stop', `browser:${UNSURE}`, `browser:${DRAFT}`, 'record:approval-preview0001'])
  await expect(chip(page, /^あなた待ち 7$/)).toBeVisible()
  const draft = page.locator(`[data-inbox-row="browser:${DRAFT}"]`)
  await expect(draft).toContainText('承認を待っています')
  await draft.getByRole('button', { name: '承認する…' }).click()
  const dialog = page.getByRole('dialog', { name: '承認のお願い（ブラウザ操作）' })
  await expect(dialog).toContainText('一覧からは任せられません')
  await expect(dialog.getByRole('button', { name: '任せる' })).toBeVisible()
  await expect(page.locator('#acted')).toHaveText('')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const unsure = page.locator(`[data-inbox-row="browser:${UNSURE}"]`)
  await expect(unsure).toContainText('届いたか分かりません')
  await unsure.getByRole('button', { name: '確かめる…' }).click()
  await expect(dialog.getByRole('button', { name: '済んでいた' })).toBeVisible()
  await expect(page.locator('#acted')).toHaveText('')
  expectNoPageErrors(state)
})

test('a plan approved on another PC leaves the list on the next read (a card closed)', async ({ page }) => {
  await openPreview(page, 'inbox', { plans: '1' })
  const draft = page.locator(`[data-inbox-row="browser:${DRAFT}"]`)
  await expect(draft).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbInbox: { planApprovedElsewhere(): void } }).__acbInbox.planApprovedElsewhere())
  await page.locator(`[data-inbox-row="browser:${UNSURE}"]`).getByRole('button', { name: '確かめる…' }).click()
  await page.getByRole('dialog', { name: '承認のお願い（ブラウザ操作）' }).getByRole('button', { name: '閉じる' }).click()
  await expect(draft).toHaveCount(0)
  await expect(chip(page, /^あなた待ち 6$/)).toBeVisible()
})

for (const theme of ['light', 'dark'] as const) {
  test(`renders in the ${theme} theme`, async ({ page }) => {
    const state = await openPreview(page, 'inbox', theme === 'dark' ? { theme } : {})
    await expect(rows(page, 'あなた待ち')).toHaveCount(5)
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/inbox-preview-${theme}.png`, animations: 'disabled' })
      await page.locator('[data-inbox-row="record:approval-preview0001"]').getByRole('button', { name: '承認する…' }).click()
      await expect(page.getByRole('dialog', { name: '承認のお願い' }).getByRole('button', { name: '承認', exact: true })).toBeVisible()
      await page.screenshot({ path: `${SHOTS}/inbox-approval-card-${theme}.png`, animations: 'disabled' })
    }
    expectNoPageErrors(state)
  })
}
