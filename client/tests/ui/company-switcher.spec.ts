// Switching company from the title bar (features/company: CompanySwitcher, useCompanySwitch,
// switching.ts) on the main screen's preview (tests/skill-layout-ui.tsx). Only a member of two or
// more companies sees it; a company this computer remembers reopens through the same checks as
// after sign-in; any other one goes to the selector; a running sync is waited for first.
import { test, expect, type Page } from '@playwright/test'
import { openPreview } from './helpers'

type Layout = {
  calls: Array<{ name: string; args: unknown[] }>
  session(): { user: string | null; company: string | null }
  companyToChoose(): string | null
  finishSync(): void
}
const layout = (page: Page) => page.evaluateHandle(() => (window as unknown as { __acbLayout: Layout }).__acbLayout)
const company = async (page: Page) => (await layout(page)).evaluate(l => l.session().company)
const calls = async (page: Page, name: string) => (await layout(page)).evaluate((l, n) => l.calls.filter(c => c.name === n).map(c => c.args), name)

const OTHER_ROOT = '/Users/demo/別会社'
/** What App.tsx remembers for a company opened on this computer before. */
const rememberedOther = JSON.stringify({ id: 'other', name: '別会社', rootPath: OTHER_ROOT, departments: [], createdAt: '2026-10-01T00:00:00.000Z' })

const switcher = (page: Page) => page.getByTitle('会社を切り替える')
const otherInMenu = (page: Page) => page.getByRole('menuitem', { name: '別会社' })

test('the switch is offered only to a member of two or more companies', async ({ page }) => {
  await openPreview(page, 'skill-layout', { companies: '1' })
  await expect(page.getByText('株式会社デモ', { exact: true })).toBeVisible()
  await expect.poll(() => calls(page, 'getCompanies')).not.toEqual([])
  await expect(switcher(page)).toHaveCount(0)

  await openPreview(page, 'skill-layout', { companies: '2' })
  await switcher(page).click()
  await expect(otherInMenu(page)).toBeVisible()
  // The company on screen is not offered.
  await expect(page.getByRole('menuitem', { name: '株式会社デモ' })).toHaveCount(0)
})

test('a company opened here before reopens through the normal checks; another goes to the selector', async ({ page }) => {
  await openPreview(page, 'skill-layout', { companies: '2', seed: JSON.stringify({ 'companyFolder:u_me:other': rememberedOther }) })
  await switcher(page).click()
  await otherInMenu(page).click()
  await expect.poll(() => company(page)).toBe('other')
  // As after sign-in (restore-company.ts): access asked of the server, the folder registered before it is looked at.
  expect(await calls(page, 'registerAllowedRoot')).toContainEqual([OTHER_ROOT])
  await expect(page.getByTitle('会社を切り替える')).toHaveText('別会社')

  // Nothing remembered for it: the selector opens with it chosen (its folder choice).
  await openPreview(page, 'skill-layout', { companies: '2' })
  await switcher(page).click()
  await otherInMenu(page).click()
  await expect.poll(() => company(page)).toBe(null)
  expect(await (await layout(page)).evaluate(l => l.companyToChoose())).toBe('other')
})

test('switching while a sync runs waits for it: the other company opens only after the sync has ended', async ({ page }) => {
  await openPreview(page, 'skill-layout', { companies: '2', sync: 'manual', seed: JSON.stringify({ 'companyFolder:u_me:other': rememberedOther }) })
  await page.getByRole('button', { name: 'サーバーと同期' }).click()
  await expect.poll(() => calls(page, 'gitSync')).toHaveLength(1)

  await switcher(page).click()
  await otherInMenu(page).click()
  await expect(page.getByText('同期の途中です')).toBeVisible()
  await page.getByRole('button', { name: '終わったら切り替える' }).click()
  await expect(page.getByRole('status').filter({ hasText: '同期が終わったら会社を切り替えます' })).toBeVisible()
  await page.waitForTimeout(600)
  expect(await company(page)).toBe('demo')
  expect(await calls(page, 'registerAllowedRoot')).toEqual([])

  await (await layout(page)).evaluate(l => l.finishSync())
  await expect.poll(() => company(page)).toBe('other')
})

test('not switching during a sync, or giving up the wait, keeps the company on screen', async ({ page }) => {
  await openPreview(page, 'skill-layout', { companies: '2', sync: 'manual', seed: JSON.stringify({ 'companyFolder:u_me:other': rememberedOther }) })
  await page.getByRole('button', { name: 'サーバーと同期' }).click()
  await switcher(page).click()
  await otherInMenu(page).click()
  await page.getByRole('button', { name: '切り替えない' }).click()

  await switcher(page).click()
  await otherInMenu(page).click()
  await page.getByRole('button', { name: '終わったら切り替える' }).click()
  await page.getByRole('button', { name: 'やめる' }).click()
  await (await layout(page)).evaluate(l => l.finishSync())
  await page.waitForTimeout(600)
  expect(await company(page)).toBe('demo')
})
