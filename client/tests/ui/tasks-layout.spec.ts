// The やること tab on the main screen (src/app/AppShell.tsx, tests/skill-layout-ui.html?tasks=1)
// with the consultation open: it takes the left side the way ファイル does — the list runs from
// the tab strip to the bottom of the window and the consultation stays the pane on the right,
// never stacked under a strip of the list; an opened task's card gets the editor area a file
// opens in (at least as wide), not a strip squeezed between the list and the consultation. The
// list's own behaviour: tasks-list.spec.ts.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const chatDivider = (page: Page) => page.getByRole('separator', { name: '左の欄とチャットの境目' })
// The tab strip comes first; a task row's name may start with 「やること」 too.
const leftTab = (page: Page, name: RegExp) => page.getByRole('button', { name }).first()
const box = async (locator: Locator) => {
  const b = (await locator.boundingBox())!
  return { left: Math.round(b.x), top: Math.round(b.y), right: Math.round(b.x + b.width), bottom: Math.round(b.y + b.height) }
}

test('the やること tab fills the left side beside the consultation, where ファイル sits', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout', { tasks: '1' })
  const window = page.viewportSize()!

  await leftTab(page, /^ファイル$/).click()
  await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible()
  const filesDivider = await box(chatDivider(page))
  // The consultation is the pane right of the divider, down to the bottom of the window.
  expect(filesDivider.bottom).toBe(window.height)
  // Where a file opens: between the file tree's divider and the consultation.
  const treeDivider = await box(page.getByRole('separator', { name: 'ファイルツリーとエディタの境目' }))
  const editorWidth = filesDivider.left - treeDivider.right

  await leftTab(page, /^やること/).click()
  const list = page.getByRole('region', { name: 'やることの一覧' })
  await expect(list.getByText('A社 提案書を仕上げる')).toBeVisible()
  // The consultation stays where it was for ファイル.
  expect(await box(chatDivider(page))).toEqual(filesDivider)
  // The list starts under the tab strip and runs to the bottom, left of the divider.
  const tabs = await box(leftTab(page, /^やること/))
  const listBox = await box(list)
  expect(listBox.top).toBeLessThanOrEqual(tabs.bottom + 2)
  expect(listBox.bottom).toBe(window.height)
  expect(listBox.right).toBeLessThanOrEqual(filesDivider.left)

  // An opened task's card sits beside the list, in the same column height.
  await list.getByText('A社 提案書を仕上げる').click()
  const card = page.getByText('関係するファイル').or(page.getByText('A社_提案.md')).first()
  await expect(card).toBeVisible()
  const cardBox = await box(card)
  expect(cardBox.left).toBeGreaterThanOrEqual(listBox.right)
  expect(cardBox.right).toBeLessThanOrEqual(filesDivider.left)
  expect(cardBox.top).toBeGreaterThanOrEqual(listBox.top)
  const area = await box(page.getByTestId('task-card-area'))
  expect(area.right - area.left).toBeGreaterThanOrEqual(editorWidth - 2) // rounding of the boxes
  // 「＋ファイルをつなぐ」 is not cut off by the consultation.
  const linkFile = await box(page.getByRole('button', { name: /ファイルをつなぐ/ }))
  expect(linkFile.right).toBeLessThanOrEqual(filesDivider.left)

  // 検索 takes the same place.
  await leftTab(page, /^検索$/).click()
  expect(await box(chatDivider(page))).toEqual(filesDivider)
  expectNoPageErrors(state)
})
