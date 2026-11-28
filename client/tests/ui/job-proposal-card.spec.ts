// 「定期の仕事の案」 changed in place (UX 段3 #13, owner decisions 2026-11-28 「12・13番」; jobs.md "Member proposals" "The card
// changed in place"): `tests/job-proposal-card-ui.html` (fictional data, fixed dates; the server faked by the page).
import { test, expect, type Page } from '@playwright/test'

const PAGE = '/tests/job-proposal-card-ui.html'
const fp = (n: number) => `sha256:${n.toString(16).padStart(2, '0').repeat(32)}`

const chatCard = (page: Page) => page.getByRole('region', { name: '相談' }).getByRole('group', { name: '定期の仕事の案' })
const lines = async (page: Page, id: string) => ((await page.locator(`#${id}`).textContent()) ?? '').trim().split('\n').filter(Boolean)

test('a value changed in place: the server checks it, the card shows the new candidate, and 出す sends what is shown', async ({ page }) => {
  await page.goto(PAGE)
  const card = chatCard(page)
  await expect(card.getByText('定期の仕事の案：weekly-report（毎週月曜 09:00）')).toBeVisible()
  await card.getByRole('button', { name: '曜日を直す' }).click()
  await card.getByRole('combobox', { name: '曜日' }).selectOption({ label: '火曜' })
  await expect(card.getByText('定期の仕事の案：weekly-report（毎週火曜 09:00）')).toBeVisible()
  await expect(card.getByText(/直した案をサーバーで確かめました。出すのはこの案です（曜日：月曜 → 火曜）/)).toBeVisible()
  const sent = JSON.parse((await lines(page, 'revised'))[0])
  expect(sent.fingerprint).toBe(fp(1))
  expect(sent.input.trigger).toEqual({ every: 'week', weekday: 'tue', at: '09:00', businessDaysBefore: 0 })
  // Everything else is sent as it was (the whole input, no name: the server makes it).
  expect(sent.input).toMatchObject({ skill: 'weekly-report', reads: ['営業部/提案書'], deliverable: '営業部/週報', minutes: 15 })
  expect(Object.keys(sent.input).sort()).toEqual(['check', 'deliverable', 'mailDrafts', 'minutes', 'missed', 'readRecords', 'reads', 'skill', 'trigger'])
  await card.getByRole('button', { name: 'これで管理者に出す' }).click()
  await expect(card.getByText('管理者の確認待ちです。まだ何も動いていません。')).toBeVisible()
  expect(await lines(page, 'submitted')).toEqual([fp(2)])
})

test('while the server checks a change, it shows so and nothing can be sent', async ({ page }) => {
  await page.goto(`${PAGE}?hold=1`)
  const card = chatCard(page)
  await card.getByRole('button', { name: '時刻を直す' }).click()
  await card.getByRole('combobox', { name: '時刻' }).selectOption('10:30')
  await expect(card.getByRole('status').filter({ hasText: '直した案をサーバーで確かめています' })).toBeVisible()
  await expect(card).toHaveAttribute('aria-busy', 'true')
  await expect(card.getByRole('button', { name: 'これで管理者に出す' })).toBeDisabled()
  await expect(card.getByRole('button', { name: '曜日を直す' })).toBeDisabled()
  await expect(card.getByRole('button', { name: '時刻を直す' })).toHaveText('10:30')
  await page.evaluate(() => (window as unknown as { __acbRelease: () => void }).__acbRelease())
  await expect(card.getByText('定期の仕事の案：weekly-report（毎週月曜 10:30）')).toBeVisible()
  await expect(card.getByRole('button', { name: 'これで管理者に出す' })).toBeEnabled()
})

test('while a change from the chat\'s card is checked, the tab\'s card of the same candidate offers nothing either', async ({ page }) => {
  await page.goto(`${PAGE}?hold=1`)
  await chatCard(page).getByRole('button', { name: '大きく開く（タブ）' }).click()
  const tabCard = page.getByRole('region', { name: 'タブ' }).getByRole('group', { name: '定期の仕事の案' })
  await expect(tabCard.getByRole('button', { name: 'これで管理者に出す' })).toBeEnabled()
  await chatCard(page).getByRole('button', { name: '曜日を直す' }).click()
  await chatCard(page).getByRole('combobox', { name: '曜日' }).selectOption({ label: '水曜' })
  await expect(tabCard.getByRole('button', { name: 'これで管理者に出す' })).toBeDisabled()
  await expect(tabCard.getByRole('button', { name: '曜日を直す' })).toHaveText('水曜')
  await page.evaluate(() => (window as unknown as { __acbRelease: () => void }).__acbRelease())
  await expect(tabCard.getByText('定期の仕事の案：weekly-report（毎週水曜 09:00）')).toBeVisible()
  await expect(tabCard.getByRole('button', { name: 'これで管理者に出す' })).toBeEnabled()
})

test('a change whose answer was lost is judged by reading the candidate: made → said so, never 「まだ直っていません」', async ({ page }) => {
  await page.goto(`${PAGE}?lost=1`)
  const card = chatCard(page)
  await card.getByRole('button', { name: '曜日を直す' }).click()
  await card.getByRole('combobox', { name: '曜日' }).selectOption({ label: '木曜' })
  await expect(card.getByText('定期の仕事の案：weekly-report（毎週木曜 09:00）')).toBeVisible()
  await expect(card.getByText('直した案をサーバーで確かめました。出すのはこの案です。')).toBeVisible()
  await expect(card.getByText(/まだ直っていません/)).toHaveCount(0)
})

