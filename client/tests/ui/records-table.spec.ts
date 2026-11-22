// 「記録の一覧」 (tests/records-table-ui.tsx, features/records-table, tasks-ui.md "The records table
// (B4)"). Guards: the doors (［表で見る］ in the task list, ⌘K) open one middle tab; the rows are the
// answer's; sorting by a header and the text filter; a row (click or keyboard) opens its record in a
// tab beside it and the table keeps its narrowing; a kind switched to fast wins over a late answer;
// the plain-Japanese states (records off, offline); 「さらに読む」 for a long kind.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const table = (page: Page) => page.getByRole('region', { name: '記録の一覧' })
const titles = (page: Page) => table(page).locator('tbody tr').evaluateAll(rows => rows.map(r => r.getAttribute('aria-label')))

test('［表で見る］ opens the table in a middle tab; the rows are the answer\'s, open ones first', async ({ page }) => {
  const state = await openPreview(page, 'records-table')
  await page.getByRole('button', { name: '表で見る（やること）' }).click()
  await expect(page.getByRole('tab', { name: /記録の一覧/ })).toHaveAttribute('aria-selected', 'true')
  await expect(table(page).getByRole('button', { name: 'やること', pressed: true })).toBeVisible()
  // 済み以外 asks the server (the 完了 one is not in its answer) — nothing is hidden on the screen.
  expect(await titles(page)).toEqual(['北山工業に事例集を送る', '森田さまへのお礼メールを確かめる', 'さくら不動産の契約書を法務に回す', '見積もりを作って送る', '研修の日程案を出す'])
  await expect(table(page).getByText('あなただけ')).toBeVisible()
  await expect(table(page).getByRole('row', { name: '北山工業に事例集を送る' })).toContainText('（過ぎています）')
  await expect(table(page).getByRole('row', { name: '森田さまへのお礼メールを確かめる' })).not.toContainText('過ぎています')
  await table(page).getByLabel('状態').selectOption('all')
  await expect(table(page).getByRole('row', { name: '先週の議事録を共有する' })).toBeVisible()
  const asked = await page.evaluate(() => (window as unknown as { __acbAsked: Array<{ openOnly: boolean }> }).__acbAsked.map(q => q.openOnly))
  expect(asked).toEqual([true, false])
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/records-table-light.png` })
  expectNoPageErrors(state)
})

test('sorting by a header and the text filter work on the rows read', async ({ page }) => {
  await openPreview(page, 'records-table')
  await page.getByRole('button', { name: '表で見る（やること）' }).click()
  const due = table(page).getByRole('columnheader', { name: '期限' })
  await due.getByRole('button').click()
  await expect(due).toHaveAttribute('aria-sort', 'ascending')
  expect((await titles(page))[0]).toBe('北山工業に事例集を送る')
  expect((await titles(page)).at(-1)).toBe('研修の日程案を出す') // no due: last
  await due.getByRole('button').click()
  await expect(due).toHaveAttribute('aria-sort', 'descending')
  expect((await titles(page))[0]).toBe('見積もりを作って送る')
  await table(page).getByLabel('文字で絞り込む').fill('佐藤')
  expect(await titles(page)).toEqual(['見積もりを作って送る', '森田さまへのお礼メールを確かめる'])
  await table(page).getByLabel('文字で絞り込む').fill('存在しない言葉')
  await expect(table(page)).toContainText('「存在しない言葉」に合う行はありません')
})

test('a row opens its record beside the table (click, ↓ and Enter); back on the table its narrowing stays', async ({ page }) => {
  await openPreview(page, 'records-table')
  await page.getByRole('button', { name: '表で見る（やること）' }).click()
  await table(page).getByLabel('文字で絞り込む').fill('契約')
  await table(page).getByRole('row', { name: 'さくら不動産の契約書を法務に回す' }).click()
  await expect(page.getByTestId('record-page')).toHaveText('記録のページ：task-sakura')
  await expect(page.getByRole('tab', { name: /記録の一覧/ })).toBeVisible()
  await page.getByRole('tab', { name: /記録の一覧/ }).click()
  await expect(table(page).getByLabel('文字で絞り込む')).toHaveValue('契約')
  await table(page).getByLabel('文字で絞り込む').fill('')
  await table(page).getByRole('row', { name: '北山工業に事例集を送る' }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(table(page).getByRole('row', { name: '森田さまへのお礼メールを確かめる' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('record-page')).toHaveText('記録のページ：task-morita')
})

test('⌘K finds 「記録の一覧」 and opens the same one tab', async ({ page }) => {
  await openPreview(page, 'records-table')
  await page.getByRole('button', { name: '⌘K を開く' }).click()
  await page.keyboard.type('記録の一覧')
  await page.getByRole('option', { name: /記録の一覧/ }).first().click()
  await expect(page.getByRole('tab', { name: /記録の一覧/ })).toHaveCount(1)
  await expect(table(page).getByRole('row', { name: '北山工業に事例集を送る' })).toBeVisible()
})

test('a kind switched to fast wins over the late answer of the one before', async ({ page }) => {
  await openPreview(page, 'records-table', { slow: 'task' })
  await page.getByRole('button', { name: '表で見る（やること）' }).click()
  await page.getByRole('button', { name: '表で見る（やること）' }).click() // a second, fast read shows the kinds
  await table(page).getByRole('button', { name: '決めたこと' }).click()
  await expect(table(page).getByRole('row', { name: '見積もりは税込で出す' })).toBeVisible()
  await page.waitForTimeout(1000) // the first やること answer arrives now
  await expect(table(page).getByRole('button', { name: '決めたこと', pressed: true })).toBeVisible()
  expect(await titles(page)).toEqual(['見積もりは税込で出す'])
})

test('records off and an unreachable server are said in plain words', async ({ page }) => {
  await openPreview(page, 'records-table', { off: '1' })
  await page.getByRole('button', { name: '表で見る（やること）' }).click()
  await expect(table(page)).toContainText('この会社では、やることや決めたことなどの記録を使っていません。')
  await openPreview(page, 'records-table', { offline: '1' })
  await page.getByRole('button', { name: '表で見る（やること）' }).click()
  await expect(table(page).getByText('サーバーにつながらないため')).toBeVisible()
  await expect(table(page).getByRole('button', { name: 'もう一度' })).toBeVisible()
})

test('a long kind is read 200 at a time: the foot says so and 「さらに読む」 reads the next', async ({ page }) => {
  await openPreview(page, 'records-table', { many: '1' })
  await page.getByRole('button', { name: '表で見る（やること）' }).click()
  await expect(page.getByTestId('records-table-page-note')).toContainText('全 450 件のうち 200 件')
  await page.getByRole('button', { name: 'さらに読む' }).click()
  await expect(page.getByTestId('records-table-page-note')).toContainText('全 450 件のうち 400 件')
  expect(await table(page).locator('tbody tr').count()).toBe(400)
})

test('dark: the table reads on a dark surface', async ({ page }) => {
  await openPreview(page, 'records-table', { theme: 'dark' })
  await page.getByRole('button', { name: '表で見る（やること）' }).click()
  await expect(table(page).getByRole('row', { name: '北山工業に事例集を送る' })).toBeVisible()
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/records-table-dark.png` })
  const bg = await table(page).evaluate(el => getComputedStyle(el).backgroundColor)
  const [r, g, b] = (bg.match(/\d+/g) ?? []).map(Number)
  expect(r + g + b).toBeLessThan(120)
})

