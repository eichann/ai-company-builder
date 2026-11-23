// 「使い方」 (the user manual, files-and-editor.md "The user manual") on the main screen
// (src/app/AppShell.tsx on skill-layout-ui.html): the title bar's button and ⌘K open one 使い方 tab in
// the middle, at the index; a screen's `help.openManual { page }` opens that page afresh; main's
// refusal is shown in the pane; ［書き出す］ asks main (which owns the save dialog) and says where it wrote.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Call = { name: string; args: unknown[] }
const calls = (page: Page, name: string) =>
  page.evaluate(n => (window as unknown as { __acbLayout: { calls: Call[] } }).__acbLayout.calls.filter(c => c.name === n).map(c => c.args), name)

test('the title bar\'s 使い方 opens one tab at the index; asking again for a page opens it afresh', async ({ page }) => {
  const state = await openPreview(page, 'skill-layout')
  await page.getByRole('button', { name: '使い方' }).click()
  const tab = page.getByRole('tab', { name: /使い方/ })
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('manual-area')).toContainText('プレビューでは使い方を表示しません（index）')
  expect(await calls(page, 'openManual')).toEqual([['index', null]])

  await page.getByRole('button', { name: '使い方' }).click()
  await expect(page.getByRole('tab', { name: /使い方/ })).toHaveCount(1)
  await expect.poll(() => calls(page, 'openManual')).toHaveLength(2)

  await page.getByRole('button', { name: '書き出す' }).click()
  await expect(page.getByTestId('manual-export-result')).toContainText('/Users/member/Downloads/ACB の使い方')
  expect(await calls(page, 'exportManual')).toEqual([[]])
  expectNoPageErrors(state)
})
