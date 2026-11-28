// The inbox (受け箱, features/inbox; redesign 2026-11-26): あなた待ち — only what is stopped until the member acts (a stopped
// job, an approval, a mail to check), first and in order of need — and 新着, the notices not looked at yet; tasks are no
// rows; approvals only through their card; opening a 新着 row marks exactly its notices; a stop is not done by opening it;
// stale rows leave; 「すべて確認した」 never reaches あなた待ち; working through it (15 rows first and the rest going down, the
// kinds and 「その他」, the card beside the list, the next one after its press with ［取り消す］, ↑ ↓ Enter Esc; tests/inbox-ui.html). The panel in the real screen (⌘J, the
// wide tab spanning the left side) is in skill-layout-state.spec.ts.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SHOTS = process.env.INBOX_SHOTS
const rows = (page: Page, section: string) => page.getByRole('region', { name: section }).locator('[data-inbox-row]')
const chip = (page: Page, name: RegExp) => page.getByRole('group', { name: '受け箱の絞り込み' }).getByRole('button', { name })
const read = (page: Page) => page.locator('#read')
/** A section's count (its heading's number): the chips carry none for あなた待ち and 新着 (owner decision 2026-11-28, 11番-7). */
const count = (page: Page, section: string) => page.getByRole('region', { name: section }).locator('h3 .tabular-nums')
/** The card a row opened beside the list. */
const beside = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

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
  await expect(chip(page, /^新着$/)).toHaveAttribute('aria-pressed', 'true')
  await expect(count(page, '新着')).toHaveText('4')
  // The chips switch only: the two counts are the title bar's, never shown twice (確認したもの keeps its own).
  await expect(chip(page, /^あなた待ち$/)).toBeVisible()
  await expect(count(page, 'あなた待ち')).toHaveText('3')
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
  const card = beside(page, '承認のお願い')
  await expect(card).toBeVisible()
  await expect(card).toContainText('一覧からは承認できません')
  await expect(card.getByRole('button', { name: '承認', exact: true })).toBeVisible()
  await expect(page.locator('#acted')).toHaveText('')
  await card.getByRole('button', { name: '閉じる' }).click()
  await expect(card).toBeHidden()
  // Pressing the row itself opens the same card, never an approval.
  await row.getByRole('button', { name: /金額の変更/ }).click()
  await expect(card).toBeVisible()
  // The mail draft likewise only opens its card, in the same place.
  await page.locator('[data-inbox-row="record:outbound_message-preview01"]').getByRole('button', { name: '確かめて送る…' }).click()
  await expect(card).toBeHidden()
  await expect(beside(page, '送るメールの下書き')).toContainText('一覧からは送れません')
  await expect(page.locator('#acted')).toHaveText('')
})

test('opening a 新着 row marks exactly its notice; it stays in its place (no dot) until the chips change, then is in 確認したもの; a stop is not done by opening, only by ［済んだ］', async ({ page }) => {
  await openPreview(page, 'inbox')
  const asked = page.locator('[data-inbox-row="record:task-asked0001"]')
  await asked.getByRole('button', { name: '開く' }).click()
  await expect(page.locator('#opened')).toHaveText('record task-asked0001')
  await expect(read(page)).toHaveText('n-asked')
  await expect(count(page, '新着')).toHaveText('3')
  // Read on the server, kept where it was: first of 新着, without its dot or ［確認した］ (owner decision 11番-3).
  await expect(rows(page, '新着').first()).toHaveAttribute('data-inbox-row', 'record:task-asked0001')
  await expect(asked.getByRole('img', { name: '新着' })).toHaveCount(0)
  await expect(asked.getByRole('button', { name: '確認した' })).toHaveCount(0)

  const stop = page.locator('[data-inbox-row="notice:n-stop"]')
  await expect(stop.getByRole('button', { name: '確認した' })).toHaveCount(0)
  await stop.getByRole('button', { name: /定期の仕事/ }).click()
  await expect(read(page)).toHaveText('n-asked')
  await stop.getByRole('button', { name: '済んだ' }).click()
  await expect(read(page)).toHaveText('n-asked|n-stop')
  await expect(stop).toHaveCount(0)
  await expect(count(page, 'あなた待ち')).toHaveText('2')
  await chip(page, /^確認したもの/).click()
  await expect(rows(page, '確認したもの')).toHaveCount(3)
})

