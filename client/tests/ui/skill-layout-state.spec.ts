// What the main screen remembers and restores (tests/skill-layout-ui.tsx):
// open file tabs and the left tab per company, the chosen department, and the
// panel dividers (their widths saved per company, fitted to the window; layoutTree.ts). These pin the behaviour the AppShell (formerly SkillCentricLayout) split
// (Phase 4) moves into hooks and the split-tree layout. `keep: '1'` reloads
// the page without clearing storage — an app restart; `seed` writes what an
// earlier version of the app saved, so old saved state keeps restoring.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Layout = { calls: Array<{ name: string; args: unknown[] }>; editorWasEmpty(): boolean; switchCompany(id: string): Promise<void>; macNotificationClicked(): void }
const layout = (page: Page) => page.evaluateHandle(() => (window as unknown as { __acbLayout: Layout }).__acbLayout)
const editorWasEmpty = async (page: Page) => (await layout(page)).evaluate(l => l.editorWasEmpty())
const switchCompany = async (page: Page, id: string) => (await layout(page)).evaluate((l, to) => l.switchCompany(to), id)
const searchBox = (page: Page) => page.getByPlaceholder('覚えている言葉で探す')

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
const leftTab = (page: Page, name: 'Skill' | 'ファイル' | '探す') => page.getByRole('button', { name, exact: true })
// Shown only on the 全社 tab while some department is not downloaded (開発部 here).
// In members' words (owner 2026-11-23): never 「ファイルツリー」 or 「AIチャット」.
const companyWideBanner = (page: Page) => page.getByText('ダウンロードしていない部署があります。ファイルの一覧と AI への相談で扱えるのは、ダウンロードした部署だけです。', { exact: true })

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
    await leftTab(page, '探す').click()
    await expect(searchBox(page)).toBeVisible()
    await restart(page)
    await expect(searchBox(page)).toBeVisible()
  })

  test('a saved left tab this version does not know opens Skill, and the rest of the saved state still restores', async ({ page }) => {
    await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'editor:demo': editorState([GUIDE], GUIDE, 'tasks') }) })
    await expect(page.getByRole('heading', { name: 'weekly-report' })).toBeVisible()
    await expect(searchBox(page), 'no other tab was opened').toHaveCount(0)
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
  await leftTab(page, '探す').click()
  await expect.poll(savedTab).toBe('search')
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
  const showLeft = (page: Page) => page.getByRole('button', { name: '左の欄を出す (⌘B)' })
  const leftToggle = (page: Page) => page.getByRole('group', { name: '画面の形' }).getByRole('button', { name: '左の欄 (⌘B)' })
  // The screen starts at x = 0, so a divider's x is the width of what is left of it.
  const at = async (divider: Locator) => Math.round((await divider.boundingBox())!.x)
  /** The middle: from the tree divider's right edge to the chat divider. */
  const middle = async (page: Page) => (await at(chatDivider(page))) - (await at(treeDivider(page))) - 4
  async function drag(page: Page, divider: Locator, dx: number, { release = true } = {}) {
    const box = (await divider.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx / 2, y, { steps: 3 })
    await page.mouse.move(x + dx, y, { steps: 3 })
    if (release) await page.mouse.up()
  }
  // ⌘⇧C and ⌘B as the browser reports them on macOS (key with meta).
  const shortcut = (page: Page, key: string, shiftKey: boolean) => page.evaluate(({ key, shiftKey }) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, shiftKey, bubbles: true }))
  }, { key, shiftKey })
  const toggleChatShortcut = (page: Page) => shortcut(page, 'c', true)
  const toggleLeftShortcut = (page: Page) => shortcut(page, 'b', false)
  const savedLayout = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('layout:demo') ?? 'null') as unknown)

  test('first start looks as before: the chat after 860 px, the narrow column 260 px', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    expect(await at(chatDivider(page))).toBe(860)
    expect(await at(treeDivider(page))).toBe(260)
  })

  test('widening the window grows the middle; the chat and the left column keep their widths', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    const before = await middle(page)
    await page.setViewportSize({ width: 1600, height: 800 })
    await expect.poll(() => at(chatDivider(page))).toBe(1180)
    expect(await at(treeDivider(page))).toBe(260)
    expect(await middle(page)).toBe(before + 320)
  })

  test('the narrow column follows the pointer from 200 px; it stops where the middle keeps 360 px, and at half the window', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, treeDivider(page), 100)
    await expect.poll(() => at(treeDivider(page))).toBe(360)
    await drag(page, treeDivider(page), 500)
    await expect.poll(() => middle(page)).toBe(360)
    await drag(page, treeDivider(page), -800)
    await expect.poll(() => at(treeDivider(page))).toBe(200)
    // With the chat hidden, half the 1280 px window.
    await toggleChatShortcut(page)
    await drag(page, treeDivider(page), 900)
    await expect.poll(() => at(treeDivider(page))).toBe(640)
  })

  test('the chat follows the pointer from 280 px to where the middle keeps 360 px; 60 px under its minimum hides it, and it comes back at 280', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, chatDivider(page), -150)
    await expect.poll(() => at(chatDivider(page))).toBe(710)
    await drag(page, chatDivider(page), -600)
    await expect.poll(() => middle(page)).toBe(360)
    // 1280 px window: the chat keeps 280 px, so its divider stops at 996 (50 px further still shows it).
    await drag(page, chatDivider(page), (996 - (await at(chatDivider(page)))) + 50)
    await expect.poll(() => at(chatDivider(page))).toBe(996)
    await expect(showChat(page)).toHaveCount(0)

    await drag(page, chatDivider(page), 80)
    await expect(showChat(page)).toBeVisible()
    await expect(chatDivider(page)).toHaveCount(0)
    await showChat(page).click()
    await expect.poll(() => at(chatDivider(page))).toBe(996)
  })

  test('while dragging, the size shows beside the pointer', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, treeDivider(page), 80, { release: false })
    await expect(page.locator('[data-size-tip]')).toHaveText('340px（画面の 27%）')
    await page.mouse.up()
    await expect(page.locator('[data-size-tip]')).toHaveCount(0)
  })

  test('a double-click puts that divider back where it started, and only that one', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, treeDivider(page), 100)
    await drag(page, chatDivider(page), -100)
    await expect.poll(() => at(treeDivider(page))).toBe(360)
    await expect.poll(() => at(chatDivider(page))).toBe(760)
    await treeDivider(page).dblclick()
    await expect.poll(() => at(treeDivider(page))).toBe(260)
    expect(await at(chatDivider(page))).toBe(760)
    await chatDivider(page).dblclick()
    await expect.poll(() => at(chatDivider(page))).toBe(860)
    // And the reset is what comes back at the next start.
    await restart(page)
    await leftTab(page, 'ファイル').click()
    await expect.poll(() => at(chatDivider(page))).toBe(860)
    expect(await at(treeDivider(page))).toBe(260)
  })

  test('the dividers move by keys: arrows by 16 px (Shift 64), Home and End as far as they go', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    const tree = treeDivider(page)
    await tree.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(() => at(tree)).toBe(340)
    await expect(tree).toHaveAttribute('aria-valuenow', '340')
    await expect(tree).toHaveAttribute('aria-valuemin', '200')
    await page.keyboard.press('Home')
    await expect.poll(() => at(tree)).toBe(200)
    await page.keyboard.press('End')
    await expect.poll(() => middle(page)).toBe(360)
    // The chat's divider: left grows the chat (with room for it in the middle).
    await page.keyboard.press('Home')
    const chat = chatDivider(page)
    await chat.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => at(chat)).toBe(844)
  })

  test('⌘B hides the left column and brings it back at its width; the strip and the title bar button do the same', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, treeDivider(page), 40)
    await expect.poll(() => at(treeDivider(page))).toBe(300)
    await expect(leftToggle(page)).toHaveAttribute('aria-pressed', 'true')

    await toggleLeftShortcut(page)
    await expect(treeDivider(page)).toHaveCount(0)
    await expect(showLeft(page)).toBeVisible()
    await expect(leftToggle(page)).toHaveAttribute('aria-pressed', 'false')
    // The chat keeps its place; the middle starts after the 24 px strip at the window's left edge.
    expect(await at(chatDivider(page))).toBe(860)
    const strip = (await showLeft(page).boundingBox())!
    expect([Math.round(strip.x), Math.round(strip.width)]).toEqual([0, 24])

    await toggleLeftShortcut(page)
    await expect.poll(() => at(treeDivider(page))).toBe(300)
    await leftToggle(page).click()
    await expect(showLeft(page)).toBeVisible()
    await showLeft(page).click()
    await expect.poll(() => at(treeDivider(page))).toBe(300)

    // A left tab asked for while the column is hidden (探す ⌘⇧F) brings it back.
    await toggleLeftShortcut(page)
    await expect(showLeft(page)).toBeVisible()
    await shortcut(page, 'f', true)
    await expect(searchBox(page)).toBeVisible()
    await expect(showLeft(page)).toHaveCount(0)
  })

  test('on a Mac, Ctrl+B in a text field stays the field\'s own key; ⌘B there hides the left column', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
    await openPreview(page, 'skill-layout')
    await leftTab(page, '探す').click()
    await searchBox(page).focus()
    const press = (mods: { ctrlKey?: boolean; metaKey?: boolean }) => searchBox(page).evaluate((input, m) => {
      const event = new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true, ...m })
      input.dispatchEvent(event)
      return event.defaultPrevented
    }, mods)
    expect(await press({ ctrlKey: true }), 'Ctrl+B reaches the field untouched').toBe(false)
    await expect(showLeft(page)).toHaveCount(0)
    expect(await press({ metaKey: true })).toBe(true)
    await expect(showLeft(page)).toBeVisible()
  })

  test('asking for the tab already chosen (⌘⇧F on 探す) shows the hidden left column', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, '探す').click()
    await toggleLeftShortcut(page)
    await expect(showLeft(page)).toBeVisible()
    await shortcut(page, 'f', true)
    await expect(showLeft(page)).toHaveCount(0)
    await expect(searchBox(page)).toBeVisible()
  })

  test('with Skill chosen and the left column hidden, the middle shows and keeps 360 px beside the strip', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'Skill').click()
    await toggleLeftShortcut(page)
    await expect(showLeft(page)).toBeVisible()
    await drag(page, chatDivider(page), -900)
    // 24 px strip + 360 px middle.
    await expect.poll(() => at(chatDivider(page))).toBe(384)
  })

  test('dragging one divider never moves the other: a chat drawn smaller than saved stays as drawn', async ({ page }) => {
    const big = JSON.stringify({ version: 2, trees: {
      screen: { type: 'split', id: 'screen', direction: 'row', children: [{ type: 'pane', id: 'side' }, { type: 'pane', id: 'chat' }], sizes: [null, 900] },
      files: { type: 'split', id: 'files', direction: 'row', children: [{ type: 'pane', id: 'fileTree' }, { type: 'pane', id: 'editor' }], sizes: [700, null] },
    } })
    await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'layout:demo': big }) })
    await leftTab(page, 'ファイル').click()
    expect(await at(chatDivider(page))).toBe(996)
    await drag(page, treeDivider(page), -40)
    await expect.poll(() => at(treeDivider(page))).toBe(592)
    expect(await at(chatDivider(page))).toBe(996)
  })

  test('「いつもの形に戻す」 puts every size back and shows every pane', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, treeDivider(page), 100)
    await drag(page, chatDivider(page), -100)
    await toggleLeftShortcut(page)
    await toggleChatShortcut(page)
    await expect(showChat(page)).toBeVisible()
    await page.getByRole('button', { name: 'いつもの形に戻す' }).click()
    await expect.poll(() => at(chatDivider(page))).toBe(860)
    expect(await at(treeDivider(page))).toBe(260)
    await expect(showLeft(page)).toHaveCount(0)
  })

  test('widths come back per company at the next start; a company with nothing saved opens at the first look', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await drag(page, treeDivider(page), 100)
    await drag(page, chatDivider(page), -100)
    await expect.poll(() => at(chatDivider(page))).toBe(760)
    await expect.poll(() => at(treeDivider(page))).toBe(360)
    expect(await savedLayout(page)).toMatchObject({ version: 2, trees: { screen: { sizes: [null, 516] }, files: { sizes: [360, null] } } })

    await restart(page)
    await expect.poll(() => at(chatDivider(page))).toBe(760)
    await expect.poll(() => at(treeDivider(page))).toBe(360)

    await switchCompany(page, 'other')
    await leftTab(page, 'ファイル').click()
    await expect.poll(() => at(chatDivider(page))).toBe(860)
    await expect.poll(() => at(treeDivider(page))).toBe(260)

    await switchCompany(page, 'demo')
    await expect.poll(() => at(chatDivider(page))).toBe(760)
    await expect.poll(() => at(treeDivider(page))).toBe(360)
  })

  test('what an earlier version saved (the side fixed, version 1) opens with the dividers where they were', async ({ page }) => {
    const v1 = JSON.stringify({ version: 1, trees: {
      screen: { type: 'split', id: 'screen', direction: 'row', children: [{ type: 'pane', id: 'side' }, { type: 'pane', id: 'chat' }], sizes: [740, null] },
      files: { type: 'split', id: 'files', direction: 'row', children: [{ type: 'pane', id: 'fileTree' }, { type: 'pane', id: 'editor' }], sizes: [300, null] },
    } })
    await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'layout:demo': v1 }) })
    await leftTab(page, 'ファイル').click()
    await expect.poll(() => at(chatDivider(page))).toBe(740)
    expect(await at(treeDivider(page))).toBe(300)
    // Nothing is rewritten until the member changes something.
    expect(await savedLayout(page)).toMatchObject({ version: 1 })
  })

  test('at 1280 px nothing becomes unusable, and a smaller window takes the room from the chat first, then the left column', async ({ page }) => {
    const big = JSON.stringify({ version: 2, trees: {
      screen: { type: 'split', id: 'screen', direction: 'row', children: [{ type: 'pane', id: 'side' }, { type: 'pane', id: 'chat' }], sizes: [null, 900] },
      files: { type: 'split', id: 'files', direction: 'row', children: [{ type: 'pane', id: 'fileTree' }, { type: 'pane', id: 'editor' }], sizes: [700, null] },
    } })
    await openPreview(page, 'skill-layout', { seed: JSON.stringify({ 'layout:demo': big }) })
    await leftTab(page, 'ファイル').click()
    // 1280: the left column at most half (640); the chat gives way to 280 px and the left column to keep the middle at 360.
    expect(1280 - (await at(chatDivider(page))) - 4).toBe(280)
    expect(await middle(page)).toBe(360)
    expect(await at(treeDivider(page))).toBe(1280 - 280 - 4 - 360 - 4)
    // A wider window shows what was saved again (it was never overwritten).
    await page.setViewportSize({ width: 2400, height: 800 })
    await expect.poll(async () => 2400 - (await at(chatDivider(page))) - 4).toBe(900)
    expect(await at(treeDivider(page))).toBe(700)
  })

  // With the chat hidden the left side takes the rest of the window. Wide content (a long
  // source line, many tabs) must scroll inside the editor, not stretch the side past the window:
  // the document then sat in a sliver at the right edge and the button to show the chat was gone.
  const SALES = `${ROOT}/営業部/売上表.md`
  for (const [what, view, openFiles, shown] of [
    ['a Markdown file with lines wider than the editor (source view)', 'editor', [GUIDE, SALES], (page: Page) => page.locator('.cm-editor')],
    ['many open tabs (preview)', 'preview',
      [GUIDE, SALES, SUPPLIES, `${ROOT}/README.md`, `${ROOT}/総務/規程/就業規則.md`, `${ROOT}/営業部/提案書/A社_提案.md`, `${ROOT}/営業部/提案書/B社_提案.md`],
      (page: Page) => page.getByRole('heading', { name: '売上表', level: 1 })],
  ] as const) {
    test(`⌘⇧C with ${what}: the editor fills the room up to the window's right edge`, async ({ page }) => {
      await openPreview(page, 'skill-layout', { seed: JSON.stringify({
        'editor:demo': editorState([...openFiles], SALES, 'files'),
        mdViewMode: view,
      }) })
      await expect(shown(page)).toBeVisible()
      const fitsWindow = async () => {
        const width = page.viewportSize()!.width
        const tree = (await treeDivider(page).boundingBox())!
        const button = (await showChat(page).boundingBox())!
        const box = (await shown(page).boundingBox())!
        const side = (await page.locator('[data-file-side]').boundingBox())!
        const left = tree.x + tree.width
        // The show-chat button sits at the window's right edge; the file's side column (つながり・前の版)
        // just before it, and the editor between that and the tree.
        expect(Math.round(button.x + button.width)).toBe(width)
        expect(side.x + side.width).toBeLessThanOrEqual(button.x + 1)
        const right = side.x
        if (view === 'editor') {
          expect(box.x).toBeGreaterThanOrEqual(left - 1)
          expect(box.x + box.width).toBeLessThanOrEqual(right + 1)
          expect(box.width).toBeGreaterThan(right - left - 2)
        } else {
          // The preview centres the document (at most 768 px) in the editor.
          expect(box.x).toBeGreaterThanOrEqual(left)
          expect(box.x + box.width).toBeLessThanOrEqual(right)
          expect(Math.abs(box.x + box.width / 2 - (left + right) / 2)).toBeLessThan(20)
        }
      }

      await toggleChatShortcut(page)
      await expect(showChat(page)).toBeVisible()
      await fitsWindow()
      await page.setViewportSize({ width: 1000, height: 800 })
      await fitsWindow()

      await toggleChatShortcut(page)
      await expect(showChat(page)).toHaveCount(0)
      // In the smaller window the chat gives way so the middle keeps 360 px; the narrow column keeps its width.
      expect(await at(treeDivider(page))).toBe(260)
      expect(await middle(page)).toBe(360)
    })
  }
})

