// Files and records open side by side in the middle (plan A, 新しい画面のデモ): the やること tab
// is the narrow column where the file tree sits, an opened task is a tab next to the open files
// (its kind's icon and title, no 「ファイルではありません」 line), switching the left tab keeps it,
// ← → go between file and record tabs, and an app restart brings the record tab back. Main screen:
// src/app/AppShell.tsx on tests/skill-layout-ui.html?tasks=1. The list itself: tasks-list.spec.ts.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const chatDivider = (page: Page) => page.getByRole('separator', { name: '左の欄とチャットの境目' })
// The tab strip comes first; a task row's name may start with 「やること」 too.
const leftTab = (page: Page, name: RegExp) => page.getByRole('button', { name }).first()
const middleTabs = (page: Page) => page.getByRole('tablist', { name: '開いているもの' })
const box = async (locator: Locator) => {
  const b = (await locator.boundingBox())!
  return { left: Math.round(b.x), top: Math.round(b.y), right: Math.round(b.x + b.width), bottom: Math.round(b.y + b.height) }
}

test('a task opens as a tab beside the files; it stays when the left tab changes; ← → and a restart keep it', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { tasks: '1' })
  const window = page.viewportSize()!

  await leftTab(page, /^ファイル$/).click()
  // A double click keeps the tab (a single click opens the preview tab the next one replaces).
  await page.getByRole('button', { name: 'README.md' }).dblclick()
  await expect(middleTabs(page).getByRole('tab', { name: /README\.md/ })).toBeVisible()
  const filesDivider = await box(chatDivider(page))
  const treeDivider = await box(page.getByRole('separator', { name: 'ファイルツリーとエディタの境目' }))

  // No count on the やること tab (the title bar's あなたの番 has it): a dot for what is new, gone once seen.
  await expect(leftTab(page, /^やること/).locator('[data-new-dot]')).toBeVisible()
  await expect(leftTab(page, /^やること/)).not.toContainText(/\d/)
  await leftTab(page, /^やること/).click()
  await expect(leftTab(page, /^やること/).locator('[data-new-dot]')).toHaveCount(0)
  const list = page.getByRole('region', { name: 'やることの一覧' })
  await expect(list.getByText('A社 提案書を仕上げる')).toBeVisible()
  // The list is the narrow column, under the tab strip and down to the bottom; the consultation stays.
  expect(await box(chatDivider(page))).toEqual(filesDivider)
  const listBox = await box(list)
  expect(listBox.right).toBeLessThanOrEqual(treeDivider.left + 2)
  expect(listBox.bottom).toBe(window.height)

  // The task opens in the middle as a tab, next to README.md; the list stays on the left.
  await list.getByText('A社 提案書を仕上げる').click()
  const taskTab = middleTabs(page).getByRole('tab', { name: /A社 提案書を仕上げる/ })
  await expect(taskTab).toHaveAttribute('aria-selected', 'true')
  await expect(middleTabs(page).getByRole('tab', { name: /README\.md/ })).toBeVisible()
  const card = page.getByTestId('record-tab')
  await expect(card.getByText('A社_提案.md').first()).toBeVisible()
  const cardBox = await box(card)
  expect(cardBox.left).toBeGreaterThanOrEqual(treeDivider.right - 2)
  expect(cardBox.right).toBeLessThanOrEqual(filesDivider.left)
  await expect(page.getByText('ファイルではありません')).toHaveCount(0)
  await expect(list).toBeVisible()

  // Switching the left tab keeps the record tab open in the middle; what was seen gets no dot.
  await leftTab(page, /^ファイル$/).click()
  await expect(leftTab(page, /^やること/).locator('[data-new-dot]')).toHaveCount(0)
  await expect(taskTab).toHaveAttribute('aria-selected', 'true')
  await expect(card).toBeVisible()

  // ← back to the file, → forward to the task.
  await page.getByRole('button', { name: '戻る' }).click()
  await expect(middleTabs(page).getByRole('tab', { name: /README\.md/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: '進む' }).click()
  await expect(taskTab).toHaveAttribute('aria-selected', 'true')

  // A wide tab (スキル) covers the middle; coming back shows the same tabs.
  await leftTab(page, /^スキル$/).click()
  await expect(card).toBeHidden()
  await leftTab(page, /^やること/).click()
  await expect(card).toBeVisible()

  // An app restart brings the record tab back with its title, before the record is read again.
  await openPreview(page, 'skill-layout', { tasks: '1', keep: '1' })
  await expect(middleTabs(page).getByRole('tab', { name: /A社 提案書を仕上げる/ })).toBeVisible()
  expectNoPageErrors(state)
})

