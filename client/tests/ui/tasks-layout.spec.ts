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

  await leftTab(page, /^やること/).click()
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

  // Switching the left tab keeps the record tab open in the middle.
  await leftTab(page, /^ファイル$/).click()
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
