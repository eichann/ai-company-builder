// 「タブを片づける」 on the main screen (tests/skill-layout-ui.tsx; files-and-editor.md "Tidying the
// tabs"): tidy keeps pinned tabs and saves edits first, 「片づけたタブ」 lists and reopens them, the
// daily tidy runs once per company day (and not when switched off), and the AI's tab commands.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Layout = { calls: Array<{ name: string; args: unknown[] }>; aiCommand(id: string, args?: unknown, companyId?: string): Promise<unknown> }
const layout = (page: Page) => page.evaluateHandle(() => (window as unknown as { __acbLayout: Layout }).__acbLayout)

const ROOT = '/Users/demo/会社'
const README = `${ROOT}/README.md`
const GUIDE = `${ROOT}/営業部/営業の進め方.md`
const SUPPLIES = `${ROOT}/総務/備品.md`
const editorState = (openFiles: string[], pinned: string[] = []) =>
  JSON.stringify({ openFiles, activeFilePath: openFiles[0] ?? null, leftTab: 'files', pinned })
const tab = (page: Page, path: string) => page.getByTitle(path, { exact: true })
const tabsMenu = (page: Page) => page.getByRole('button', { name: 'タブの操作' })
const tidy = async (page: Page) => { await tabsMenu(page).click(); await page.getByRole('menuitem', { name: /タブを片づける/ }).click() }
const list = (page: Page) => page.getByRole('dialog', { name: '片づけたタブ' })

test('tidy keeps the pinned tab, lists the others by day, and 全部開き直す brings them back', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'editor:demo': editorState([README, GUIDE, SUPPLIES], [README]) }) })
  await expect(tab(page, GUIDE)).toBeVisible()
  await expect(page.locator('[data-pinned]')).toHaveCount(1)

  await tabsMenu(page).click()
  await page.screenshot({ path: 'test-results/tidy-tabs-menu.png' })
  await page.getByRole('menuitem', { name: /タブを片づける/ }).click()
  await expect(tab(page, GUIDE)).toHaveCount(0)
  await expect(tab(page, SUPPLIES)).toHaveCount(0)
  await expect(tab(page, README)).toBeVisible()
  await expect(page.locator('[data-tidy-notice]')).toContainText('タブを 2 件片づけました。固定した 1 件は残しました。')
  await page.screenshot({ path: 'test-results/tidy-tabs-after-tidy.png' })

  await page.getByRole('button', { name: '片づけたタブを見る' }).click()
  await expect(list(page).locator('[data-tidied-item]')).toHaveCount(2)
  await expect(list(page).locator('[data-tidied-item="営業の進め方.md"]')).toBeVisible()
  await page.screenshot({ path: 'test-results/tidy-tabs-list.png' })

  await list(page).getByRole('button', { name: '全部開き直す' }).click()
  await expect(tab(page, GUIDE)).toBeVisible()
  await expect(tab(page, SUPPLIES)).toBeVisible()
  // Reopened ones leave the list.
  await expect(list(page).getByText('片づけたタブはまだありません。', { exact: false })).toBeVisible()
  expectNoPageErrors(state)
})

test('one item reopens alone; a file gone from the disk is greyed 「見つかりません」 and can still be removed', async ({ page }) => {
  const groups = [{ id: 'g1', at: '2026-11-03T09:00:00Z', day: '2026-11-03', auto: false, items: [
    { id: 'a', kind: 'file', path: '総務/備品.md', title: '備品.md' },
    { id: 'b', kind: 'file', path: '営業部/消えた.md', title: '消えた.md' },
  ] }]
  await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'editor:demo': editorState([README]), 'tidiedTabs:demo': JSON.stringify(groups) }) })
  await tabsMenu(page).click()
  await page.getByRole('menuitem', { name: /^片づけたタブ/ }).click()
  const gone = list(page).locator('[data-tidied-item="消えた.md"]')
  await expect(gone).toHaveAttribute('data-missing', 'true')
  await expect(gone).toContainText('見つかりません')
  await page.screenshot({ path: 'test-results/tidy-tabs-missing.png' })

  await list(page).getByRole('button', { name: '備品.md を開く' }).click()
  await expect(tab(page, SUPPLIES)).toBeVisible()
  await expect(list(page).locator('[data-tidied-item="備品.md"]')).toHaveCount(0)
  await gone.getByRole('button', { name: '消えた.md を一覧から消す' }).click()
  await expect(list(page).locator('[data-tidied-item]')).toHaveCount(0)
})