// Owner 2026-11-03 (使い心地のメモ #3): when the consultation's AI changed the task (linked a file),
// the whole task screen flickered — the card was keyed by its version, so every version remounted
// it (read again from nothing, folds closed). Now the same card updates in place: the new file shows,
// the open 経緯 stays open, and neither the card nor the list ever shows 「読み込んでいます」 again.
test('the AI changing the task updates its open card in place: no remount, no loading flash, folds kept', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { tasks: '1' })
  await leftTab(page, /^やること/).click()
  const list = page.getByRole('region', { name: 'やることの一覧' })
  await list.getByText('A社 提案書を仕上げる').click()
  const card = page.getByTestId('record-tab')
  await expect(card.getByText('A社_提案.md').first()).toBeVisible()
  await card.getByRole('button', { name: /経緯/ }).click()
  await expect(card.getByText('山田 花子：作りました')).toBeVisible()
  // Mark the card's node and watch for any loading text from now on.
  await card.getByTestId('task-card').evaluate(el => { (el as HTMLElement).dataset.sameNode = '1' })
  await page.evaluate(() => {
    const w = window as unknown as { __flashed: boolean }
    w.__flashed = false
    new MutationObserver(() => { if (document.getElementById('root')!.textContent!.includes('読み込んでいます')) w.__flashed = true })
      .observe(document.getElementById('root')!, { childList: true, subtree: true, characterData: true })
  })
  const reads = await page.evaluate(() => (window as unknown as { __acbLayout: { cardReads: () => number } }).__acbLayout.cardReads())
  await page.evaluate(() => (window as unknown as { __acbLayout: { aiLinksFile: (p: string) => void } }).__acbLayout.aiLinksFile('営業部/提案書/見積メモ.md'))
  await expect(card.getByText('見積メモ.md').first()).toBeVisible()
  await expect(card.getByTestId('task-card')).toHaveAttribute('data-same-node', '1')
  await expect(card.getByText('山田 花子：作りました')).toBeVisible()
  await expect(list.getByText('A社 提案書を仕上げる')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __flashed: boolean }).__flashed)).toBe(false)
  // One change, one read of the card (the list's newer version asks nothing more once shown).
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => (window as unknown as { __acbLayout: { cardReads: () => number } }).__acbLayout.cardReads())).toBeLessThanOrEqual(reads + 2)
  expectNoPageErrors(state)
})

// Owner FB #14: switching tabs showed 「読み込んでいます」 every time — the card is mounted only while
// its tab is shown and read from nothing again. Now it comes back with what it showed at once, reads
// again in the background, and the newer answer replaces it.
test('a task tab switched back to shows its card at once (no loading) and then updates', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { tasks: '1' })
  await leftTab(page, /^ファイル$/).click()
  await page.getByRole('button', { name: 'README.md' }).dblclick()
  await leftTab(page, /^やること/).click()
  await page.getByRole('region', { name: 'やることの一覧' }).getByText('A社 提案書を仕上げる').click()
  const card = page.getByTestId('record-tab')
  await expect(card.getByText('A社_提案.md').first()).toBeVisible()

  await middleTabs(page).getByRole('tab', { name: /README\.md/ }).click()
  await expect(card).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { __acbLayout: { serverLinksFile: (p: string) => void } }).__acbLayout.serverLinksFile('営業部/提案書/見積メモ.md'))
  await page.evaluate(() => {
    const w = window as unknown as { __flashed: boolean }
    w.__flashed = false
    new MutationObserver(() => { if (document.getElementById('root')!.textContent!.includes('読み込んでいます')) w.__flashed = true })
      .observe(document.getElementById('root')!, { childList: true, subtree: true, characterData: true })
  })
  await middleTabs(page).getByRole('tab', { name: /A社 提案書を仕上げる/ }).click()
  // At once: the card shown before (the read takes 120 ms), then the server's newer one.
  await expect(card.getByText('A社_提案.md').first()).toBeVisible({ timeout: 100 })
  await expect(card.getByText('見積メモ.md').first()).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __flashed: boolean }).__flashed)).toBe(false)
  expectNoPageErrors(state)
})

// Staging, 1440×900 (FB): the left tabs broke their names one character per line in the narrow
// column; then (#516) showed icons only. Owner 2026-11-02: the names always show. Narrow: the name
// (11 px, one line) under its icon, every tab inside the column even at its minimum; wide: side by side.
const NAMES = ['スキル', 'ファイル', 'やること', '探す', '番組']

