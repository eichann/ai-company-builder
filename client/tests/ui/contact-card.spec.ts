// 「連絡」1枚 (inbox.md "One contact", owner decision 2026-11-28 「5番」) in the real inbox and its card window
// (tests/inbox-ui.html?contact=<scene>, a fake server keeping the two records): one row per contact, only the buttons the
// server allows, one press ends both records, ［取り消す］ brings both back, a refusal says nothing changed.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const row = (page: Page) => page.locator('[data-inbox-row="contact:interaction-prev01a"]')
const card = (page: Page) => page.getByRole('dialog', { name: '連絡' })
async function openCard(page: Page) {
  await row(page).getByRole('button', { name: '開く', exact: true }).click()
  await expect(card(page).locator('[data-contact-card]')).toBeVisible()
}

test('a 来た連絡 and its 返事のお願い are one row 「連絡」 in the inbox; the 返事のお願い has no row of its own', async ({ page }) => {
  const state = await openPreview(page, 'inbox', { contact: 'own' })
  await expect(row(page)).toHaveCount(1)
  await expect(page.locator('[data-inbox-row="record:reply_request-prev01a"]')).toHaveCount(0)
  await expect(page.locator('[data-inbox-row="record:interaction-prev01a"]')).toHaveCount(0)
  await expect(row(page)).toContainText('返事が要る（期限 12/2）')
  expectNoPageErrors(state)
})

test('only the buttons the server allows: ［返した］ to reply, ［済んだ（もう待たない）］ while waiting, none for someone else\'s', async ({ page }) => {
  await openPreview(page, 'inbox', { contact: 'own' })
  await openCard(page)
  await expect(card(page).getByRole('button', { name: '返した', exact: true })).toBeVisible()

  await openPreview(page, 'inbox', { contact: 'waiting' })
  await openCard(page)
  await expect(card(page).getByRole('button', { name: '済んだ（もう待たない）' })).toBeVisible()
  await expect(card(page).getByRole('button', { name: '返した', exact: true })).toHaveCount(0)
  await expect(card(page)).toContainText('追いかけの日 12/5')

  await openPreview(page, 'inbox', { contact: 'other' })
  await openCard(page)
  await expect(card(page)).toContainText('田中さんが返します（期限 12/2）')
  for (const name of ['返した', '済んだ', '済んだ（もう待たない）', '下書きを確かめて送る']) await expect(card(page).getByRole('button', { name, exact: true })).toHaveCount(0)
  await expect(card(page).getByRole('button', { name: 'その他の操作' })).toHaveCount(0)
})

test('with a draft the main button checks and sends it; ［返した（下書きは送らない）］ is in 「…」', async ({ page }) => {
  await openPreview(page, 'inbox', { contact: 'draft' })
  await openCard(page)
  await expect(card(page).getByRole('button', { name: '返した', exact: true })).toHaveCount(0)
  await card(page).getByRole('button', { name: 'その他の操作' }).click()
  await expect(card(page).getByRole('menuitem', { name: /返した（下書きは送らない）/ })).toContainText('下書きは送らずに片づけます（取り消すと戻ります）')
  await card(page).getByRole('button', { name: 'その他の操作' }).click()
  await card(page).getByRole('button', { name: '下書きを確かめて送る' }).click()
  // The draft's own card (only it sends); nothing was finished.
  await expect(page.getByRole('dialog', { name: '送るメールの下書き' })).toBeVisible()
  await expect(page.locator('#acted')).toHaveText('')
})

test('［取り消す］ of a contact ACB archived in Gmail says the mail stays archived; one never archived says nothing of Gmail', async ({ page }) => {
  for (const [scene, stays] of [['archived', true], ['own', false]] as const) {
    await openPreview(page, 'inbox', { contact: scene })
    await openCard(page)
    await card(page).getByRole('button', { name: '返した', exact: true }).click()
    await card(page).getByRole('button', { name: '取り消す' }).click()
    await expect(card(page).getByRole('status')).toContainText('元に戻しました（返事のお願いも連絡も）')
    if (stays) await expect(card(page).getByRole('status')).toContainText('メールは Gmail でアーカイブされたままです')
    else await expect(card(page).getByRole('status')).not.toContainText('Gmail')
  }
})

test('one press of ［返した］ ends both records; ［取り消す］ brings both back', async ({ page }) => {
  const state = await openPreview(page, 'inbox', { contact: 'own' })
  await openCard(page)
  await card(page).getByRole('button', { name: '返した', exact: true }).click()
  await expect(page.locator('#acted')).toHaveText('finish {"interaction":{"expectedVersion":7},"replyRequest":{"id":"reply_request-prev01a","expectedVersion":4,"action":"replied_elsewhere"}}')
  await expect(card(page).getByRole('status')).toContainText('返したことにしました（連絡も済んだにしました）')
  await expect(card(page).getByText('済んだ', { exact: true })).toBeVisible()
  await expect(card(page).getByRole('button', { name: '返した', exact: true })).toHaveCount(0)

  await card(page).getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#acted')).toHaveText('undo {"interaction":{"version":8,"expectedVersion":8},"replyRequest":{"id":"reply_request-prev01a","version":5,"expectedVersion":5}}')
  await expect(card(page).getByRole('status')).toContainText('元に戻しました（返事のお願いも連絡も）')
  await expect(card(page).getByText('返事が要る（期限 12/2）')).toBeVisible()
  await expect(card(page).getByRole('button', { name: '返した', exact: true })).toBeVisible()
  expectNoPageErrors(state)
})

test('refused because someone changed it first: says neither was changed, and offers no ［取り消す］', async ({ page }) => {
  await openPreview(page, 'inbox', { contact: 'conflict' })
  await openCard(page)
  await card(page).getByRole('button', { name: '返した', exact: true }).click()
  await expect(card(page).getByRole('alert')).toContainText('ほかの人か AI が先に変えたため、どちらも変えていません')
  await expect(card(page).getByRole('button', { name: '取り消す' })).toHaveCount(0)
  await expect(card(page).getByRole('button', { name: '返した', exact: true })).toBeVisible()
})

test('［取り消す］ after someone else changed the contact is refused: the card sends the versions the finish answered, never the ones it read later', async ({ page }) => {
  await openPreview(page, 'inbox', { contact: 'changed' })
  await openCard(page)
  await card(page).getByRole('button', { name: '返した', exact: true }).click()
  await expect(card(page).getByRole('status')).toContainText('返したことにしました')
  // The card has read the contact again (version 9 now); the undo still names 8, so the change in between is not taken back.
  await card(page).getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#acted')).toHaveText('undo {"interaction":{"version":8,"expectedVersion":8},"replyRequest":{"id":"reply_request-prev01a","version":5,"expectedVersion":5}}')
  await expect(card(page).getByRole('alert')).toContainText('ほかの人か AI が先に変えたため、取り消せませんでした（どちらもそのままです）')
  await expect(card(page).getByRole('button', { name: '取り消す' })).toHaveCount(0)
})

test('a contact whose reply is over with a やること left is in 「確認したもの」 and its card lists the やること', async ({ page }) => {
  await openPreview(page, 'inbox', { contact: 'made' })
  await expect(row(page)).toHaveCount(0)
  await page.getByRole('group', { name: '受け箱の絞り込み' }).getByRole('button', { name: /^確認したもの/ }).click()
  await expect(row(page)).toContainText('返事は済みました・やることが 1 件残っています')
  await openCard(page)
  await card(page).locator('[data-contact-task="task-prev01a"]').click()
  await expect(page.locator('#opened')).toHaveText('record task-prev01a')
})
