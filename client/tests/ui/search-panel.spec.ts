// The left 「探す」 tab (features/search SearchPanel) on its preview page (tests/search-panel-ui.html):
// the empty tab's own lists, the live search (no Enter, IME-safe, Esc clears, one search per pause),
// summary cards before 名前 / 中身, one row per thing, consultations found through their やること
// and folded under it, the department scope with 全社で探す, and the period / 自分 narrowing.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const box = (page: Page) => page.getByRole('textbox', { name: '探す' })
const calls = async (page: Page) => ((await page.locator('#calls').textContent()) ?? '').trim().split('\n').filter(Boolean)
const opened = (page: Page) => page.locator('#opened')

test('nothing typed: the ⌘K hint and the member’s own recent things', async ({ page }) => {
  const state = await openPreview(page, 'search-panel')
  await expect(page.getByText('名前が分かっているものは')).toBeVisible()
  const empty = page.locator('[data-empty-state]')
  await expect(empty.getByText('最近開いたもの')).toBeVisible()
  await expect(empty.getByText('自分が関わっている進行中の案件')).toBeVisible()
  await expect(empty.getByText('やること 2・次の会議')).toBeVisible()
  await expect(empty.getByText('この1週間の会議')).toBeVisible()
  await empty.getByRole('button', { name: /研修導入のご相談 3回目/ }).click()
  await expect(opened(page)).toContainText('record meeting-000003')
  expectNoPageErrors(state)
})

test('typing searches by itself once, after a pause; Enter at once; Esc clears', async ({ page }) => {
  await openPreview(page, 'search-panel')
  await box(page).pressSequentially('サンプル', { delay: 30 })
  await expect(page.locator('[data-summary-card]').first()).toBeVisible()
  expect((await calls(page)).filter(c => c.startsWith('records'))).toEqual(['records サンプル'])
  await box(page).press('Escape')
  await expect(box(page)).toHaveValue('')
  await expect(page.locator('[data-empty-state]')).toBeVisible()
  await box(page).fill('講師')
  await box(page).press('Enter')
  await expect(page.locator('[data-hit="record:task-quote001"]')).toBeVisible()
})

test('a word being converted (IME) is not searched until it is fixed', async ({ page }) => {
  await openPreview(page, 'search-panel')
  await box(page).dispatchEvent('compositionstart')
  await box(page).fill('さんぷる')
  await page.waitForTimeout(500)
  expect(await calls(page)).toEqual([])
  await box(page).fill('サンプル')
  await box(page).dispatchEvent('compositionend')
  await expect.poll(() => calls(page)).toContain('records サンプル')
})

test('cards for the 相手 / 案件 first, then names, then contents — one row per file', async ({ page }) => {
  const state = await openPreview(page, 'search-panel')
  await box(page).fill('サンプル')
  const cards = page.locator('[data-summary-card]')
  await expect(cards).toHaveCount(3)
  await expect(cards.first()).toContainText('株式会社サンプル')
  await expect(cards.first()).toContainText('案件 2・やること 3・会議 2・決めたこと 1・ファイル 4')
  await expect(page.locator('[data-section="name"]')).toBeVisible()
  await expect(page.locator('[data-section="content"]')).toBeVisible()
  // The quote file has two lines with the word: one row.
  await expect(page.locator('[data-hit="file:営業部/顧客/株式会社サンプル/見積書_株式会社サンプル.md"]')).toHaveCount(1)
  // A finished やること is struck through; something of no department carries 全社 only when it differs.
  await expect(page.locator('[data-hit="record:task-thanks01"] .line-through')).toBeVisible()
  // Top 3 per kind, then 「ほか N件」.
  const more = page.locator('[data-more="name:file"]')
  await expect(more).toHaveText(/ほか 1件/)
  await more.click()
  await expect(more).toHaveText(/少なくする/)
  await cards.first().click({ position: { x: 12, y: 12 } })
  await expect(opened(page)).toContainText('record company-sample01')
  expectNoPageErrors(state)
})

