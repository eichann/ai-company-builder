// The inbox (受け箱, features/inbox; redesign 2026-11-26): あなた待ち — only what is stopped until the member acts (a stopped
// job, an approval, a mail to check), first and in order of need — and 新着, the notices not looked at yet; tasks are no
// rows; approvals only through their card; opening a 新着 row marks exactly its notices; a stop is not done by opening it;
// stale rows leave; 「すべて確認した」 never reaches あなた待ち (tests/inbox-ui.html). The panel in the real screen (⌘J, the
// wide tab spanning the left side) is in skill-layout-state.spec.ts.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SHOTS = process.env.INBOX_SHOTS
const rows = (page: Page, section: string) => page.getByRole('region', { name: section }).locator('[data-inbox-row]')
const chip = (page: Page, name: RegExp) => page.getByRole('group', { name: '受け箱の絞り込み' }).getByRole('button', { name })
const read = (page: Page) => page.locator('#read')

test('あなた待ち holds only what is stopped until the member acts, in order of need; tasks are never rows; 新着 is the rest, newest first', async ({ page }) => {
  const state = await openPreview(page, 'inbox')
  const keys = await rows(page, 'あなた待ち').evaluateAll(els => els.map(e => e.getAttribute('data-inbox-row')))
  expect(keys).toEqual(['notice:n-stop', 'record:approval-preview0001', 'record:outbound_message-preview01'])
  await expect(page.getByRole('region', { name: 'あなた待ち' }).getByText('止まりました')).toBeVisible()
  // The task to check and the task asked are the left list's; the notice about the asked one is 新着.
  await expect(page.locator('[data-inbox-row="record:task-check0001"]')).toHaveCount(0)
  const newKeys = await rows(page, '新着').evaluateAll(els => els.map(e => e.getAttribute('data-inbox-row')))
  expect(newKeys).toEqual(['record:task-asked0001', 'record:task-done0001', 'record:task-due00001', 'record:task-old00001'])
  await expect(rows(page, '新着').first().getByRole('img', { name: '新着' })).toBeVisible()
  await expect(chip(page, /^新着 4$/)).toHaveAttribute('aria-pressed', 'true')
  await expect(chip(page, /^あなた待ち 3$/)).toBeVisible()
  await expect(chip(page, /^確認したもの 1$/)).toBeVisible()
  await chip(page, /^あなた待ち/).click()
  await expect(page.getByRole('region', { name: '新着' })).toHaveCount(0)
  await chip(page, /^確認したもの/).click()
  await expect(rows(page, '確認したもの')).toHaveCount(1)
  expectNoPageErrors(state)
})