// 読む場所 says every place the AI will be able to read (grant.reads.paths), the check's own place included — never 「なし」
// while the check's place is read (Codex review of UX stage 3, P2). Only the places added besides it can be taken off.
const readsRow = (page: Page) => chatCard(page).locator('div', { has: page.locator('dt', { hasText: /^読む場所$/ }) }).locator('dd')

test('読む場所 shows the check\'s place the AI reads, even when nothing else is read: never 「なし」', async ({ page }) => {
  await page.goto(`${PAGE}?reads=none`)
  const row = readsRow(page)
  await expect(row).toContainText('営業部/訪問メモ')
  await expect(row).toContainText('確かめる場所')
  await expect(row).not.toContainText('なし')
  await expect(row.getByRole('button', { name: '「営業部/訪問メモ」を外す' })).toHaveCount(0)
})

test('読む場所: the places added besides the check\'s can be taken off, the check\'s place cannot; it follows a new check place', async ({ page }) => {
  await page.goto(PAGE)
  const card = chatCard(page)
  const row = readsRow(page)
  await expect(row).toContainText('営業部/提案書')
  await expect(row).toContainText('営業部/訪問メモ')
  await expect(row.getByRole('button', { name: '「営業部/提案書」を外す' })).toBeVisible()
  await expect(row.getByRole('button', { name: '「営業部/訪問メモ」を外す' })).toHaveCount(0)
  // The check looks somewhere else: the AI reads that place instead, and 読む場所 says so.
  await card.getByRole('button', { name: '確かめる場所を直す' }).click()
  await card.getByRole('combobox', { name: '確かめる場所' }).selectOption('営業部/資料')
  await expect(card.getByText(/直した案をサーバーで確かめました/)).toBeVisible()
  await expect(row).toContainText('営業部/資料')
  await expect(row).not.toContainText('営業部/訪問メモ')
  await expect(row.getByRole('button', { name: '「営業部/資料」を外す' })).toHaveCount(0)
})

test('a place the server refuses goes back, and the card names no place in its reason', async ({ page }) => {
  await page.goto(PAGE)
  const card = chatCard(page)
  await card.getByRole('button', { name: '置く場所を直す' }).click()
  await card.getByRole('combobox', { name: '置く場所' }).selectOption('総務部/人事評価')
  const alert = card.getByRole('alert')
  await expect(alert).toContainText('選んだ場所は、いまのあなたは使えません')
  await expect(alert).toContainText('元の内容に戻しました')
  await expect(alert).not.toContainText('人事')
  await expect(alert).not.toContainText('総務')
  await expect(card.getByRole('button', { name: '置く場所を直す' })).toHaveText('営業部/週報')
  // Nothing changed on the server: 出す sends the content still shown.
  await card.getByRole('button', { name: 'これで管理者に出す' }).click()
  expect(await lines(page, 'submitted')).toEqual([fp(1)])
})

test('出す on content that changed elsewhere is refused and the card reads the new content, then sends it', async ({ page }) => {
  await page.goto(PAGE)
  const card = chatCard(page)
  await expect(card.getByRole('button', { name: '1回の時間を直す' })).toHaveText('15分')
  await page.evaluate(() => (window as unknown as { __acbChangeElsewhere: () => void }).__acbChangeElsewhere())
  await card.getByRole('button', { name: 'これで管理者に出す' }).click()
  await expect(card.getByRole('alert')).toContainText('画面に出ていた内容と、いまの案が違います')
  await expect(card.getByRole('button', { name: '1回の時間を直す' })).toHaveText('30分')
  await card.getByRole('button', { name: 'これで管理者に出す' }).click()
  expect(await lines(page, 'submitted')).toEqual([fp(1), fp(2)])
})

test('「出す前に知っておくこと」: one line shown, the rest folded until opened', async ({ page }) => {
  await page.goto(PAGE)
  const notes = chatCard(page).getByRole('group', { name: '出す前に' })
  await expect(notes.getByText('出しても、管理者が承認し、あなたが「定期の仕事」で「受け取る」を押すまでは何も動きません。')).toBeVisible()
  const folded = notes.getByText(/確かめて新しいものが無い回は/)
  await expect(folded).toBeHidden()
  await notes.getByText('ほかに出す前に知っておくこと（3）').click()
  await expect(folded).toBeVisible()
})

test('［大きく開く（タブ）］ opens the same candidate as a tab; a change there shows in the chat\'s card too', async ({ page }) => {
  await page.goto(PAGE)
  await chatCard(page).getByRole('button', { name: '大きく開く（タブ）' }).click()
  const tabCard = page.getByRole('region', { name: 'タブ' }).getByRole('group', { name: '定期の仕事の案' })
  await expect(tabCard.getByText('定期の仕事の案：weekly-report（毎週月曜 09:00）')).toBeVisible()
  // The tab is where it is already large: no second ［大きく開く］ there.
  await expect(tabCard.getByRole('button', { name: '大きく開く（タブ）' })).toHaveCount(0)
  await tabCard.getByRole('button', { name: '曜日を直す' }).click()
  await tabCard.getByRole('combobox', { name: '曜日' }).selectOption({ label: '金曜' })
  await expect(chatCard(page).getByText('定期の仕事の案：weekly-report（毎週金曜 09:00）')).toBeVisible()
})
