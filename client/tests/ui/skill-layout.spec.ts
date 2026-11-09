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

test('探す: one row per file, the cap note when truncated, searched again in another department; a hit opens the file in the middle', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, '探す').click()
  const box = page.getByRole('textbox').filter({ visible: true }).first()
  await expect(box).toBeFocused()
  // Live: no Enter needed.
  await box.fill('提案')
  // Two records and two files hold the words; A社_提案.md has two lines and is one row.
  await expect(page.getByText('営業部の中で 4件')).toBeVisible()
  await expect(page.locator('[data-hit="file:営業部/提案書/A社_提案.md"]')).toHaveCount(1)
  await expect(page.getByText(/見つかったところが多いため/)).toHaveCount(0)
  expect(await calls(page, 'gitGrep')).toEqual([['提案', '営業部']])
  // A file's hit opens that file in a tab in the middle, 探す staying on the left.
  await page.locator('[data-hit="file:営業部/提案書/A社_提案.md"]').click()
  await expect(page.getByRole('tablist', { name: '開いているもの' }).getByRole('tab', { name: /A社_提案\.md/ })).toHaveAttribute('aria-selected', 'true')
  await expect(box).toBeVisible()

  await box.fill('の')
  await box.press('Enter')
  await expect(page.getByText('ファイルの中に見つかったところが多いため、一部だけ出しています。言葉を増やすと絞れます')).toBeVisible()

  // Another department: the same words, searched there.
  await deptTab(page, '総務').click()
  await expect.poll(async () => (await calls(page, 'gitGrep')).at(-1)).toEqual(['の', '総務'])
})

test('探す finds records next to files with a chip for each kind found; a record opens as a card, its links are followed, ← → go back and forth', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, '探す').click()
  const box = page.getByRole('textbox').filter({ visible: true }).first()
  await box.fill('提案')
  const records = page.locator('[data-hit^="record:"]')
  const files = page.locator('[data-hit^="file:"]')
  const chips = page.getByRole('group', { name: '種類で絞る' })
  // Only kinds with something found get a chip.
  await expect(chips.getByRole('button')).toHaveText(['やること1', '決めたこと1', 'ファイル2'])
  expect(await calls(page, 'findRecords')).toEqual([['demo', '提案']])
  await chips.getByRole('button', { name: /決めたこと/ }).click()
  await expect(records).toHaveCount(1)
  await expect(files).toHaveCount(0)
  await chips.getByRole('button', { name: /決めたこと/ }).click()
  await expect(records).toHaveCount(2)
  const hits = page.locator('[data-find-panel]')

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
  await expect(page.getByPlaceholder('覚えている言葉で探す')).toBeFocused()
})

