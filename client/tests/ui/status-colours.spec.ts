// Callouts and status badges (design-system.md "Callouts and status badges (P2b, done)"): each
// variant paints with its own token set (bg, border, text, icon) in light and dark — no palette
// colour or free opacity left; the three stopped states stay apart (a person stopped it: grey,
// a failure: red, awaiting approval: amber); the one new-item mark is the `unread` dot; and the
// real screens use them: the task card's failed run, the approval card awaiting approval, an own
// key an admin stopped, the bell's unread dot, the bell's 「閲覧のみ」 (was 「読むだけ」).
// Computed colours compared with the token's own value on <html>, not class names.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Theme = 'light' | 'dark'

async function token(page: Page, name: string): Promise<string> {
  const raw = await page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(`--color-${n}-rgb`).trim(), name)
  expect(raw, `--color-${name}-rgb is defined`).toMatch(/^\d+ \d+ \d+$/)
  return `rgb(${raw.split(' ').join(', ')})`
}
const style = (el: Locator, prop: 'backgroundColor' | 'borderTopColor' | 'color') => el.evaluate((n, p) => getComputedStyle(n)[p], prop)

/** bg, border and text of `box` are the set's; its first icon (svg) is the set's icon colour. */
async function expectSet(page: Page, box: Locator, set: { bg: string, border: string, text: string, icon?: string }, what: string) {
  await expect(box).toBeVisible()
  expect(await style(box, 'backgroundColor'), `${what}: background`).toBe(await token(page, set.bg))
  expect(await style(box, 'borderTopColor'), `${what}: border`).toBe(await token(page, set.border))
  expect(await style(box, 'color'), `${what}: text`).toBe(await token(page, set.text))
  if (set.icon) expect(await style(box.locator('svg').first(), 'color'), `${what}: icon`).toBe(await token(page, set.icon))
}
const sets = (name: string) => ({ bg: `${name}-bg`, border: `${name}-border`, text: `${name}-text`, icon: `${name}-icon` })

async function open(page: Page, name: string, theme: Theme, query: Record<string, string> = {}) {
  const state = await openPreview(page, name, theme === 'dark' ? { ...query, theme } : query)
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
  return state
}

const CALLOUT_SET: Record<string, string> = { info: 'info', warning: 'warning', danger: 'danger', success: 'success', offline: 'info', paused: 'paused', failed: 'failed', awaiting: 'awaiting' }
const BADGE_SET = ['info', 'success', 'warning', 'danger', 'paused', 'failed', 'awaiting', 'ai', 'selected', 'readonly']

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test('every callout tone and status badge variant paints with its own token set; the new-item dot is `unread`', async ({ page }) => {
      const state = await open(page, 'status', theme)
      for (const [tone, set] of Object.entries(CALLOUT_SET)) await expectSet(page, page.locator(`[data-callout="${tone}"]`), sets(set), `callout ${tone}`)
      for (const v of BADGE_SET) await expectSet(page, page.locator(`[data-badge="${v}"]`).first(), sets(v), `badge ${v}`)
      const neutral = page.locator('[data-badge="neutral"]')
      expect(await style(neutral, 'backgroundColor')).toBe(await token(page, 'surface-sunken'))
      expect(await style(neutral, 'color')).toBe(await token(page, 'text-muted'))
      expect(await style(page.getByRole('img', { name: '新着' }), 'backgroundColor')).toBe(await token(page, 'unread'))
      expectNoPageErrors(state)
    })

    test('the three stopped states are told apart: colour, icon and word', async ({ page }) => {
      await open(page, 'status', theme)
      const badges = ['paused', 'failed', 'awaiting'].map(v => page.locator(`[data-badge="${v}"]`))
      const fills = await Promise.all(badges.map(b => style(b, 'backgroundColor')))
      expect(new Set(fills).size, `fills ${fills.join(' / ')}`).toBe(3)
      const icons = await Promise.all(badges.map(b => b.locator('svg').innerHTML()))
      expect(new Set(icons).size, 'each stopped state has its own icon').toBe(3)
      await expect(badges[0]).toHaveText('止めています')
      await expect(badges[1]).toHaveText('止まりました')
      await expect(badges[2]).toHaveText('承認を待っています')
      // A person's stop is never the failure red, and nothing stopped is drawn in the danger set.
      expect(fills[0]).not.toBe(await token(page, 'danger-bg'))
    })

    test('the task card: a run that needs a person stopped on a failure (red, 「AI が止まりました」)', async ({ page }) => {
      await open(page, 'task-card', theme)
      const box = page.getByRole('region', { name: 'AI が止まりました' })
      await expect(box).toBeVisible()
      expect(await style(box, 'backgroundColor')).toBe(await token(page, 'failed-bg'))
      expect(await style(box, 'borderTopColor')).toBe(await token(page, 'failed-border'))
      // The reason line is the set's text and icon; the buttons under it keep the ordinary text colour.
      const reason = box.locator('p').first()
      expect(await style(reason, 'color')).toBe(await token(page, 'failed-text'))
      expect(await style(reason.locator('svg'), 'color')).toBe(await token(page, 'failed-icon'))
    })

    test('the approval card awaiting approval is amber (awaiting), not grey', async ({ page }) => {
      await open(page, 'approval-card', theme)
      const card = page.locator('[role="group"][aria-label="承認のお願い"][data-state="pending"]')
      await expect(card).toBeVisible()
      expect(await style(card, 'backgroundColor')).toBe(await token(page, 'awaiting-bg'))
      expect(await style(card, 'borderTopColor')).toBe(await token(page, 'awaiting-border'))
      expect(await style(card.locator('svg').first(), 'color')).toBe(await token(page, 'awaiting-icon'))
    })

    test('an own key an admin stopped: the grey 「止めています」 badge, not amber', async ({ page }) => {
      await open(page, 'download-folders', theme, { tab: 'ownkeys', ownkey: 'stopped' })
      const badge = page.getByText('自分の鍵（管理者が止めています）')
      await expectSet(page, badge, sets('paused'), 'stopped own key')
    })

    test('the bell: the unread dot is the new-item mark; its panel says 「閲覧のみ」, never 「読むだけ」', async ({ page }) => {
      await open(page, 'title-bar-notices', theme)
      const dot = page.getByTestId('notices-unread-dot')
      expect(await style(dot, 'backgroundColor')).toBe(await token(page, 'unread'))
      const bell = page.getByRole('button', { name: '起きたこと（未読 1 件）' })
      await expect(bell).toHaveAttribute('title', '起きたこと（閲覧のみ）')
      await bell.click()
      const list = page.getByRole('menu', { name: '起きたこと' })
      await expect(list).toContainText('閲覧のみ')
      await expect(page.locator('body')).not.toContainText('読むだけ')
      const unread = list.getByRole('img', { name: '未読' }).first()
      expect(await style(unread, 'backgroundColor')).toBe(await token(page, 'unread'))
    })
  })
}