test('the task list\'s ［表で見る］ is the door from やること', async ({ page }) => {
  await openPreview(page, 'tasks-list')
  await page.getByRole('button', { name: '表で見る' }).click()
  await expect(page.locator('#acted')).toContainText('show table')
})

// On the main screen (src/app/AppShell.tsx on skill-layout-ui.html?tasks=1): the real doors and the
// editor's screen tab. The table tab is neither a file nor a record: never listed for the AI, never
// kept in 「片づけたタブ」, never brought back by a restart (one press opens it again).
test('main screen: ［表で見る］ opens one tab, a row opens the task beside it; tidy, the AI and a restart leave it out', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { tasks: '1' })
  await page.getByRole('button', { name: /^やること/ }).first().click()
  await page.getByRole('button', { name: '表で見る' }).click()
  const tableTab = page.getByRole('tab', { name: /記録の一覧/ })
  await expect(tableTab).toHaveAttribute('aria-selected', 'true')
  await table(page).getByRole('row', { name: 'A社 提案書を仕上げる' }).click()
  await expect(page.getByRole('tab', { name: /A社 提案書を仕上げる/ })).toHaveAttribute('aria-selected', 'true')
  await expect(tableTab).toHaveCount(1)
  // A second ［表で見る］ shows the same tab again.
  await page.getByRole('button', { name: '表で見る' }).click()
  await expect(page.getByRole('tab', { name: /記録の一覧/ })).toHaveCount(1)

  type Layout = { aiCommand(id: string, args?: unknown): Promise<unknown> }
  const listed = await page.evaluate(() => (window as unknown as { __acbLayout: Layout }).__acbLayout.aiCommand('tabs.list')) as { result: { openTabs: unknown[] } }
  expect(JSON.stringify(listed.result.openTabs)).not.toContain('acb-view')
  expect(listed.result.openTabs).toHaveLength(1)

  await page.getByRole('button', { name: 'タブの操作' }).click()
  await page.getByRole('menuitem', { name: /タブを片づける/ }).click()
  await expect(page.getByRole('tab', { name: /記録の一覧/ })).toHaveCount(0)
  await page.getByRole('button', { name: '片づけたタブを見る' }).click()
  const tidied = page.getByRole('dialog', { name: '片づけたタブ' })
  await expect(tidied.locator('[data-tidied-item]')).toHaveCount(1)
  await expect(tidied).not.toContainText('記録の一覧')
  expectNoPageErrors(state)
})