test('［承認する…］ opens the approval card and approves nothing; the card\'s own button is the only way', async ({ page }) => {
  await openPreview(page, 'inbox')
  const row = page.locator('[data-inbox-row="record:approval-preview0001"]')
  await row.getByRole('button', { name: '承認する…' }).click()
  const dialog = page.getByRole('dialog', { name: '承認のお願い' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('一覧からは承認できません')
  await expect(dialog.getByRole('button', { name: '承認する', exact: true })).toBeVisible()
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

test('opening a 新着 row marks exactly its notice and moves it to 確認したもの; a stop is not done by opening, only by ［済んだ］', async ({ page }) => {
  await openPreview(page, 'inbox')
  await page.locator('[data-inbox-row="record:task-asked0001"]').getByRole('button', { name: '開く' }).click()
  await expect(page.locator('#opened')).toHaveText('record task-asked0001')
  await expect(read(page)).toHaveText('n-asked')
  await expect(chip(page, /^新着 3$/)).toBeVisible()
  await expect(rows(page, '新着').filter({ hasText: '見積書を作る' })).toHaveCount(0)

  const stop = page.locator('[data-inbox-row="notice:n-stop"]')
  await expect(stop.getByRole('button', { name: '確認した' })).toHaveCount(0)
  await stop.getByRole('button', { name: /定期の仕事/ }).click()
  await expect(read(page)).toHaveText('n-asked')
  await stop.getByRole('button', { name: '済んだ' }).click()
  await expect(read(page)).toHaveText('n-asked|n-stop')
  await expect(stop).toHaveCount(0)
  await expect(chip(page, /^あなた待ち 2$/)).toBeVisible()
  await chip(page, /^確認したもの/).click()
  await expect(rows(page, '確認したもの')).toHaveCount(3)
})

test('a request approved on another PC leaves the list; its card then says it was approved', async ({ page }) => {
  await openPreview(page, 'inbox')
  await expect(page.locator('[data-inbox-row="record:approval-preview0001"]')).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbInbox: { approvedElsewhere(): void } }).__acbInbox.approvedElsewhere())
  await expect(page.locator('[data-inbox-row="record:approval-preview0001"]')).toHaveCount(0)
  await expect(chip(page, /^あなた待ち 2$/)).toBeVisible()
})

test('「すべて確認した」 marks every 新着 row and nothing of あなた待ち', async ({ page }) => {
  await openPreview(page, 'inbox')
  await page.getByRole('region', { name: '新着' }).getByRole('button', { name: 'すべて確認した' }).click()
  await expect(read(page)).toHaveText('n-asked,n-done,n-due,n-old')
  await expect(chip(page, /^新着 0$/)).toBeVisible()
  await expect(page.locator('[data-inbox-row="notice:n-stop"]')).toBeVisible()
  await expect(page.getByRole('region', { name: 'あなた待ち' }).getByRole('button', { name: /すべて/ })).toHaveCount(0)
})

test('when marking seen cannot reach the server, a plain message says so and nothing pretends it was seen', async ({ page }) => {
  await openPreview(page, 'inbox', { offline: '1' })
  await page.getByRole('region', { name: '新着' }).getByRole('button', { name: 'すべて確認した' }).click()
  await expect(page.getByRole('alert')).toHaveText('サーバーにつながりませんでした。少し待ってからもう一度お試しください。')
  await expect(chip(page, /^新着 4$/)).toBeVisible()
})

// 「ブラウザ操作」 plans (agent-browser.md "The card, the IPC and the request tool"; the inbox's rows).
const DRAFT = `bp_${'1a'.repeat(16)}`
const UNSURE = `bp_${'2b'.repeat(16)}`

test('switched off, no plan row appears and the plans are never read', async ({ page }) => {
  const state = await openPreview(page, 'inbox', { plans: 'off' })
  await expect(rows(page, 'あなた待ち')).toHaveCount(3)
  await expect(page.locator('[data-inbox-row^="browser:"]')).toHaveCount(0)
  await expect(page.locator('#plan-reads')).toHaveText('0')
  expectNoPageErrors(state)
})

test('a browser plan waits for the member: ［承認する…］ / ［確かめる…］ open the plan\'s card, and nothing runs from the row', async ({ page }) => {
  const state = await openPreview(page, 'inbox', { plans: '1' })
  await expect(rows(page, 'あなた待ち')).toHaveCount(5)
  const keys = await rows(page, 'あなた待ち').evaluateAll(els => els.map(e => e.getAttribute('data-inbox-row')))
  // After the stop: the result nobody knows, then the approvals (the plan's newer than the request).
  expect(keys.slice(0, 4)).toEqual(['notice:n-stop', `browser:${UNSURE}`, `browser:${DRAFT}`, 'record:approval-preview0001'])
  await expect(chip(page, /^あなた待ち 5$/)).toBeVisible()
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
  await expect(chip(page, /^あなた待ち 4$/)).toBeVisible()
})

test('［任せる］ on a card elsewhere (the consultation) moves the inbox\'s row at once: the draft becomes 「届いたか分かりません」', async ({ page }) => {
  await openPreview(page, 'inbox', { plans: '1', chatcard: '1' })
  const draft = page.locator(`[data-inbox-row="browser:${DRAFT}"]`)
  await expect(draft).toContainText('承認を待っています')
  await page.getByRole('region', { name: '相談のカード' }).getByRole('button', { name: '任せる' }).click()
  await expect(page.locator('#acted')).toHaveText('run')
  // No panel opened or card closed in the inbox: the card's state moving is what made it read again.
  await expect(draft).toContainText('届いたか分かりません')
  await expect(draft.getByRole('button', { name: '確かめる…' })).toBeVisible()
})

test('while a plan is listed the inbox reads every minute, a few minutes on through a run claimed elsewhere, then stops', async ({ page }) => {
  await page.clock.install()
  await openPreview(page, 'inbox', { plans: '1' })
  const reads = page.locator('#plan-reads')
  const inbox = (call: 'plansSettled' | 'claimedRunUnknown') => page.evaluate(c => (window as unknown as { __acbInbox: Record<string, () => void> }).__acbInbox[c](), call)
  await expect(reads).toHaveText('1')
  await page.clock.runFor(61_000)
  await expect(reads).toHaveText('2')
  // The draft was claimed on another PC: in neither list while it waits for its permit…
  await inbox('plansSettled')
  await page.clock.runFor(61_000)
  await expect(reads).toHaveText('3')
  await expect(page.locator('[data-inbox-row^="browser:"]')).toHaveCount(0)
  // …then its result is unknown and confirmable: the reads went on, so it shows without opening anything.
  await inbox('claimedRunUnknown')
  await page.clock.runFor(61_000)
  await expect(page.locator(`[data-inbox-row="browser:${DRAFT}"]`)).toContainText('届いたか分かりません')
  // Settled for good: a few more minutes of reads, then none.
  await inbox('plansSettled')
  await page.clock.runFor(600_000)
  const settled = await reads.textContent()
  await page.clock.runFor(600_000)
  await expect(reads).toHaveText(settled ?? '')
})

for (const theme of ['light', 'dark'] as const) {
  test(`renders in the ${theme} theme`, async ({ page }) => {
    const state = await openPreview(page, 'inbox', theme === 'dark' ? { theme } : {})
    await expect(rows(page, 'あなた待ち')).toHaveCount(3)
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/inbox-preview-${theme}.png`, animations: 'disabled' })
      await page.locator('[data-inbox-row="record:approval-preview0001"]').getByRole('button', { name: '承認する…' }).click()
      await expect(page.getByRole('dialog', { name: '承認のお願い' }).getByRole('button', { name: '承認する', exact: true })).toBeVisible()
      await page.screenshot({ path: `${SHOTS}/inbox-approval-card-${theme}.png`, animations: 'disabled' })
    }
    expectNoPageErrors(state)
  })
}
