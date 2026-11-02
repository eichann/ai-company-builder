// The main screen (src/app/AppShell.tsx) with the preload API faked
// (tests/skill-layout-ui.tsx). Pure parts are pinned elsewhere — file tree
// planning and per-department caching (fileTreeModel.test.ts), which file
// events rescan skills (skills-refresh.test.ts), write-access evaluation
// (write-access.test.ts), search caps in main (git-search.test.ts). These
// tests pin what the SkillCentricLayout split (R3) can break: what stays
// mounted across department and tab switches, the not-downloaded overlay,
// the read-only marks, and the wiring of search (files and records), a record's card,
// ← →, a file's 「つながっているもの」 / 「前の版」 and skills refresh.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Call = { name: string; args: unknown[] }
type Layout = { calls: Call[]; addSkill(folder: string, name: string): void; emit(changes: Array<{ type: string; path: string }>): void; fileFromChatWindow(path: string): void }
declare global { interface Window { __acbLayout: Layout } }

const ROOT = '/Users/demo/会社'
const calls = (page: Page, name: string) => page.evaluate(n => window.__acbLayout.calls.filter(c => c.name === n).map(c => c.args), name)
const deptTab = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).first()
const leftTab = (page: Page, name: 'スキル' | 'ファイル' | '探す') => page.getByRole('button', { name, exact: true })
const overlay = (page: Page) => page.getByRole('button', { name: 'ダウンロードして同期を開始' })

test('switching departments keeps the file tree mounted with what was expanded or collapsed, without a cold re-read', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, 'ファイル').click()
  const folder = page.getByRole('button', { name: '提案書', exact: true })
  await expect(folder).toBeVisible()
  // First-level folders open on first view (fileTreeModel.test.ts); their files are listed.
  await expect(page.getByRole('button', { name: 'A社_提案.md' })).toBeVisible()
  // The member collapses one of them.
  await page.getByRole('button', { name: '顧客', exact: true }).click()
  await expect(page.getByRole('button', { name: '一覧.csv' })).toHaveCount(0)
  // The tree panel's toolbar: the same element after the switches = the panel was not remounted.
  const toolbarButton = page.getByRole('button', { name: '新しいフォルダ…' })
  await toolbarButton.evaluate(el => { (el as HTMLElement & { __acbMark?: boolean }).__acbMark = true })
  const treeReadsBefore = (await calls(page, 'readDirectoryTree')).length
  const readsBefore = (await calls(page, 'readDirectory')).length

  await deptTab(page, '総務').click()
  await expect(page.getByRole('button', { name: '備品.md' })).toBeVisible()
  await deptTab(page, '営業部').click()
  await expect(page.getByRole('button', { name: 'A社_提案.md' })).toBeVisible()
  // The 営業部 tree came back from the cache: no cold tree read, at most the
  // cheap check of its root (fileTreeModel.test.ts "catches up when shown again").
  const under = (args: unknown[][]) => args.map(a => a[0] as string).filter(dir => dir.startsWith(`${ROOT}/営業部`))
  expect(under((await calls(page, 'readDirectoryTree')).slice(treeReadsBefore))).toEqual([])
  expect(under((await calls(page, 'readDirectory')).slice(readsBefore)).filter(dir => dir !== `${ROOT}/営業部`)).toEqual([])
  expect(await toolbarButton.evaluate(el => (el as HTMLElement & { __acbMark?: boolean }).__acbMark === true),
    'the file tree panel is the same instance (not remounted)').toBe(true)
  // What was expanded / collapsed stays so.
  await expect(page.getByRole('button', { name: 'B社_提案.md' })).toBeVisible()
  await expect(page.getByRole('button', { name: '一覧.csv' })).toHaveCount(0)
})

test('a department not downloaded on this computer shows the download prompt over the still-mounted panel', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, 'ファイル').click()
  await expect(page.getByRole('button', { name: 'A社_提案.md' })).toBeVisible()

  await deptTab(page, '開発部').click()
  await expect(overlay(page)).toBeVisible()
  await expect(page.getByText('この部署のファイルはまだダウンロードされていません。')).toBeVisible()
  // Underneath: hidden from assistive tech, but not unmounted.
  await expect(leftTab(page, 'ファイル')).toHaveCount(0)
  await expect(page.locator('[aria-hidden="true"]').getByRole('button', { name: 'ファイル', exact: true, includeHidden: true })).toHaveCount(1)
  expect(await calls(page, 'listSkills')).not.toContainEqual(['開発部', false])

  await overlay(page).click()
  await expect(overlay(page)).toHaveCount(0)
  expect(await calls(page, 'sparseSetExclusions')).toEqual([[[]]])
  await expect(page.getByRole('button', { name: '設計.md' })).toBeVisible()
})