// The bottom panel (B2): a frame under the middle for what a feature hands in (the inbox, I1).
// `bottom: '1'` gives the preview something to show; without it the app has no bottom panel at all.
test.describe('the bottom panel', () => {
  const panel = (page: Page) => page.getByRole('region', { name: '受け箱' })
  const divider = (page: Page) => page.getByRole('separator', { name: 'エディタと下のパネルの境目' })
  const treeDivider = (page: Page) => page.getByRole('separator', { name: 'ファイルツリーとエディタの境目' })
  const chatDivider = (page: Page) => page.getByRole('separator', { name: '左の欄とチャットの境目' })
  // The title bar's one button for the panel is ［受け箱］ (I2; the 「画面の形」 one was removed as a duplicate).
  const toggle = (page: Page) => page.locator('[data-inbox-button]')
  const open = (page: Page, query: Record<string, string> = {}) => openPreview(page, 'skill-layout', { bottom: '1', ...query })
  /** ⌘J (or Ctrl+J) as the browser reports it, at the focused element; whether the app took the key. */
  const pressJ = (page: Page, mods: { metaKey?: boolean; ctrlKey?: boolean } = { metaKey: true }) => page.evaluate(m => {
    const event = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true, ...m })
    ;(document.activeElement ?? document.body).dispatchEvent(event)
    return event.defaultPrevented
  }, mods)
  const box = async (locator: Locator) => (await locator.boundingBox())!
  const height = async (page: Page) => Math.round((await box(panel(page))).height)

  test('with nothing to show there is no panel, no button, and ⌘J is left alone', async ({ page }) => {
    await openPreview(page, 'skill-layout')
    await leftTab(page, 'ファイル').click()
    await expect(page.getByRole('group', { name: '画面の形' }).getByRole('button', { name: '左の欄 (⌘B)' })).toBeVisible()
    expect(await pressJ(page)).toBe(false)
    await expect(panel(page)).toHaveCount(0)
    await expect(toggle(page)).toHaveCount(0)
    await expect(divider(page)).toHaveCount(0)
  })

  test('⌘J opens it under the middle only and closes it; 閉じる does the same; every start begins closed', async ({ page }) => {
    await open(page)
    await leftTab(page, 'ファイル').click()
    await expect(panel(page)).toBeHidden()
    await expect(page.getByRole('group', { name: '画面の形' }).getByRole('button', { name: /下のパネル/ })).toHaveCount(0)

    expect(await pressJ(page)).toBe(true)
    await expect(panel(page)).toBeVisible()
    await expect(page.getByText('見本の中身です。')).toBeVisible()
    // Under the middle only: from the tree divider to the chat divider, down to the window's bottom.
    const p = await box(panel(page))
    expect(Math.round(p.x)).toBe(Math.round((await box(treeDivider(page))).x) + 4)
    // (the left side's 1 px border stands between it and the chat divider)
    expect(Math.round(p.x + p.width)).toBe(Math.round((await box(chatDivider(page))).x) - 1)
    expect(Math.round(p.y + p.height)).toBe(page.viewportSize()!.height)
    expect(Math.round(p.height)).toBe(260)

    await pressJ(page)
    await expect(panel(page)).toBeHidden()
    await pressJ(page)
    await expect(panel(page)).toBeVisible()
    await page.getByRole('button', { name: '下のパネルを閉じる (⌘J)' }).click()
    await expect(panel(page)).toBeHidden()

    // Left open, the next start still begins closed.
    await pressJ(page)
    await expect(panel(page)).toBeVisible()
    await open(page, { keep: '1' })
    await leftTab(page, 'ファイル').click()
    await expect(panel(page)).toBeHidden()
  })

  test('on a Mac, Ctrl+J in a text field stays the field\'s own key', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }))
    await open(page)
    await leftTab(page, '探す').click()
    await searchBox(page).focus()
    expect(await pressJ(page, { ctrlKey: true }), 'Ctrl+J reaches the field untouched').toBe(false)
    await expect(panel(page)).toBeHidden()
    expect(await pressJ(page)).toBe(true)
    await expect(panel(page)).toBeVisible()
  })

  test('its divider: drag with the size shown, keys, double-click; the height comes back; the tabs keep 160 px', async ({ page }) => {
    await open(page)
    await leftTab(page, 'ファイル').click()
    await pressJ(page)
    const d = await box(divider(page))
    const x = d.x + d.width / 2
    const y = d.y + d.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y - 50, { steps: 3 })
    await page.mouse.move(x, y - 100, { steps: 3 })
    const windowHeight = page.viewportSize()!.height
    await expect(page.locator('[data-size-tip]')).toHaveText(`360px（画面の高さの ${Math.round((360 / windowHeight) * 100)}%）`)
    await page.mouse.up()
    await expect.poll(() => height(page)).toBe(360)

    // The height is kept for the next start (the panel itself starts closed).
    await open(page, { keep: '1' })
    await leftTab(page, 'ファイル').click()
    await pressJ(page)
    await expect.poll(() => height(page)).toBe(360)

    // Keys move the divider as they do the others (up, Home = towards the top): up grows the panel by
    // 16, End takes it down to its 120 px minimum, Home up to where the tabs keep 160 px.
    await divider(page).focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => height(page)).toBe(376)
    await expect(divider(page)).toHaveAttribute('aria-valuemin', '120')
    await page.keyboard.press('End')
    await expect.poll(() => height(page)).toBe(120)
    await page.keyboard.press('Home')
    const max = Number(await divider(page).getAttribute('aria-valuemax'))
    await expect.poll(() => height(page)).toBe(max)
    // The middle (the divider's parent) minus the panel and its 4 px divider: what its tabs keep.
    const middleHeight = await divider(page).evaluate(el => Math.round(el.parentElement!.getBoundingClientRect().height))
    expect(middleHeight - max - 4).toBe(160)

    // A double-click puts it back at 260; 「いつもの形に戻す」 closes it and the first height returns.
    await divider(page).dblclick()
    await expect.poll(() => height(page)).toBe(260)
    await divider(page).focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => height(page)).toBe(276)
    await page.getByRole('button', { name: 'いつもの形に戻す' }).click()
    await expect(panel(page)).toBeHidden()
    await pressJ(page)
    await expect.poll(() => height(page)).toBe(260)
  })

  // Owner decision (b), 2026-11-22: a wide left tab (Skill) covers the middle, and the panel then spans the
  // whole left side under it, so the inbox shows from every tab.
  test('under a wide tab it spans the whole left side; switching tabs keeps it open, its height and the tab\'s screen', async ({ page }) => {
    await open(page)
    await leftTab(page, 'Skill').click()
    const skillShown = page.getByText(/proposal|weekly-report/).first()
    await expect(skillShown).toBeVisible()
    expect(await pressJ(page)).toBe(true)
    await expect(panel(page)).toBeVisible()
    const p = await box(panel(page))
    expect(Math.round(p.x)).toBe(0)
    expect(Math.round(p.x + p.width)).toBe(Math.round((await box(chatDivider(page))).x) - 1)
    expect(Math.round(p.y + p.height)).toBe(page.viewportSize()!.height)
    expect(Math.round(p.height)).toBe(260)
    // The skill's screen is still there, above the panel.
    await expect(skillShown).toBeVisible()

    // Its divider works the same here, and the height is the one the middle's panel has.
    await divider(page).focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => height(page)).toBe(276)
    await leftTab(page, 'ファイル').click()
    await expect(panel(page)).toBeVisible()
    expect(Math.round((await box(panel(page))).x)).toBe(Math.round((await box(treeDivider(page))).x) + 4)
    await expect.poll(() => height(page)).toBe(276)
    await expect(divider(page)).toHaveCount(1)
    await leftTab(page, 'Skill').click()
    await expect(panel(page)).toBeVisible()
    await expect.poll(() => height(page)).toBe(276)
    await pressJ(page)
    await expect(panel(page)).toBeHidden()
  })

  test('a department not downloaded on this computer: its prompt covers the side, and the panel still opens under it', async ({ page }) => {
    await open(page)
    await leftTab(page, 'ファイル').click()
    await page.getByRole('button', { name: '開発部' }).first().click()
    await expect(page.getByRole('button', { name: 'ダウンロードして同期を開始' })).toBeVisible()
    expect(await pressJ(page)).toBe(true)
    await expect(panel(page)).toBeVisible()
    const p = await box(panel(page))
    expect(Math.round(p.x)).toBe(0)
    expect(Math.round(p.y + p.height)).toBe(page.viewportSize()!.height)
    await expect(page.getByText('見本の中身です。')).toBeVisible()
    await page.getByRole('button', { name: '下のパネルを閉じる (⌘J)' }).click()
    await expect(panel(page)).toBeHidden()
  })

  test('opening a row from a department not downloaded here shows what was opened (全社), not the prompt', async ({ page }) => {
    await openPreview(page, 'skill-layout', { inbox: '1' })
    await leftTab(page, 'ファイル').click()
    await page.getByRole('button', { name: '開発部' }).first().click()
    const prompt = page.getByRole('button', { name: 'ダウンロードして同期を開始' })
    await expect(prompt).toBeVisible()
    await pressJ(page)
    await panel(page).locator('[data-inbox-row="record:task-done0001"]').getByRole('button', { name: '開く' }).click()
    await expect(prompt).toBeHidden()
    await expect(panel(page)).toBeVisible()
  })

  test('the real inbox (I1): ⌘J shows it with an approval that only opens its card', async ({ page }) => {
    await openPreview(page, 'skill-layout', { inbox: '1' })
    await expect(toggle(page)).toBeVisible()
    await pressJ(page)
    await expect(panel(page)).toBeVisible()
    const row = panel(page).locator('[data-inbox-row="record:approval-0000aa"]')
    await expect(row).toContainText('承認を待っています')
    await row.getByRole('button', { name: '承認する…' }).click()
    await expect(page.getByRole('dialog', { name: '承認のお願い' })).toBeVisible()
    const calls = await (await layout(page)).evaluate(l => l.calls.map(c => c.name))
    expect(calls.filter(name => /approve|send/i.test(name))).toEqual([])
    // 「ブラウザ操作」 switched off on this PC: the inbox may ask main for the plans (the switch is per PC, main
    // decides) and main answers empty without asking the server (the preview's fake answers likewise), so no
    // plan row (and nothing above approved or sent).
    await expect(panel(page).locator('[data-inbox-row^="browser:"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    // Opening a done row marks it seen (the bell's same read state).
    await panel(page).locator('[data-inbox-row="record:task-done0001"]').getByRole('button', { name: '開く' }).click()
    await expect.poll(async () => (await layout(page)).evaluate(l => l.calls.filter(c => c.name === 'markNotificationsRead').length)).toBe(1)
  })

  test('the title bar\'s ［受け箱］ (I2) opens and closes the same panel as ⌘J; ⌘K 「受け箱」 and the morning\'s Mac notification open it', async ({ page }) => {
    await openPreview(page, 'skill-layout', { inbox: '1' })
    const inboxButton = page.locator('[data-inbox-button]')
    // One approval waits; the unread done notice is new. No 「あなたの番」 pill and no bell any more.
    await expect(inboxButton).toHaveAccessibleName('受け箱：新着 1 件・あなた待ち 1 件 (⌘J)')
    await expect(page.getByRole('button', { name: /^起きたこと/ })).toHaveCount(0)
    await inboxButton.click()
    await expect(panel(page)).toBeVisible()
    await expect(inboxButton).toHaveAttribute('aria-pressed', 'true')
    await inboxButton.click()
    await expect(panel(page)).toBeHidden()

    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('受け箱')
    await page.getByRole('option', { name: /受け箱/ }).first().click()
    await expect(panel(page)).toBeVisible()
    await pressJ(page)
    await expect(panel(page)).toBeHidden()

    await (await layout(page)).evaluate(l => l.macNotificationClicked())
    await expect(panel(page)).toBeVisible()
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`the inbox in the screen, ${theme}`, async ({ page }) => {
      await openPreview(page, 'skill-layout', { inbox: '1', ...(theme === 'dark' ? { theme } : {}) })
      await leftTab(page, 'ファイル').click()
      await pressJ(page)
      await expect(panel(page)).toBeVisible()
      if (process.env.INBOX_SHOTS) await page.screenshot({ path: `${process.env.INBOX_SHOTS}/inbox-screen-${theme}.png`, animations: 'disabled' })
      await leftTab(page, 'Skill').click()
      await expect(panel(page)).toBeVisible()
      if (process.env.INBOX_SHOTS) await page.screenshot({ path: `${process.env.INBOX_SHOTS}/inbox-wide-tab-${theme}.png`, animations: 'disabled' })
    })
  }
})
