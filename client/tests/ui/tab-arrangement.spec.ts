// How the middle's tabs stand (tests/skill-layout-ui.tsx; files-and-editor.md "Arranging the tabs"):
// reordering by drag (pinned ones stay first, the order is kept), a drag out of the bar still links,
// 「種類ごとにまとめる」 (chips, folding, tidying one kind), the member's named groups (まとまり), and
// the AI's view of both.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Layout = { aiCommand(id: string, args?: unknown, companyId?: string): Promise<unknown> }
const layout = (page: Page) => page.evaluateHandle(() => (window as unknown as { __acbLayout: Layout }).__acbLayout)
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/${name}.png` })

const ROOT = '/Users/demo/会社'
const README = `${ROOT}/README.md`
const GUIDE = `${ROOT}/営業部/営業の進め方.md`
const SUPPLIES = `${ROOT}/総務/備品.md`
const TASK = 'acb-record:task-aaaaaa1'
const TASK2 = 'acb-record:task-cccccc1'
const DECISION = 'acb-record:decision-bbbbbb1'
const DEAL = 'acb-record:deal-dddddd1'
const RECORDS = {
  'task-aaaaaa1': { title: 'A社 提案書を仕上げる', type: 'task' },
  'task-cccccc1': { title: '請求書を送る', type: 'task' },
  'decision-bbbbbb1': { title: 'A社には150万円で出す', type: 'decision' },
  'deal-dddddd1': { title: 'A社', type: 'deal', typeLabel: '案件', implements: ['bundle'] },
}
const seed = (openFiles: string[], extra: Record<string, unknown> = {}, more: Record<string, string> = {}) => JSON.stringify({
  'editor:demo': JSON.stringify({ openFiles, activeFilePath: openFiles.find(k => k.startsWith('/')) ?? null, leftTab: 'files', records: RECORDS, ...extra }),
  ...more,
})

const bar = (page: Page) => page.getByRole('tablist', { name: '開いているもの' })
const fileTab = (page: Page, path: string) => bar(page).getByRole('tab').filter({ has: page.getByTitle(path, { exact: true }) })
const recordTab = (page: Page, title: string) => bar(page).getByRole('tab', { name: new RegExp(title) })
const tabNames = (page: Page) => bar(page).getByRole('tab').evaluateAll(tabs => tabs.map(t => t.querySelector('span[title]')?.textContent ?? ''))
const chip = (page: Page, name: string) => bar(page).locator(`[data-tab-group="${name}"]`)
const tabsMenu = (page: Page) => page.getByRole('button', { name: 'タブの操作' })

/** A real mouse drag (HTML5 drag and drop in Chromium) from one element to a point of another. */
async function drag(page: Page, from: Locator, to: Locator, x: 'left' | 'right' | 'middle', check?: () => Promise<void>) {
  await from.hover()
  await page.mouse.down()
  const box = (await to.boundingBox())!
  const at = { x: box.x + (x === 'left' ? 6 : x === 'right' ? box.width - 6 : box.width / 2), y: box.y + box.height / 2 }
  await page.mouse.move(at.x - 2, at.y, { steps: 4 })
  await page.mouse.move(at.x, at.y, { steps: 2 })
  await check?.()
  await page.mouse.up()
}

test('a tab dragged in the bar moves (an insertion line shows where), never in among the pinned ones, and the order is kept', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { seed: seed([GUIDE, SUPPLIES, README], { pinned: [README] }) })
  // The pinned tab stands first, whatever the saved order.
  await expect.poll(() => tabNames(page)).toEqual(['README.md', '営業の進め方.md', '備品.md'])

  await drag(page, fileTab(page, SUPPLIES), fileTab(page, GUIDE), 'left', async () => {
    await expect(fileTab(page, GUIDE)).toHaveAttribute('data-drop-line', 'before')
    await shot(page, 'tab-reorder-insertion-line')
  })
  await expect.poll(() => tabNames(page)).toEqual(['README.md', '備品.md', '営業の進め方.md'])

  // In among the pinned ones: no line, nothing moves.
  await drag(page, fileTab(page, GUIDE), fileTab(page, README), 'left', async () => {
    await expect(bar(page).locator('[data-drop-line]')).toHaveCount(0)
  })
  await expect.poll(() => tabNames(page)).toEqual(['README.md', '備品.md', '営業の進め方.md'])

  // An app restart keeps the order.
  await openPreview(page, 'skill-layout', { keep: '1' })
  await expect.poll(() => tabNames(page)).toEqual(['README.md', '備品.md', '営業の進め方.md'])
  expectNoPageErrors(state)
})

test('the drop target decides: in the bar a tab moves, on the consultation\'s input it is handed over and nothing moves', async ({ page }) => {
  // tests/chat-header-ui.tsx ?tabs=1: the real tab bar (with its arrangement) beside the real ChatPanel.
  await openPreview(page, 'chat-header', { tabs: '1', turn: 'manual' })
  await expect.poll(() => tabNames(page)).toEqual(['見積書を作り直す', '株式会社サンプル', '価格表.pdf'])
  await drag(page, bar(page).getByRole('tab', { name: /価格表/ }), recordTab(page, '見積書'), 'left', async () => {
    await expect(recordTab(page, '見積書')).toHaveAttribute('data-drop-line', 'before')
  })
  await expect.poll(() => tabNames(page)).toEqual(['価格表.pdf', '見積書を作り直す', '株式会社サンプル'])

  const input = page.locator('[data-composer-drop]')
  await drag(page, recordTab(page, '株式会社サンプル'), input, 'middle', async () => {
    await expect(page.locator('[data-drop-frame]')).toHaveText('ここに落とすと、この案件の相談になります')
    await expect(bar(page).locator('[data-drop-line]')).toHaveCount(0)
  })
  await expect(page.locator('[data-topic-chip]')).toContainText('株式会社サンプル')
  await expect.poll(() => tabNames(page)).toEqual(['価格表.pdf', '見積書を作り直す', '株式会社サンプル'])
})

test('種類ごとにまとめる: chips by kind in a fixed order, a folded group, a kind tidied alone; all kept per company', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { seed: seed([TASK, GUIDE, DECISION, DEAL, SUPPLIES, TASK2]) })
  await tabsMenu(page).click()
  await page.getByRole('menuitemcheckbox', { name: /種類ごとにまとめる/ }).click()
  await expect(bar(page).locator('[data-tab-group]')).toHaveCount(4)
  await expect.poll(() => bar(page).locator('[data-tab-group]').evaluateAll(cs => cs.map(c => c.getAttribute('data-tab-group')))).toEqual(['ファイル', 'やること', '案件', '決めたこと'])
  await expect(chip(page, 'やること')).toContainText('2')
  await expect.poll(() => tabNames(page)).toEqual(['営業の進め方.md', '備品.md', 'A社 提案書を仕上げる', '請求書を送る', 'A社', 'A社には150万円で出す'])
  await shot(page, 'tab-groups-by-kind')

  // By kind, a tab moves only among its kind.
  await drag(page, recordTab(page, '請求書を送る'), recordTab(page, 'A社 提案書'), 'left')
  await expect.poll(() => tabNames(page)).toEqual(['営業の進め方.md', '備品.md', '請求書を送る', 'A社 提案書を仕上げる', 'A社', 'A社には150万円で出す'])
  await drag(page, recordTab(page, '請求書を送る'), fileTab(page, GUIDE), 'left', async () => {
    await expect(bar(page).locator('[data-drop-line]')).toHaveCount(0)
  })

  // Folded: only the chip (the open tab, a file, is elsewhere).
  await chip(page, 'やること').getByRole('button', { expanded: true }).click()
  await expect(recordTab(page, 'A社 提案書')).toHaveCount(0)
  await expect(chip(page, 'やること')).toHaveAttribute('data-collapsed', 'true')
  await shot(page, 'tab-groups-collapsed')

  await openPreview(page, 'skill-layout', { keep: '1' })
  await expect(chip(page, 'やること')).toHaveAttribute('data-collapsed', 'true')
  await expect(recordTab(page, 'A社 提案書')).toHaveCount(0)

  // 「この種類を片づける」 from the chip's menu: only that kind goes.
  await chip(page, 'やること').getByRole('button', { name: 'やることの操作' }).click()
  await page.getByRole('button', { name: 'この種類（やること）を片づける' }).click()
  await expect(page.locator('[data-tidy-notice]')).toContainText('「やること」のタブを 2 件片づけました。')
  await expect(chip(page, 'やること')).toHaveCount(0)
  await expect(fileTab(page, GUIDE)).toBeVisible()
  await expect(recordTab(page, 'A社には150万円')).toBeVisible()
  expectNoPageErrors(state)
})

test('まとまり: made from a tab, joined by menu and by a drop on its chip, renamed, tidied as one and reopened as one', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { seed: seed([README, GUIDE, SUPPLIES, TASK]) })
  await fileTab(page, GUIDE).click({ button: 'right' })
  await page.getByRole('button', { name: '新しいまとまりに入れる…' }).click()
  await page.getByPlaceholder(/まとまりの名前/).fill('提案準備')
  await page.getByRole('radio', { name: '赤' }).click()
  await shot(page, 'tab-named-group-dialog')
  await page.getByRole('button', { name: '作る' }).click()
  await expect(chip(page, '提案準備')).toContainText('1')

  await recordTab(page, 'A社 提案書').click({ button: 'right' })
  await page.getByRole('button', { name: '「提案準備」に入れる' }).click()
  await expect(chip(page, '提案準備')).toContainText('2')
  // Dropped on the chip: it joins at the end.
  await drag(page, fileTab(page, SUPPLIES), chip(page, '提案準備'), 'middle')
  await expect(chip(page, '提案準備')).toContainText('3')
  // Named groups stand first; the rest follow.
  await expect.poll(() => tabNames(page)).toEqual(['営業の進め方.md', 'A社 提案書を仕上げる', '備品.md', 'README.md'])
  // Dragged beside a tab outside the group, it leaves it.
  await drag(page, fileTab(page, SUPPLIES), fileTab(page, README), 'right')
  await expect(chip(page, '提案準備')).toContainText('2')
  await expect.poll(() => tabNames(page)).toEqual(['営業の進め方.md', 'A社 提案書を仕上げる', 'README.md', '備品.md'])
  await shot(page, 'tab-named-group')

  // With 種類ごとにまとめる on, the named group stays first and the rest go by kind.
  await tabsMenu(page).click()
  await page.getByRole('menuitemcheckbox', { name: /種類ごとにまとめる/ }).click()
  await expect.poll(() => bar(page).locator('[data-tab-group]').evaluateAll(cs => cs.map(c => c.getAttribute('data-tab-group')))).toEqual(['提案準備', 'ファイル'])
  await shot(page, 'tab-named-group-and-kinds')

  await chip(page, '提案準備').getByRole('button', { name: '提案準備の操作' }).click()
  await page.getByRole('button', { name: '名前と色を変える…' }).click()
  await page.getByPlaceholder(/まとまりの名前/).fill('A社の提案')
  await page.getByRole('button', { name: '変える' }).click()
  await expect(chip(page, 'A社の提案')).toContainText('2')

  // The AI sees the group's name and each tab's kind.
  const ai = await layout(page)
  const listed = await ai.evaluate(l => l.aiCommand('tabs.list')) as { ok: true; result: { openTabs: Array<Record<string, unknown>> } }
  expect(listed.result.openTabs.filter(t => t.tabGroup === 'A社の提案').map(t => t.title)).toEqual(['営業の進め方.md', 'A社 提案書を仕上げる'])
  expect(listed.result.openTabs.find(t => t.title === 'A社 提案書を仕上げる')?.kindId).toBe('task')

  // An app restart keeps it.
  await openPreview(page, 'skill-layout', { keep: '1' })
  await expect(chip(page, 'A社の提案')).toContainText('2')

  await chip(page, 'A社の提案').getByRole('button', { name: 'A社の提案の操作' }).click()
  await page.getByRole('button', { name: 'このまとまりを片づける' }).click()
  await expect(page.locator('[data-tidy-notice]')).toContainText('まとまり「A社の提案」のタブを 2 件片づけました。')
  await expect(chip(page, 'A社の提案')).toHaveCount(0)
  await expect(fileTab(page, README)).toBeVisible()

  await page.getByRole('button', { name: '片づけたタブを見る' }).click()
  const list = page.getByRole('dialog', { name: '片づけたタブ' })
  await expect(list.locator('[data-tidied-group="A社の提案"]')).toBeVisible()
  await list.getByRole('button', { name: '全部開き直す' }).click()
  await list.getByRole('button', { name: '閉じる' }).click()
  await expect(chip(page, 'A社の提案')).toContainText('2')

  await chip(page, 'A社の提案').getByRole('button', { name: 'A社の提案の操作' }).click()
  await page.getByRole('button', { name: 'まとまりを解く' }).click()
  await expect(bar(page).locator('[data-tab-group="A社の提案"]')).toHaveCount(0)
  await expect(fileTab(page, GUIDE)).toBeVisible()
  expectNoPageErrors(state)
})

test('the AI tidies one kind or one named group; an unknown group is refused and nothing closes', async ({ page }) => {
  const groups = JSON.stringify({ byKind: false, collapsedKinds: [], groups: [{ id: 'g1', name: '提案準備', color: 'rose' }], members: { [SUPPLIES]: 'g1' } })
  await openPreview(page, 'skill-layout', { seed: seed([GUIDE, TASK, SUPPLIES, TASK2], {}, { 'tabGroups:demo': groups }) })
  await expect(chip(page, '提案準備')).toBeVisible()
  const ai = await layout(page)
  const refused = await ai.evaluate(l => l.aiCommand('tabs.tidy', { group: 'ない' })) as { ok: true; result: { error: string } }
  expect(refused.result.error).toContain('見つかりません')
  await expect(bar(page).getByRole('tab')).toHaveCount(4)

  const byKind = await ai.evaluate(l => l.aiCommand('tabs.tidy', { kind: 'task' })) as { ok: true; result: { tidied: number } }
  expect(byKind.result.tidied).toBe(2)
  await expect(recordTab(page, 'A社 提案書')).toHaveCount(0)
  await expect(fileTab(page, GUIDE)).toBeVisible()

  const byGroup = await ai.evaluate(l => l.aiCommand('tabs.tidy', { group: '提案準備' })) as { ok: true; result: { tidied: number } }
  expect(byGroup.result.tidied).toBe(1)
  await expect(fileTab(page, SUPPLIES)).toHaveCount(0)
  await expect(fileTab(page, GUIDE)).toBeVisible()
  // Another company's consultation is still refused.
  const other = await ai.evaluate(l => l.aiCommand('tabs.tidy', { kind: 'file' }, 'other')) as { ok: boolean }
  expect(other.ok).toBe(false)
  await expect(fileTab(page, GUIDE)).toBeVisible()
})
