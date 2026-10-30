// What the main screen remembers and restores (tests/skill-layout-ui.tsx):
// open file tabs and the left tab per company, the chosen department, and the
// panel dividers (their widths saved per company). These pin the behaviour the AppShell (formerly SkillCentricLayout) split
// (Phase 4) moves into hooks and the split-tree layout. `keep: '1'` reloads
// the page without clearing storage — an app restart; `seed` writes what an
// earlier version of the app saved, so old saved state keeps restoring.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Layout = { calls: Array<{ name: string; args: unknown[] }>; editorWasEmpty(): boolean; switchCompany(id: string): Promise<void> }
const layout = (page: Page) => page.evaluateHandle(() => (window as unknown as { __acbLayout: Layout }).__acbLayout)
const editorWasEmpty = async (page: Page) => (await layout(page)).evaluate(l => l.editorWasEmpty())
const switchCompany = async (page: Page, id: string) => (await layout(page)).evaluate((l, to) => l.switchCompany(to), id)
const gitLogCalls = async (page: Page) => (await layout(page)).evaluate(l => l.calls.filter(c => c.name === 'gitLog').length)

const ROOT = '/Users/demo/会社'
const OTHER_ROOT = '/Users/demo/別会社'
const GUIDE = `${ROOT}/営業部/営業の進め方.md`
const SUPPLIES = `${ROOT}/総務/備品.md`
const MINUTES = `${OTHER_ROOT}/議事録.md`

/** What the app saves per company today: `editor:<company id>`. */
const editorState = (openFiles: string[], activeFilePath: string | null, leftTab: string) =>
  JSON.stringify({ openFiles, activeFilePath, leftTab })
const restart = (page: Page) => openPreview(page, 'skill-layout', { keep: '1' })

const editorTab = (page: Page, path: string) => page.getByTitle(path, { exact: true })
const deptTab = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).first()
const leftTab = (page: Page, name: 'スキル' | 'ファイル' | '検索' | '履歴') => page.getByRole('button', { name, exact: true })
// Shown only on the 全社 tab while some department is not downloaded (開発部 here).
const companyWideBanner = (page: Page) => page.getByText('一部の部署がダウンロードされていません。', { exact: false })

test.describe('open files and the left tab', () => {
  test('come back per company from the first frame, with no empty editor in between', async ({ page }) => {
    await openPreview(page, 'skill-layout', { seed: JSON.stringify({
      'editor:demo': editorState([GUIDE, SUPPLIES], GUIDE, 'files'),
      'editor:other': editorState([MINUTES], MINUTES, 'files'),
    }) })
    await expect(editorTab(page, GUIDE)).toBeVisible()
    await expect(editorTab(page, SUPPLIES)).toBeVisible()
    await expect(page.getByText('毎週月曜に共有します。')).toBeVisible()
    await expect(editorTab(page, MINUTES)).toHaveCount(0)
    expect(await editorWasEmpty(page), 'the editor showed 「ファイルを選択してください」 before the restored tabs').toBe(false)

    await switchCompany(page, 'other')
    await expect(editorTab(page, MINUTES)).toBeVisible()
    await expect(page.getByText('別会社の定例。')).toBeVisible()
    await expect(editorTab(page, GUIDE)).toHaveCount(0)
    expect(await editorWasEmpty(page)).toBe(false)

    await switchCompany(page, 'demo')
    await expect(editorTab(page, GUIDE)).toBeVisible()
    await expect(editorTab(page, MINUTES)).toHaveCount(0)
    expect(await editorWasEmpty(page)).toBe(false)
  })

  test('a tab whose file was deleted while the app was closed is dropped; the active tab moves to one that remains', async ({ page }) => {
    const gone = `${ROOT}/営業部/消えた.md`
    await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'editor:demo': editorState([GUIDE, gone], gone, 'files') }) })
    await expect(editorTab(page, gone)).toHaveCount(0)
    await expect(editorTab(page, GUIDE)).toBeVisible()
    await expect(page.getByText('毎週月曜に共有します。')).toBeVisible()
    // And it stays dropped at the next start.
    await restart(page)
    await expect(editorTab(page, GUIDE)).toBeVisible()
    await expect(editorTab(page, gone)).toHaveCount(0)
  })

  test('the left tab chosen is the one shown at the next start', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, '履歴').click()
    await expect(page.getByText('提案書を更新')).toBeVisible()
    await restart(page)
    await expect(page.getByText('提案書を更新')).toBeVisible()
  })

  test('a saved left tab this version does not know opens スキル, and the rest of the saved state still restores', async ({ page }) => {
    await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'editor:demo': editorState([GUIDE], GUIDE, 'tasks') }) })
    await expect(page.getByRole('heading', { name: 'weekly-report' })).toBeVisible()
    expect(await gitLogCalls(page), 'no other tab was opened').toBe(0)
    await leftTab(page, 'ファイル').click()
    await expect(editorTab(page, GUIDE)).toBeVisible()
  })
})

test('a left tab remembered for a panel not registered yet (an extension still loading) is kept until the member picks another tab', async ({ page }) => {
  await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'editor:demo': editorState([GUIDE], GUIDE, 'tasks') }) })
  await expect(page.getByRole('heading', { name: 'weekly-report' })).toBeVisible()
  const savedTab = () => page.evaluate(() => JSON.parse(localStorage.getItem('editor:demo') ?? '{}').leftTab as string)
  // Opening the company and the background check of open files rewrite the entry; the id stays.
  await expect.poll(savedTab).toBe('tasks')
  await restart(page)
  await expect(page.getByRole('heading', { name: 'weekly-report' })).toBeVisible()
  expect(await savedTab()).toBe('tasks')
  await leftTab(page, '履歴').click()
  await expect.poll(savedTab).toBe('history')
})