test('tidy saves an unsaved edit before it closes the tab', async ({ page }) => {
  // The source view (`mdViewMode`), so the file can be typed in.
  await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'editor:demo': editorState([SUPPLIES]), mdViewMode: 'editor' }) })
  await page.locator('.cm-content').click()
  // Tidied before autosave's second passes.
  await page.keyboard.type('追記')
  await tidy(page)
  await expect(tab(page, SUPPLIES)).toHaveCount(0)
  const writes = await (await layout(page)).evaluate(l => l.calls.filter(c => c.name === 'writeFile').map(c => c.args))
  expect(writes.some(([path, content]) => path === SUPPLIES && String(content).includes('追記'))).toBe(true)
})

test('the daily tidy runs on the first open of a new day only, says so once, and not when switched off', async ({ page }) => {
  await openPreview(page, 'skill-layout', { seed: JSON.stringify({
    'editor:demo': editorState([README, GUIDE], [README]), 'tidiedTabs:lastDay:demo': '2026-01-05',
  }) })
  await expect(tab(page, GUIDE)).toHaveCount(0)
  await expect(tab(page, README)).toBeVisible()
  await expect(page.locator('[data-tidy-notice]')).toHaveText(/毎日、前の日のタブを自動で片づけます（設定でオフにできます）/)
  await page.screenshot({ path: 'test-results/tidy-tabs-daily-notice.png' })

  // Opened again the same day: what is open stays.
  await page.getByRole('button', { name: '片づけたタブを見る' }).click()
  await list(page).getByRole('button', { name: '全部開き直す' }).click()
  await expect(tab(page, GUIDE)).toBeVisible()
  await openPreview(page, 'skill-layout', { keep: '1' })
  await expect(tab(page, GUIDE)).toBeVisible()
  await expect(page.locator('[data-tidy-notice]')).toHaveCount(0)

  // Switched off: an earlier day's tabs stay open.
  await openPreview(page, 'skill-layout', { seed: JSON.stringify({
    'editor:demo': editorState([GUIDE]), 'tidiedTabs:lastDay:demo': '2026-01-05', 'acb.tabs.dailyTidy': 'off',
  }) })
  await expect(tab(page, GUIDE)).toBeVisible()
})

test('the consultation AI lists, tidies and restores this window\'s tabs by title and kind only', async ({ page }) => {
  await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'editor:demo': editorState([GUIDE, SUPPLIES], [SUPPLIES]) }) })
  await expect(tab(page, GUIDE)).toBeVisible()
  const ai = await layout(page)
  const listed = await ai.evaluate(l => l.aiCommand('tabs.list')) as { ok: true; result: { openTabs: Array<Record<string, unknown>> } }
  // Company paths go to main only, which removes them (and private names) before the AI reads them.
  expect(listed.result.openTabs).toEqual([{ title: '営業の進め方.md', kind: 'ファイル', path: '営業部/営業の進め方.md', kindId: 'file' }, { title: '備品.md', kind: 'ファイル', path: '総務/備品.md', kindId: 'file', pinned: true }])
  expect(JSON.stringify(listed)).not.toContain(ROOT)
  // A consultation of another company is refused: these tabs stay as they are.
  const other = await ai.evaluate(l => l.aiCommand('tabs.tidy', {}, 'other')) as { ok: boolean; error: string }
  expect(other.ok).toBe(false)
  await expect(tab(page, GUIDE)).toBeVisible()

  const tidied = await ai.evaluate(l => l.aiCommand('tabs.tidy')) as { ok: true; result: { tidied: number; group: string } }
  expect(tidied.result.tidied).toBe(1)
  await expect(tab(page, GUIDE)).toHaveCount(0)

  const restored = await ai.evaluate((l, group) => l.aiCommand('tabs.restore', { group }), tidied.result.group) as { ok: true; result: { opened: Array<{ title: string }> } }
  expect(restored.result.opened.map((o: { title: string }) => o.title)).toEqual(['営業の進め方.md'])
  await expect(tab(page, GUIDE)).toBeVisible()
  // A command not handed to the AI is refused in the window too.
  const refused = await ai.evaluate(l => l.aiCommand('chat.newConsultation', { message: 'x' })) as { ok: boolean }
  expect(refused.ok).toBe(false)
})