async function leftTabsLook(page: Page) {
  const strip = page.locator('[data-left-tabs]')
  const s = (await strip.boundingBox())!
  const looks: Array<'stacked' | 'side by side'> = []
  for (const name of NAMES) {
    const tab = strip.locator(`button[title="${name}"]`)
    const label = tab.locator('[data-left-tab-name]')
    await expect(label).toBeVisible()
    await expect(label).toHaveText(name)
    expect(await label.evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(11)
    const t = (await tab.boundingBox())!
    const l = (await label.boundingBox())!
    const icon = (await tab.locator('svg').first().boundingBox())!
    // One line: never a column of characters.
    expect(l.height).toBeLessThan(20)
    // Inside the column, nothing cut off.
    expect(t.x).toBeGreaterThanOrEqual(s.x - 1)
    expect(t.x + t.width).toBeLessThanOrEqual(s.x + s.width + 1)
    looks.push(l.y >= icon.y + icon.height - 1 ? 'stacked' : 'side by side')
  }
  return looks
}

test('at 1440×900 every left tab shows its name on one line: stacked in the narrow column (even at its minimum), side by side when wide', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await openPreview(page, 'skill-layout', { tasks: '1', plugin: '1' })
  const strip = page.locator('[data-left-tabs]')
  await strip.locator('button[title="ファイル"]').click()
  expect(await leftTabsLook(page)).toEqual(NAMES.map(() => 'stacked'))
  // The new-item dot on やること and the accessible names stay.
  await expect(leftTab(page, /^やること/).locator('[data-new-dot]')).toBeVisible()
  await expect(page.getByRole('button', { name: /^探す$/ })).toBeVisible()

  // The narrow column at its minimum: still every name, no tab outside the column.
  const divider = page.getByRole('separator', { name: 'ファイルツリーとエディタの境目' })
  const d = (await divider.boundingBox())!
  await page.mouse.move(d.x + d.width / 2, d.y + 200)
  await page.mouse.down()
  await page.mouse.move(d.x - 500, d.y + 200, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await strip.boundingBox())!.width)).toBe(200)
  expect(await leftTabsLook(page)).toEqual(NAMES.map(() => 'stacked'))
  await page.screenshot({ path: 'test-results/left-tabs-narrow.png' })
  await strip.locator('button[title="探す"]').click()
  await expect(page.getByPlaceholder('覚えている言葉で探す')).toBeVisible()

  // スキル covers the whole left side: room for icon and name side by side.
  await strip.locator('button[title="スキル"]').click()
  expect(await leftTabsLook(page)).toEqual(NAMES.map(() => 'side by side'))
  await page.screenshot({ path: 'test-results/left-tabs-wide.png' })
  expectNoPageErrors(state)
})

// Owner FB #15: 「やることを左のチェックボックスからチェックして消した時、もしタブで開いていたら、そのタブも同時に消す」.
// The ☑ in the list completes the task and closes its tab — also inside a named group (まとまり) — and
// only its own: another task's tab, in the same group, stays.
test('checking a task off in the list closes its tab in the middle; another task’s tab (same named group) stays', async ({ page }) => {
  const TASK = 'acb-record:task-aaaaaa1'
  const OTHER = 'acb-record:task-row001'
  const state = await openPreview(page, 'skill-layout', { tasks: '1', check: '1', seed: JSON.stringify({
    'editor:demo': JSON.stringify({ openFiles: [OTHER, TASK], activeFilePath: TASK, leftTab: 'tasks', records: {
      'task-aaaaaa1': { title: 'A社 提案書を仕上げる', type: 'task' }, 'task-row001': { title: 'やること 2', type: 'task' },
    } }),
    'tabGroups:demo': JSON.stringify({ byKind: false, collapsedKinds: [], groups: [{ id: 'g1', name: '提案準備', color: 'rose' }], members: { [TASK]: 'g1', [OTHER]: 'g1' } }),
  }) })
  const tabs = middleTabs(page)
  await expect(tabs.getByRole('tab', { name: /A社 提案書を仕上げる/ })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.locator('[data-tab-group="提案準備"]')).toContainText('2')

  const list = page.getByRole('region', { name: 'やることの一覧' })
  await list.getByRole('button', { name: '「A社 提案書を仕上げる」を完了にする' }).click()
  await expect(tabs.getByRole('tab', { name: /A社 提案書を仕上げる/ })).toHaveCount(0)
  await expect(tabs.getByRole('tab', { name: /やること 2/ })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.locator('[data-tab-group="提案準備"]')).toContainText('1')
  const acts = await page.evaluate(() => (window as unknown as { __acbLayout: { calls: Array<{ name: string; args: unknown[] }> } }).__acbLayout.calls.filter(c => c.name === 'actOnTask').map(c => c.args))
  expect(acts).toEqual([['demo', 'task-aaaaaa1', { action: 'complete', expectedVersion: 2 }]])
  expectNoPageErrors(state)
})