test.describe('the chosen department', () => {
  test('is selected again at the next start', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await expect(companyWideBanner(page)).toBeVisible()
    await deptTab(page, '営業部').click()
    await expect(page.getByRole('heading', { name: 'proposal' })).toBeVisible()
    await restart(page)
    await expect(page.getByRole('heading', { name: 'proposal' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'weekly-report' })).toHaveCount(0)
    await expect(companyWideBanner(page)).toHaveCount(0)
  })

  test('a saved department that no longer exists falls back to 全社, also at the next start', async ({ page }) => {
    await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'selectedDeptTab:demo': 'd_closed' }) })
    await expect(companyWideBanner(page)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'weekly-report' })).toBeVisible()
    await restart(page)
    await expect(companyWideBanner(page)).toBeVisible()
  })
})

test.describe('panel dividers', () => {
  const treeDivider = (page: Page) => page.getByRole('separator', { name: 'ファイルツリーとエディタの境目' })
  const chatDivider = (page: Page) => page.getByRole('separator', { name: '左の欄とチャットの境目' })
  const showChat = (page: Page) => page.getByRole('button', { name: 'AIチャットを表示 (⌘⇧C)' })
  // The screen starts at x = 0, so a divider's x is the width of what is left of it.
  const at = async (divider: Locator) => Math.round((await divider.boundingBox())!.x)
  async function drag(page: Page, divider: Locator, dx: number) {
    const box = (await divider.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx / 2, y, { steps: 3 })
    await page.mouse.move(x + dx, y, { steps: 3 })
    await page.mouse.up()
  }
  // ⌘⇧C as the browser reports it on macOS (key 'c' with meta and shift).
  const toggleChatShortcut = (page: Page) => page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, shiftKey: true, bubbles: true }))
  })

  test('first start: the left side is 550 px and the file tree 200 px', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    expect(await at(chatDivider(page))).toBe(550)
    expect(await at(treeDivider(page))).toBe(200)
  })

  test('the file tree follows the pointer within 120–400 px', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, treeDivider(page), 100)
    await expect.poll(() => at(treeDivider(page))).toBe(300)
    await drag(page, treeDivider(page), 300)
    await expect.poll(() => at(treeDivider(page))).toBe(400)
    await drag(page, treeDivider(page), -500)
    await expect.poll(() => at(treeDivider(page))).toBe(120)
  })

  test('the left side follows the pointer from 300 px up to the room the chat needs; 60 px past that hides the chat, which comes back at that width', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await drag(page, chatDivider(page), 150)
    await expect.poll(() => at(chatDivider(page))).toBe(700)
    await drag(page, chatDivider(page), -600)
    await expect.poll(() => at(chatDivider(page))).toBe(300)
    // 1280 px window: the chat keeps 280 px (+10), so the left side stops at 990 px.
    await drag(page, chatDivider(page), 740)
    await expect.poll(() => at(chatDivider(page))).toBe(990)
    await expect(showChat(page)).toHaveCount(0)

    await drag(page, chatDivider(page), 80)
    await expect(showChat(page)).toBeVisible()
    await expect(chatDivider(page)).toHaveCount(0)
    await showChat(page).click()
    await expect.poll(() => at(chatDivider(page))).toBe(990)
  })

  test('widths come back per company at the next start; a company with nothing saved opens at the defaults', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, treeDivider(page), 100)
    await drag(page, chatDivider(page), 150)
    await expect.poll(() => at(chatDivider(page))).toBe(700)
    await expect.poll(() => at(treeDivider(page))).toBe(300)

    await restart(page)
    await expect.poll(() => at(chatDivider(page))).toBe(700)
    await expect.poll(() => at(treeDivider(page))).toBe(300)

    await switchCompany(page, 'other')
    await leftTab(page, 'ファイル').click()
    await expect.poll(() => at(chatDivider(page))).toBe(550)
    await expect.poll(() => at(treeDivider(page))).toBe(200)

    await switchCompany(page, 'demo')
    await expect.poll(() => at(chatDivider(page))).toBe(700)
    await expect.poll(() => at(treeDivider(page))).toBe(300)
  })

  for (const [what, saved] of [
    ['unreadable', '{"version":1,"trees":'],
    ['from a version this app does not know', JSON.stringify({ version: 99, trees: { screen: { sizes: [900, null] } } })],
  ] as const) {
    test(`a saved layout ${what} opens with the default widths, and dragging still works`, async ({ page }) => {
      await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'layout:demo': saved }) })
      await leftTab(page, 'ファイル').click()
      expect(await at(chatDivider(page))).toBe(550)
      expect(await at(treeDivider(page))).toBe(200)
      await drag(page, chatDivider(page), 50)
      await expect.poll(() => at(chatDivider(page))).toBe(600)
    })
  }

  test('⌘⇧C hides the chat and brings it back at the width it had', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await drag(page, chatDivider(page), 100)
    await expect.poll(() => at(chatDivider(page))).toBe(650)
    await toggleChatShortcut(page)
    await expect(chatDivider(page)).toHaveCount(0)
    await expect(showChat(page)).toBeVisible()
    await toggleChatShortcut(page)
    await expect(showChat(page)).toHaveCount(0)
    await expect.poll(() => at(chatDivider(page))).toBe(650)
  })
})