test('a download that fails offline says why and keeps the prompt', async ({ page }) => {
  await openPreview(page, 'skill-layout', { download: 'offline' })
  await deptTab(page, '開発部').click()
  await overlay(page).click()
  await expect(page.getByRole('alert')).toHaveText('インターネットにつながっているときにダウンロードできます。何も変更していません。')
  await expect(overlay(page)).toBeVisible()
  // Another department and back: the old error is not shown again.
  await deptTab(page, '営業部').click()
  await deptTab(page, '開発部').click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('read-only folders carry 閲覧のみ in the tree and above an open file', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '全社').click()
  await leftTab(page, 'ファイル').click()
  const generalAffairs = page.getByRole('button', { name: /^総務/ }).filter({ hasText: '閲覧のみ' })
  await expect(generalAffairs).toBeVisible()
  await expect(page.getByRole('button', { name: /^営業部/ }).filter({ hasText: '閲覧のみ' })).toHaveCount(0)

  await deptTab(page, '総務').click()
  await page.getByRole('button', { name: '備品.md' }).click()
  await expect(page.getByText('このフォルダは閲覧のみです。変更しても共有されず、同期すると元に戻ります（変更は .backups/ に保存されます）。')).toBeVisible()
})

test('探す: results grouped by file, the cap note when truncated, cleared by a department switch; a hit opens the file in the middle', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, '探す').click()
  const box = page.getByRole('textbox').filter({ visible: true }).first()
  await expect(box).toBeFocused()
  await box.fill('提案')
  await box.press('Enter')
  // Two records and two files hold the words.
  await expect(page.getByText('見つかったもの（4）')).toBeVisible()
  await expect(page.getByText(/結果が多いため/)).toHaveCount(0)
  expect(await calls(page, 'gitGrep')).toEqual([['提案', '営業部']])
  // A file's hit opens that file in a tab in the middle, 探す staying on the left.
  await page.getByRole('button', { name: /A社への提案の骨子/ }).click()
  await expect(page.getByRole('tablist', { name: '開いているもの' }).getByRole('tab', { name: /A社_提案\.md/ })).toHaveAttribute('aria-selected', 'true')
  await expect(box).toBeVisible()

  await box.fill('の')
  await box.press('Enter')
  await expect(page.getByText('結果が多いため最初の500件を表示しています。言葉を増やして絞り込んでください。')).toBeVisible()

  await deptTab(page, '総務').click()
  await expect(page.getByText(/見つかったもの/)).toHaveCount(0)
  await expect(page.getByText(/結果が多いため/)).toHaveCount(0)
})

test('探す finds records next to files with a chip for each kind found; a record opens as a card, its links are followed, ← → go back and forth', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, '探す').click()
  const box = page.getByRole('textbox').filter({ visible: true }).first()
  await box.fill('提案')
  await box.press('Enter')
  const hits = page.getByLabel('見つかった記録')
  const chips = page.getByRole('group', { name: '種類で絞る' })
  // Only kinds with something found get a chip.
  await expect(chips.getByRole('button')).toHaveText(['やること1', '決めたこと1', 'ファイル2'])
  expect(await calls(page, 'searchRecords')).toEqual([['demo', '提案']])
  await chips.getByRole('button', { name: /決めたこと/ }).click()
  await expect(hits.getByRole('button')).toHaveCount(1)
  await expect(page.getByLabel('見つかったファイル')).toHaveCount(0)
  await chips.getByRole('button', { name: /決めたこと/ }).click()
  await expect(hits.getByRole('button')).toHaveCount(2)

  // A record opens as a card in the editor area of the files tab (a task: the task card).
  await hits.getByRole('button', { name: /A社 提案書を仕上げる/ }).click()
  const card = page.getByTestId('task-card')
  await expect(card.getByRole('heading', { name: 'A社 提案書を仕上げる' })).toBeVisible()
  // Fields and 経緯 are folded at the bottom until opened.
  await card.getByRole('button', { name: /ほかの項目/ }).click()
  await card.getByRole('button', { name: /経緯/ }).click()
  await expect(card.getByText('田中 太郎', { exact: true })).toBeVisible()
  await expect(card.getByText('山田 花子：作りました')).toBeVisible()

  // Following the linked file opens it; the file shows what links to it and its earlier versions.
  await card.getByRole('button', { name: /^A社_提案\.md/ }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByText('A社への提案の骨子。')).toBeVisible()
  const side = page.getByLabel('つながっているもの', { exact: true })
  await expect(side.getByRole('button', { name: /A社 提案書を仕上げる/ })).toBeVisible()
  expect(await calls(page, 'getRecordsForFile')).toContainEqual(['営業部/提案書/A社_提案.md'])

  // ← back to the card, → forward to the file.
  await page.getByRole('button', { name: '戻る' }).click()
  await expect(card.getByRole('heading', { name: 'A社 提案書を仕上げる' })).toBeVisible()
  await page.getByRole('button', { name: '進む' }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByText('A社への提案の骨子。')).toBeVisible()
})