test('a request approved on another PC leaves the list; its card then says it was approved', async ({ page }) => {
  await openPreview(page, 'inbox')
  await expect(page.locator('[data-inbox-row="record:approval-preview0001"]')).toBeVisible()
  await page.evaluate(() => (window as unknown as { __acbInbox: { approvedElsewhere(): void } }).__acbInbox.approvedElsewhere())
  await expect(page.locator('[data-inbox-row="record:approval-preview0001"]')).toHaveCount(0)
  await expect(count(page, 'あなた待ち')).toHaveText('2')
})

test('「すべて確認した」 marks every 新着 row and nothing of あなた待ち', async ({ page }) => {
  await openPreview(page, 'inbox')
  await page.getByRole('region', { name: '新着' }).getByRole('button', { name: 'すべて確認した' }).click()
  await expect(read(page)).toHaveText('n-asked,n-done,n-due,n-old')
  await expect(count(page, '新着')).toHaveText('0')
  await expect(page.locator('[data-inbox-row="notice:n-stop"]')).toBeVisible()
  await expect(page.getByRole('region', { name: 'あなた待ち' }).getByRole('button', { name: /すべて/ })).toHaveCount(0)
})

test('when marking seen cannot reach the server, a plain message says so and nothing pretends it was seen', async ({ page }) => {
  await openPreview(page, 'inbox', { offline: '1' })
  await page.getByRole('region', { name: '新着' }).getByRole('button', { name: 'すべて確認した' }).click()
  await expect(page.getByRole('alert')).toHaveText('サーバーにつながりませんでした。少し待ってからもう一度お試しください。')
  await expect(count(page, '新着')).toHaveText('4')
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
  await expect(count(page, 'あなた待ち')).toHaveText('5')
  const draft = page.locator(`[data-inbox-row="browser:${DRAFT}"]`)
  await expect(draft).toContainText('承認を待っています')
  await draft.getByRole('button', { name: '承認する…' }).click()
  const dialog = beside(page, '承認のお願い（ブラウザ操作）')
  await expect(dialog).toContainText('一覧からは任せられません')
  await expect(dialog.getByRole('button', { name: '任せる' })).toBeVisible()
  await expect(page.locator('#acted')).toHaveText('')
  await dialog.getByRole('button', { name: '閉じる' }).click()
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
  await beside(page, '承認のお願い（ブラウザ操作）').getByRole('button', { name: '閉じる' }).click()
  await expect(draft).toHaveCount(0)
  await expect(count(page, 'あなた待ち')).toHaveText('4')
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
      await expect(beside(page, '承認のお願い').getByRole('button', { name: '承認', exact: true })).toBeVisible()
      await page.screenshot({ path: `${SHOTS}/inbox-approval-card-${theme}.png`, animations: 'disabled' })
    }
    expectNoPageErrors(state)
  })
}

// Working through the inbox (owner decisions 2026-11-28, UX 点検 11; notifications.md "Working through the inbox").
const all = (page: Page) => page.locator('[data-inbox-row]')
const kinds = (page: Page) => page.getByRole('group', { name: '種類で絞る' })

test('15 rows first; going down shows the rest in the same list, asking the server nothing more; 「左の『やること』で見て」 is gone', async ({ page }) => {
  await openPreview(page, 'inbox', { many: '30' })
  await expect(all(page)).toHaveCount(15)
  const more = page.locator('[data-inbox-more]')
  await expect(more).toHaveText('続きを表示（あと 22 件）')
  const reads = await page.locator('#state-reads').textContent()
  await more.scrollIntoViewIfNeeded()
  await expect(all(page)).toHaveCount(30)
  await more.scrollIntoViewIfNeeded()
  await expect(all(page)).toHaveCount(37)
  await expect(more).toHaveCount(0)
  await expect(page.locator('#state-reads')).toHaveText(reads ?? '')
  await expect(page.getByText('で見てください')).toHaveCount(0)
  await expect(page.getByText('受け箱では数えません')).toHaveCount(0)
  // Another chip: 15 again.
  await chip(page, /^あなた待ち$/).click()
  await chip(page, /^新着$/).click()
  await expect(all(page)).toHaveCount(15)
})