// 「使う機能」 (owner decision 2026-11-07, records.md "Features on and off"): with the task list turned
// off, the small list 「確かめること」 takes its place; 今日の予定 and arrived minutes sit above it while
// 会議と議事録 is on. Catches the やること tab still shown, the small list missing or listing ordinary
// tasks, and 今日の予定 / minutes shown with 会議 off.
test('「使う機能」 the task list off: no やること tab; 「確かめること」 shows 今日の予定, the arrived minutes, then only what ACB alone can act on', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { features: 'listoff' })
  await expect(leftTab(page, /^確かめること/)).toBeVisible()
  // Before any panel is opened only the tab strip has buttons named so.
  await expect(page.getByRole('button', { name: /^やること/ })).toHaveCount(0)
  await leftTab(page, /^確かめること/).click()
  const panel = page.getByRole('region', { name: '確かめること' })
  await expect(panel.getByTestId('press-calendar').getByText('朝会')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'AI に読ませる' })).toBeVisible()
  const calendarTop = (await panel.getByTestId('press-calendar').boundingBox())!.y
  const listTop = (await panel.getByText('確かめること', { exact: true }).boundingBox())!.y
  expect(calendarTop).toBeLessThan(listTop)
  await expect(panel.getByText('金額の変更')).toBeVisible()
  await expect(panel.getByText('見積の下書きを確かめる')).toBeVisible()
  await expect(panel.getByText('値引きは10%まで')).toBeVisible()
  await expect(panel.getByText('ふつうのやること')).toHaveCount(0)
  expectNoPageErrors(state)
})

test('「使う機能」 会議と議事録 off too: 「確かめること」 has no 今日の予定 and no arrived minutes', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { features: 'listoff,meetingsoff' })
  await leftTab(page, /^確かめること/).click()
  const panel = page.getByRole('region', { name: '確かめること' })
  await expect(panel.getByText('金額の変更')).toBeVisible()
  await expect(panel.getByTestId('press-calendar')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'AI に読ませる' })).toHaveCount(0)
  expectNoPageErrors(state)
})

// Owner FB #29: 「カードの左上のボタンで完了にしたときも、真ん中のタブを閉じる」 — the card's own ［完了にする］
// closes its tab like the list's ☑ (#15); another task's tab stays.
test('completing a task with its card’s button closes its tab in the middle; another task’s tab stays', async ({ page }) => {
  const TASK = 'acb-record:task-aaaaaa1'
  const OTHER = 'acb-record:task-row001'
  const state = await openPreview(page, 'skill-layout', { tasks: '1', check: '1', seed: JSON.stringify({
    'editor:demo': JSON.stringify({ openFiles: [OTHER, TASK], activeFilePath: TASK, leftTab: 'tasks', records: {
      'task-aaaaaa1': { title: 'A社 提案書を仕上げる', type: 'task' }, 'task-row001': { title: 'やること 2', type: 'task' },
    } }),
  }) })
  const tabs = middleTabs(page)
  await expect(tabs.getByRole('tab', { name: /A社 提案書を仕上げる/ })).toHaveAttribute('aria-selected', 'true')
  const card = page.getByTestId('task-card')
  await card.getByRole('button', { name: '完了にする', exact: true }).click()
  await expect(tabs.getByRole('tab', { name: /A社 提案書を仕上げる/ })).toHaveCount(0)
  await expect(tabs.getByRole('tab', { name: /やること 2/ })).toHaveAttribute('aria-selected', 'true')
  const acts = await page.evaluate(() => (window as unknown as { __acbLayout: { calls: Array<{ name: string; args: unknown[] }> } }).__acbLayout.calls.filter(c => c.name === 'actOnTask').map(c => c.args))
  expect(acts).toEqual([['demo', 'task-aaaaaa1', { action: 'complete', expectedVersion: 2 }]])
  expectNoPageErrors(state)
})