test('the scope starts at the department on screen; other departments are counted and one press away', async ({ page }) => {
  await openPreview(page, 'search-panel')
  await box(page).fill('サンプル')
  await expect(page.locator('[data-scope]')).toContainText('営業部の中で')
  await expect(page.locator('[data-hit="record:task-devapp01"]')).toHaveCount(0)
  const elsewhere = page.locator('[data-elsewhere]')
  await expect(elsewhere).toContainText('ほかの部署にも 2件 あります（全社で探す）')
  await elsewhere.click()
  await expect(page.locator('[data-scope]')).toContainText('全社で')
  await expect(page.locator('[data-hit="record:task-devapp01"] [data-other-department]')).toHaveText('開発部')
  // The file contents are searched company-wide now.
  await expect.poll(() => calls(page)).toContain('grep サンプル in 全社')
})

test('period and 自分が関わった narrow what is shown', async ({ page }) => {
  await openPreview(page, 'search-panel')
  await box(page).fill('サンプル')
  const old = page.locator('[data-hit="file:営業部/研修事例/事例_製造業.md"]')
  await expect(old).toBeVisible()
  await page.getByRole('button', { name: '1週間' }).click()
  await expect(old).toHaveCount(0)
  await page.getByRole('button', { name: 'いつでも' }).click()
  await expect(old).toBeVisible()
  await page.getByRole('button', { name: '自分が関わった' }).click()
  await expect(old).toHaveCount(0)
  await expect(page.locator('[data-hit="record:task-hire0001"]')).toHaveCount(0)
  await expect(page.locator('[data-hit="record:task-memo0001"]')).toBeVisible()
})

test('kind chips only for kinds found, and they narrow the list', async ({ page }) => {
  await openPreview(page, 'search-panel')
  await box(page).fill('サンプル')
  const chips = page.getByRole('group', { name: '種類で絞る' })
  await expect(chips.locator('[data-find-chip="file"]')).toBeVisible()
  await expect(chips.locator('[data-find-chip="approval"]')).toHaveCount(0)
  await chips.locator('[data-find-chip="file"]').click()
  await expect(page.locator('[data-summary-card]')).toHaveCount(0)
  await expect(page.locator('[data-hit^="record:"]')).toHaveCount(0)
})

test('a consultation is found through its やること, folded under it and opened in the chat', async ({ page }) => {
  await openPreview(page, 'search-panel')
  await box(page).fill('見積書を直す')
  await expect(page.locator('[data-hit="consultation:c-teach"] [data-why]')).toHaveText('やること『見積書を直す（講師を3日に）』の相談')
  const under = page.locator('[data-consults-under="task-quote001"]')
  await under.getByRole('button', { name: /AIへの相談 1/ }).click()
  await under.locator('[data-consult="c-teach"]').click()
  await expect(opened(page)).toContainText('consultation c-teach')
})

test('a card’s 相談 count lists that 案件’s consultations until cleared', async ({ page }) => {
  await openPreview(page, 'search-panel')
  await box(page).fill('サンプル')
  const card = page.locator(`[data-summary-card="deal-sample01"]`)
  await card.locator('[data-card-consults]').click()
  const list = page.locator('[data-section="hub-consults"]')
  await expect(list).toContainText('株式会社サンプルの見積を一緒に考える')
  await expect(list).toContainText('講師の日程の相談')
  await expect(page.locator('[data-section="name"]')).toHaveCount(0)
  await page.getByRole('button', { name: '絞り込みをやめる' }).click()
  await expect(page.locator('[data-section="name"]')).toBeVisible()
})

test('a folder not downloaded is said once', async ({ page }) => {
  await openPreview(page, 'search-panel', { excluded: '営業部/研修事例' })
  await box(page).fill('サンプル')
  await expect(page.getByText('ダウンロードしていないフォルダのファイルは探していません')).toBeVisible()
})