test('案2: beside the red count, the rest of this week\'s turn is told once and opens やること; it is never counted red', async ({ page }) => {
  await openPreview(page, 'inbox')
  const elsewhere = page.locator('[data-inbox-elsewhere]')
  await expect(elsewhere).toHaveText('ほかに 今日が期限など 2 件は『やること』で')
  await expect(count(page, 'あなた待ち')).toHaveText('3')
  await elsewhere.click()
  await expect(page.locator('#opened')).toHaveText('task list')
})

test('the kinds narrow every section with their counts; too narrow, the last ones go under 「その他」, which names the one chosen', async ({ page }) => {
  await openPreview(page, 'inbox')
  const kind = (id: string) => kinds(page).locator(`[data-inbox-kind="${id}"]`)
  await expect(kind('all')).toHaveText('すべて 7')
  await expect(kind('approval')).toHaveText('承認 1')
  await kind('approval').click()
  await expect(all(page)).toHaveCount(1)
  await expect(all(page).first()).toHaveAttribute('data-inbox-row', 'record:approval-preview0001')
  await kind('all').click()
  await expect(all(page)).toHaveCount(7)

  await openPreview(page, 'inbox', { narrow: '1' })
  await expect(kind('contact')).toHaveCount(0)
  await expect(kind('approval')).toBeVisible()
  const other = kinds(page).getByRole('combobox', { name: 'ほかの種類' })
  await expect(other).toHaveValue('')
  await other.selectOption('notice')
  await expect(other).toHaveValue('notice')
  await expect(all(page)).toHaveCount(4)
  // The chips stay on one line: the list does not move down.
  const box = await kinds(page).boundingBox()
  expect(box?.height ?? 0).toBeLessThan(48)
})

test('a card opens beside the list; its press is followed by the next row (no ［取り消す］ for what cannot be taken back); nothing is approved from a row', async ({ page }) => {
  await openPreview(page, 'inbox', { approvals: '2' })
  await page.locator('[data-inbox-row="record:approval-more0001"]').getByRole('button', { name: '承認する…' }).click()
  const card = beside(page, '承認のお願い')
  await expect(card).toContainText('値引きの承認 1')
  await expect(card.getByRole('group', { name: '一覧の何件目か' })).toContainText('3 / 9')
  await expect(page.locator('#acted')).toHaveText('')
  await card.getByRole('button', { name: '承認', exact: true }).click()
  await expect(page.locator('#acted')).toHaveText('approve approval-more0001')
  await expect(card).toContainText('値引きの承認 2')
  const notice = page.locator('[data-work-notice]')
  await expect(notice).toHaveText('「値引きの承認 1」を片づけました。次の件です')
  await expect(notice.getByRole('button', { name: '取り消す' })).toHaveCount(0)
  await expect(page.locator('[data-inbox-row="record:approval-more0001"]')).toHaveCount(0)
  await expect(page.locator('[data-inbox-row="record:approval-more0002"]')).toHaveAttribute('data-inbox-current', '')
})

test('the keys: ↓ / j and ↑ / k go row by row (a card beside, a record in the middle), Enter goes into the card, Esc back to its row', async ({ page }) => {
  await openPreview(page, 'inbox')
  const row = (key: string) => page.locator(`[data-inbox-row="${key}"] [data-work-row]`)
  await row('record:approval-preview0001').click()
  await expect(beside(page, '承認のお願い')).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(beside(page, '送るメールの下書き')).toBeVisible()
  await expect(row('record:outbound_message-preview01')).toBeFocused()
  await expect(beside(page, '送るメールの下書き').getByRole('group', { name: '一覧の何件目か' })).toContainText('3 / 7')
  // A 新着 row opens where it lives (the middle) and is read, kept in its place.
  await page.keyboard.press('j')
  await expect(page.locator('#opened')).toHaveText('record task-asked0001')
  await expect(read(page)).toHaveText('n-asked')
  await expect(beside(page, '送るメールの下書き')).toHaveCount(0)
  await expect(page.locator('[data-inbox-row="record:task-asked0001"]')).toBeVisible()
  await page.keyboard.press('k')
  await expect(beside(page, '送るメールの下書き')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-work-card="inbox"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(row('record:outbound_message-preview01')).toBeFocused()
})
