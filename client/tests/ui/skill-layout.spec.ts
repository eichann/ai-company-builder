// The main screen (SkillCentricLayout) with the preload API faked
// (tests/skill-layout-ui.tsx). Pure parts are pinned elsewhere — file tree
// planning and per-department caching (file-tree-model.test.ts), which file
// events rescan skills (skills-refresh.test.ts), write-access evaluation
// (write-access.test.ts), search caps in main (git-search.test.ts). These
// tests pin what the SkillCentricLayout split (R3) can break: what stays
// mounted across department and tab switches, the not-downloaded overlay,
// the read-only marks, and the wiring of search, history and skills refresh.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Call = { name: string; args: unknown[] }
type Layout = { calls: Call[]; addSkill(folder: string, name: string): void; emit(changes: Array<{ type: string; path: string }>): void }
declare global { interface Window { __acbLayout: Layout } }

const ROOT = '/Users/demo/会社'
const calls = (page: Page, name: string) => page.evaluate(n => window.__acbLayout.calls.filter(c => c.name === n).map(c => c.args), name)
const deptTab = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).first()
const leftTab = (page: Page, name: 'スキル' | 'ファイル' | '検索' | '履歴') => page.getByRole('button', { name, exact: true })
const overlay = (page: Page) => page.getByRole('button', { name: 'ダウンロードして同期を開始' })

test('switching departments keeps the file tree mounted with what was expanded or collapsed, without a cold re-read', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, 'ファイル').click()
  const folder = page.getByRole('button', { name: '提案書', exact: true })
  await expect(folder).toBeVisible()
  // First-level folders open on first view (file-tree-model.test.ts); their files are listed.
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
  // cheap check of its root (file-tree-model.test.ts "catches up when shown again").
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

test('search: results grouped by file, the cap note when truncated, cleared by a department switch', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, '検索').click()
  const box = page.getByRole('textbox').filter({ visible: true }).first()
  await expect(box).toBeFocused()
  await box.fill('提案')
  await box.press('Enter')
  await expect(page.getByText('2ファイル / 3件')).toBeVisible()
  await expect(page.getByText(/結果が多いため/)).toHaveCount(0)
  expect(await calls(page, 'gitGrep')).toEqual([['提案', '営業部']])

  await box.fill('の')
  await box.press('Enter')
  await expect(page.getByText('結果が多いため最初の500件を表示しています。言葉を増やして絞り込んでください。')).toBeVisible()

  await deptTab(page, '総務').click()
  await expect(page.getByText(/ファイル \/ \d+件/)).toHaveCount(0)
  await expect(page.getByText(/結果が多いため/)).toHaveCount(0)
})

test('history refreshes in place after a sync', async ({ page }) => {
  await openPreview(page, 'skill-layout')
  await deptTab(page, '営業部').click()
  await leftTab(page, '履歴').click()
  await expect(page.getByText('提案書を更新')).toBeVisible()
  expect((await calls(page, 'gitLog')).at(-1)).toEqual(['営業部/'])
  await page.getByRole('button', { name: 'サーバーと同期' }).click()
  await expect(page.getByText('チームの変更を取り込み')).toBeVisible()
  await expect(page.getByText('提案書を更新')).toBeVisible()
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