test('⌘K finds skills (the shown department\'s and the company-wide ones) and consultations by name; a skill opens in the スキル tab', async ({ page }) => {
  await openPreview(page, 'skill-layout', { consultations: '1' })
  await deptTab(page, '営業部').click()
  const press = () => page.evaluate(() => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  })
  const nameSearch = page.getByPlaceholder('やること・案件・ファイルなどを名前で探す')
  const options = page.getByRole('listbox', { name: '開くもの' }).getByRole('option')
  // A consultation by its title, labelled as the list names it.
  await press()
  await nameSearch.fill('見積')
  await expect(options.filter({ hasText: '見積の相談' })).toContainText('AIへの相談')
  await page.keyboard.press('Escape')
  // A company-wide skill while 営業部 is shown: chosen, it opens under 全社 in the スキル tab.
  await press()
  await nameSearch.fill('WEEKLY')
  await expect(options.first()).toContainText('weekly-report')
  await expect(options.first()).toContainText('スキル')
  await nameSearch.press('Enter')
  await expect(nameSearch).toHaveCount(0)
  // Its card under 全社 (営業部's skills gone) and, chosen, its detail beside it: the heading twice.
  await expect(page.getByRole('heading', { name: 'weekly-report' })).toHaveCount(2)
  await expect(page.getByRole('heading', { name: 'proposal' })).toHaveCount(0)
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

// 今日のフォルダ (tasks-ui.md "今日のフォルダ"): from any department, ⌘⇧T (command files.openToday) or the
// file panel's button switches to the department that holds it (the first 所属 downloaded here: 開発部 is
// not, so 営業部), makes the day's folder when missing and shows it in the tree, selected. A second press
// makes nothing (it is there). SCREENSHOTS=<dir> writes the tree and the settings row.
test('今日のフォルダを開く: from another department, made when missing, shown selected in the 所属 department', async ({ page }) => {
  // 2026-11-03 09:00 in Japan.
  await page.clock.install({ time: new Date('2026-11-03T00:00:00Z') })
  await openPreview(page, 'skill-layout')
  await deptTab(page, '総務').click()
  await leftTab(page, 'スキル').click()
  await page.keyboard.press('ControlOrMeta+Shift+T')
  const day = page.getByRole('button', { name: '20261103', exact: true })
  await expect(day).toBeVisible()
  await expect(day).toHaveClass(/bg-accent\/20/)
  await expect(page.getByRole('button', { name: 'A社_提案.md' })).toBeVisible()
  expect(await calls(page, 'createDirectory')).toEqual([[`${ROOT}/営業部/.personal/inbox/日付別/2026/20261103`]])
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/today-folder-tree.png` })

  // The header button does the same; the folder is there now, so nothing is made again.
  await deptTab(page, '総務').click()
  await page.getByRole('button', { name: '今日のフォルダを開く' }).click()
  await expect(day).toBeVisible()
  expect((await calls(page, 'createDirectory')).length).toBe(1)
})

test('自分の設定: 今日のフォルダ says where it is and which department おまかせ uses; a choice moves it', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-03T00:00:00Z') })
  await openPreview(page, 'skill-layout')
  await page.getByTitle('設定').first().click()
  const row = page.locator('[data-today-folder-setting]')
  await expect(row).toContainText('営業部/.personal/inbox/日付別/2026/20261103/')
  const select = row.getByRole('combobox', { name: '今日のフォルダを置く部署' })
  await expect(select.locator('option')).toHaveText(['おまかせ（営業部）', '営業部', '総務'])
  if (process.env.SCREENSHOTS) await row.screenshot({ path: `${process.env.SCREENSHOTS}/today-folder-setting.png` })
  await select.selectOption({ label: '総務' })
  await expect(row).toContainText('総務/.personal/inbox/日付別/2026/20261103/')
})

test('a company without the shared folder: no sync, preview or backups (one short note), no 閲覧のみ, no download prompt, no 同期 settings', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none' })
  // Pressed, the note says the files are on this PC only and to back them up; records are on the server.
  await page.getByRole('button', { name: 'この PC だけで作業' }).click()
  await expect(page.getByRole('note')).toContainText('サーバーには残りません。PC のバックアップ機能で守ってください。やること・決めたことなどの記録はサーバーに残ります。')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('note')).toHaveCount(0)
  for (const name of ['サーバーと同期', '変更を確認', 'バックアップ履歴']) await expect(page.getByRole('button', { name })).toHaveCount(0)
  // 開発部 is "not downloaded" for a git company: here every folder is on this PC.
  await deptTab(page, '開発部').click()
  await expect(overlay(page)).toHaveCount(0)
  // 総務 is read-only for this member in a git company: the working folder is the member's own.
  await deptTab(page, '全社').click()
  await leftTab(page, 'ファイル').click()
  await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^総務/ }).filter({ hasText: '閲覧のみ' })).toHaveCount(0)
  await page.getByRole('button', { name: '設定' }).click()
  await expect(page.getByRole('button', { name: '自分の設定' })).toBeVisible()
  for (const name of ['ダウンロードするフォルダ', '自動同期', '同期しないファイル']) await expect(page.getByRole('button', { name })).toHaveCount(0)
  expect(await calls(page, 'gitSync')).toEqual([])
})

// The Skill shelf (plugins.md "The Skill shelf in the app"): delivered Skills are told from the
// member's own, a local one can go to the company, and the server's refusal reads as it was written.
test('without the shared folder: a company Skill says so and offers only 自分用に直す; 育て中 and 会社に公開 are not offered on it', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none' })
  await deptTab(page, '全社').click()
  await page.getByRole('heading', { name: 'weekly-report' }).click()
  await expect(page.getByText('会社の Skill（版 abcd1234）')).toBeVisible()
  await expect(page.getByText('AI やこの PC で変えても、次に受け取るときに元に戻ります。')).toBeVisible()
  // A delivered rule kept back by the member's own file is said here too.
  await expect(page.getByRole('status').filter({ hasText: '会社の決まり' })).toContainText('会社の決まり（tone）と同じ名前のファイルがあるため')
  await expect(page.getByRole('button', { name: '会社に公開' })).toHaveCount(0)
  await expect(page.getByText('ステータス')).toBeHidden()
  await expect(page.getByText('この PC だけのスキルです')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '会社の版に戻す' })).toHaveCount(0)
  await page.getByRole('button', { name: '自分用に直す' }).click()
  await expect(page.getByText('この PC だけで、あなたが直した版を使うようにします。')).toBeVisible()
  expect(await calls(page, 'editCompanySkillLocally')).toEqual([])
  await page.getByRole('button', { name: '自分用に直す' }).click()
  expect(await calls(page, 'editCompanySkillLocally')).toEqual([['weekly-report']])
})

test('without the shared folder: a local Skill stays 「この PC だけ」 and goes to the company only after the confirmation', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none' })
  await deptTab(page, '営業部').click()
  await page.getByRole('heading', { name: 'proposal' }).click()
  await expect(page.getByText('この PC だけのスキルです（ほかの人には共有されません）。')).toBeVisible()
  await page.getByRole('button', { name: '会社に公開' }).click()
  await expect(page.getByText('会社の Skill として公開します。')).toBeVisible()
  await page.getByRole('button', { name: 'キャンセル' }).click()
  expect(await calls(page, 'publishSkillToCompany')).toEqual([])
  await page.getByRole('button', { name: '会社に公開' }).click()
  await page.getByRole('button', { name: '会社に公開' }).click()
  await expect.poll(() => calls(page, 'publishSkillToCompany')).toEqual([['proposal', null]])
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('without the shared folder: the server\'s refusal is shown in its words', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none', shelf: 'refused' })
  await deptTab(page, '営業部').click()
  await page.getByRole('heading', { name: 'proposal' }).click()
  await page.getByRole('button', { name: '会社に公開' }).click()
  await page.getByRole('button', { name: '会社に公開' }).click()
  await expect(page.getByRole('alert')).toContainText('この Skill・指示を変えられるのは、決められた人だけです。')
  // It was about that Skill: another one opens without it.
  await page.evaluate(() => window.__acbLayout.addSkill('営業部', 'visit-memo'))
  await page.getByRole('heading', { name: 'visit-memo' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('without the shared folder: a Skill under 自分用に直す is one card that says what it means and what to do next, not that a name happens to clash', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none', shelf: 'editing' })
  await deptTab(page, '開発部').click()
  await page.getByRole('heading', { name: 'release-note' }).click()
  await expect(page.getByText('自分用に直し中')).toBeVisible()
  const card = page.getByRole('region', { name: '自分用に直している Skill' })
  await expect(card.getByRole('heading', { name: '自分用に直している Skill' })).toBeVisible()
  await expect(card).toContainText('この PC の AI だけが、あなたの直した版を使います。ほかの人には届きません。')
  await expect(card.getByRole('button', { name: 'SKILL.md を開いて直す' })).toBeVisible()
  await expect(card.getByRole('button', { name: '会社の版に戻す' })).toBeVisible()
  await expect(card.getByRole('button', { name: '会社に公開' })).toBeVisible()
  await expect(page.getByText(/フォルダを消/)).toHaveCount(0)
  await expect(page.getByText('会社にも同じ名前の Skill があります。')).toHaveCount(0)
  await expect(page.getByText('この PC だけのスキルです')).toHaveCount(0)
  await card.getByRole('button', { name: '会社に公開' }).click()
  await expect(page.getByText('会社の同じ名前の Skill を、この内容に置き換えます。')).toBeVisible()
})

test('without the shared folder: 会社の版に戻す asks first, says the member\'s version is kept, and only then goes back', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none', shelf: 'editing', download: 'done' })
  await deptTab(page, '開発部').click()
  await page.getByRole('heading', { name: 'release-note' }).click()
  const card = page.getByRole('region', { name: '自分用に直している Skill' })
  await card.getByRole('button', { name: '会社の版に戻す' }).click()
  await expect(card).toContainText('会社の版に戻します。あなたが直した内容は、念のため控えに残します')
  await card.getByRole('button', { name: 'キャンセル' }).click()
  expect(await calls(page, 'restoreCompanySkill')).toEqual([])
  await card.getByRole('button', { name: '会社の版に戻す' }).click()
  await card.getByRole('button', { name: '会社の版に戻す' }).click()
  await expect.poll(() => calls(page, 'restoreCompanySkill')).toEqual([['release-note']])
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('without the shared folder: 会社の版に戻す while the company\'s version cannot be received says when it comes', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none', shelf: 'editing', restore: 'later', download: 'done' })
  await deptTab(page, '開発部').click()
  await page.getByRole('heading', { name: 'release-note' }).click()
  const card = page.getByRole('region', { name: '自分用に直している Skill' })
  await card.getByRole('button', { name: '会社の版に戻す' }).click()
  await card.getByRole('button', { name: '会社の版に戻す' }).click()
  await expect(page.getByRole('alert')).toContainText('会社の版は、次に受け取るときに届きます。')
})

test('without the shared folder: the member\'s Skill beside a company one of the same name says so, and publishing names the version it replaces', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none', download: 'done' })
  await deptTab(page, '開発部').click()
  await page.getByRole('heading', { name: 'release-note' }).click()
  await expect(page.getByText('会社にも同じ名前の Skill があります。')).toBeVisible()
  await page.getByRole('button', { name: '会社に公開' }).click()
  await expect(page.getByText('会社の同じ名前の Skill を、この内容に置き換えます。')).toBeVisible()
  await page.getByRole('button', { name: '会社に公開' }).click()
  await expect.poll(() => calls(page, 'publishSkillToCompany')).toEqual([['release-note', 'abcd1234'.repeat(8)]])
})

test('without the shared folder: 会社に公開 is not offered where the server says the member may not publish; the notes stay', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none', publish: 'no', download: 'done' })
  await deptTab(page, '営業部').click()
  await page.getByRole('heading', { name: 'proposal' }).click()
  await expect(page.getByText('この PC だけのスキルです（ほかの人には共有されません）。')).toBeVisible()
  await expect(page.getByRole('button', { name: '会社に公開' })).toHaveCount(0)
  await deptTab(page, '開発部').click()
  await page.getByRole('heading', { name: 'release-note' }).click()
  await expect(page.getByText('会社にも同じ名前の Skill があります。')).toBeVisible()
  await expect(page.getByRole('button', { name: '会社に公開' })).toHaveCount(0)
  // 自分用に直す stays open to everyone, in words true for someone who cannot publish.
  await deptTab(page, '全社').click()
  await page.getByRole('heading', { name: 'weekly-report' }).click()
  await page.getByRole('button', { name: '自分用に直す' }).click()
  const confirm = page.getByText('この PC だけで、あなたが直した版を使うようにします。')
  await expect(confirm).toBeVisible()
  await expect(confirm).not.toContainText('公開')
})

test('without the shared folder: a Skill under 自分用に直す, for someone who cannot publish, offers 会社の版に戻す and says nothing of publishing', async ({ page }) => {
  await openPreview(page, 'skill-layout', { kind: 'none', shelf: 'editing', publish: 'no', download: 'done' })
  await deptTab(page, '開発部').click()
  await page.getByRole('heading', { name: 'release-note' }).click()
  const card = page.getByRole('region', { name: '自分用に直している Skill' })
  await expect(card).toContainText('「会社の版に戻す」を押すまで、この PC には届きません。')
  await expect(card).not.toContainText('公開')
  await expect(card.getByRole('button', { name: '会社の版に戻す' })).toBeVisible()
  await expect(page.getByRole('button', { name: '会社に公開' })).toHaveCount(0)
})

test('a git company keeps its 公開 section: no 会社に公開, no company mark', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '全社').click()
  await page.getByRole('heading', { name: 'weekly-report' }).click()
  await expect(page.getByText('公開中')).toBeVisible()
  await expect(page.getByRole('button', { name: '会社に公開' })).toHaveCount(0)
  await expect(page.getByText('会社の Skill')).toHaveCount(0)
  await expect(page.getByText('会社の決まり')).toHaveCount(0)
})

// The task card's own file actions (owner decision 2026-11-07): a company without the shared folder
// cannot link files (the server answers NO_COMPANY_FOLDER), so its card offers neither; a git company keeps both.
for (const kind of ['git', 'none'] as const) {
  test(`a task card in a ${kind} company: ［ファイル・フォルダをつなぐ］ and ［新しいファイル］ ${kind === 'git' ? 'offered' : 'not offered'}`, async ({ page }) => {
    await openPreview(page, 'skill-layout', { tasks: '1', personal: '1', ...(kind === 'none' ? { kind: 'none' } : {}) })
    await page.getByRole('button', { name: /^やること/ }).first().click()
    await page.getByRole('region', { name: 'やることの一覧' }).getByText('A社 提案書を仕上げる').click()
    const card = page.getByTestId('record-tab')
    await expect(card.getByText('A社 提案書を仕上げる').first()).toBeVisible()
    await expect(card.getByText('決めたこと').first()).toBeVisible()
    const shown = kind === 'git' ? 1 : 0
    await expect(card.getByRole('button', { name: 'ファイル・フォルダをつなぐ' })).toHaveCount(shown)
    await expect(card.getByRole('button', { name: '新しいファイル' })).toHaveCount(shown)
  })
}