test('main screen: an app restart does not bring the table tab back; the task tab stays', async ({ page }) => {
  await openPreview(page, 'skill-layout', { tasks: '1' })
  await page.getByRole('button', { name: /^やること/ }).first().click()
  await page.getByRole('button', { name: '表で見る' }).click()
  await table(page).getByRole('row', { name: 'A社 提案書を仕上げる' }).click()
  await expect(page.getByRole('tab', { name: /A社 提案書を仕上げる/ })).toBeVisible()
  await page.waitForTimeout(600) // the tabs are saved
  await openPreview(page, 'skill-layout', { tasks: '1', keep: '1' })
  await expect(page.getByRole('tab', { name: /A社 提案書を仕上げる/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /記録の一覧/ })).toHaveCount(0)
})

test('main screen: a pin saved on the table tab is not restored (the tab opens unpinned)', async ({ page }) => {
  const editor = JSON.stringify({ openFiles: ['/Users/demo/会社/README.md'], activeFilePath: '/Users/demo/会社/README.md', leftTab: 'tasks', pinned: ['/Users/demo/会社/README.md', 'acb-view:records-table'] })
  await openPreview(page, 'skill-layout', { tasks: '1', seed: JSON.stringify({ 'editor:demo': editor }) })
  await page.getByRole('button', { name: '表で見る' }).click()
  const tableTab = page.getByRole('tab', { name: /記録の一覧/ })
  await expect(tableTab).toHaveAttribute('aria-selected', 'true')
  await expect(tableTab).not.toHaveAttribute('data-pinned', /.*/)
  await expect(page.locator('[data-pinned]')).toHaveCount(1)
})