test('「前の版」 of an open file replaces the 履歴 tab and refreshes in place after a sync', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await expect(leftTab(page, '探す')).toBeVisible()
  await expect(page.getByRole('button', { name: '履歴', exact: true })).toHaveCount(0)
  await leftTab(page, 'ファイル').click()
  await page.getByRole('button', { name: 'A社_提案.md' }).click()
  const versions = page.getByLabel('前の版')
  await expect(versions.getByText('提案書を更新')).toBeVisible()
  expect((await calls(page, 'gitLog')).at(-1)).toEqual(['営業部/提案書/A社_提案.md'])
  await page.getByRole('button', { name: 'サーバーと同期' }).click()
  await expect(versions.getByText('チームの変更を取り込み')).toBeVisible()
  // What one version changed opens as a diff.
  await versions.getByRole('button', { name: /提案書を更新/ }).click()
  await expect(page.getByText(/の変更）/)).toBeVisible()
})

test('skills: a skill the AI adds appears; a burst of events is one rescan', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await expect(page.getByRole('heading', { name: 'proposal' })).toBeVisible()
  const forcedBefore = (await calls(page, 'listSkills')).filter(([, force]) => force).length

  await page.evaluate(() => {
    window.__acbLayout.addSkill('営業部', 'quote')
    window.__acbLayout.emit([{ type: 'change', path: '/Users/demo/会社/営業部/.claude/skills/quote/SKILL.md' }])
    window.__acbLayout.emit([{ type: 'change', path: '/Users/demo/会社/営業部/.claude/skills/proposal/SKILL.md' }])
  })
  await expect(page.getByRole('heading', { name: 'quote' })).toBeVisible()
  await page.waitForTimeout(500)
  const forced = (await calls(page, 'listSkills')).filter(([, force]) => force)
  expect(forced.length - forcedBefore, 'one coalesced forced rescan of the shown department').toBe(1)
  expect(forced.at(-1)?.[0]).toBe('営業部')

  // A plain file edit is not a skills change.
  await page.evaluate(() => window.__acbLayout.emit([{ type: 'change', path: '/Users/demo/会社/営業部/提案書/A社_提案.md' }]))
  await page.waitForTimeout(500)
  expect((await calls(page, 'listSkills')).filter(([, force]) => force).length).toBe(forced.length)
})

// The app's shortcuts are commands (.claude/rules/commands.md): app-wide, so they work wherever the focus is.
test('shortcuts: ⌘P and ⌘K open 探す by name, ⌘⇧F the 探す tab with the cursor in its box', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  type Keys = { key: string; metaKey?: boolean; shiftKey?: boolean }
  const press = (init: Keys) => page.evaluate((i: Keys) => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', { ...i, bubbles: true }))
  }, init)
  await press({ key: 'p', metaKey: true })
  const nameSearch = page.getByPlaceholder('やること・案件・ファイルなどを名前で探す')
  await expect(nameSearch).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(nameSearch).toHaveCount(0)
  // ⌘K: the same 探す window; records the server finds by name come first, then files; Enter opens.
  await press({ key: 'k', metaKey: true })
  await expect(nameSearch).toBeFocused()
  await nameSearch.fill('提案')
  const options = page.getByRole('listbox', { name: '開くもの' }).getByRole('option')
  await expect(options.first()).toContainText('A社 提案書を仕上げる')
  await expect(page.getByRole('listbox', { name: '開くもの' })).toContainText('B社_提案.md')
  await nameSearch.press('Enter')
  await expect(nameSearch).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: '開いているもの' }).getByRole('tab', { name: /A社 提案書を仕上げる/ })).toHaveAttribute('aria-selected', 'true')
  // With nothing typed it lists what is open, newest first.
  await press({ key: 'k', metaKey: true })
  await expect(page.getByText('最近開いたもの')).toBeVisible()
  await expect(options.first()).toContainText('A社 提案書を仕上げる')
  await page.keyboard.press('Escape')
  await press({ key: 'f', metaKey: true, shiftKey: true })
  await expect(page.getByPlaceholder('探す（言葉を入れて Enter）')).toBeFocused()
})

test('a file link clicked in a consultation\'s own window opens here, in the files tab, as a kept tab (file.open)', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await leftTab(page, 'スキル').click()
  const file = `${ROOT}/総務/備品.md`
  await page.evaluate(path => window.__acbLayout.fileFromChatWindow(path), file)
  await expect(page.getByTitle(file, { exact: true })).toBeVisible()
  await expect(page.getByText('コピー用紙は総務へ。')).toBeVisible()
})

test('ログアウト is the one sign-out: the session ends and the company closes, so the login screen shows', async ({ page }) => {
  // The title bar's button used to end the session but leave the account
  // signed in on the company list.
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await page.getByTitle('ログアウト').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __acbLayout: { session(): unknown } }).__acbLayout.session()))
    .toEqual({ user: null, company: null })
  expect(await calls(page, 'signOut')).toEqual([[]])
})
