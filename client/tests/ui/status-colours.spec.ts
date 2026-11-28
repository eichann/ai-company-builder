// Callouts and status badges (design-system.md "Callouts and status badges (P2b, done)"): each
// variant paints with its own token set (bg, border, text, icon) in light and dark — no palette
// colour or free opacity left; the three stopped states stay apart (a person stopped it: grey,
// a failure: red, awaiting approval: amber); the one new-item mark is the `unread` dot; and the
// real screens use them: the task card's failed run, the approval card awaiting approval, an own
// key an admin stopped, the bell's unread dot, the bell's 「閲覧のみ」 (was 「読むだけ」). 「止まっている」 the
// member has to act on is amber (owner decision 2026-11-22): a task row the AI cannot start, a switch
// the company stopped (and its refusal), the sync button while automatic sync waits, the editor's
// external-change banner with autosave paused.
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

    test('the title bar\'s ［受け箱］: 新着 a soft blue count, あなた待ち a soft red one (no solid pill); its rows\' dots the new-item mark, never 「読むだけ」', async ({ page }) => {
      await open(page, 'title-bar-notices', theme)
      const news = page.locator('[data-inbox-news]')
      expect(await style(news, 'backgroundColor')).toBe(await token(page, 'selected-bg'))
      expect(await style(news, 'color')).toBe(await token(page, 'selected-text'))
      const waiting = page.locator('[data-inbox-waiting]')
      expect(await style(waiting, 'backgroundColor')).toBe(await token(page, 'danger-bg'))
      expect(await style(waiting, 'color')).toBe(await token(page, 'danger-text'))
      await page.locator('[data-inbox-button]').click()
      const unread = page.getByRole('region', { name: '受け箱' }).getByRole('img', { name: '新着' }).first()
      expect(await style(unread, 'backgroundColor')).toBe(await token(page, 'unread'))
      await expect(page.locator('body')).not.toContainText('読むだけ')
    })

    test('stopped, and the member has something to do: amber (warning), never grey or red', async ({ page }) => {
      await open(page, 'status', theme)
      // The task row the AI cannot start (「AI では始められません」): the warning icon; a failed one stays red.
      expect(await style(page.getByRole('img', { name: 'AI では始められません' }), 'color')).toBe(await token(page, 'warning-icon'))
      expect(await style(page.getByRole('img', { name: 'AI が止まりました' }), 'color')).toBe(await token(page, 'failed-icon'))
      // The sync button while automatic sync waits for the member: its icon and mark in the warning colour.
      const sync = page.getByRole('button', { name: 'サーバーと同期（自動同期は止まっています）' })
      await expect(sync).toHaveAttribute('title', /自動同期は止まっています/)
      for (const icon of await sync.locator('svg').all()) expect(await style(icon, 'color')).toBe(await token(page, 'warning-icon'))
    })

    test('a switch the company stopped: an amber notice that an admin can help; its refusal is a warning, not an error', async ({ page }) => {
      await open(page, 'download-folders', theme, { tab: 'mine', company: 'off' })
      const notice = page.locator('[data-my-switch="readIncoming"] [data-company-off]')
      await expect(notice).toContainText('会社の設定で止まっています')
      await expect(notice).toContainText('管理者に相談')
      expect(await style(notice, 'color')).toBe(await token(page, 'warning-text'))
      expect(await style(notice.locator('svg'), 'color')).toBe(await token(page, 'warning-icon'))
      // The notice itself is not faded with the switch's words.
      expect(await notice.evaluate(n => getComputedStyle(n.closest('[data-my-switch]')!).opacity)).toBe('1')

      await open(page, 'download-folders', theme, { tab: 'mine', company: 'later' })
      await page.getByRole('switch', { name: '受信を読む' }).click()
      const refusal = page.locator('[data-callout]').filter({ hasText: '会社の設定で止まっています。管理者に確かめてください。' })
      await expect(refusal).toHaveAttribute('data-callout', 'warning')
      await expectSet(page, refusal, sets('warning'), 'company-off refusal')
    })

    test('the editor\'s 「自動保存は止めています」 banner is the warning set', async ({ page }) => {
      await open(page, 'editor-tabs', theme, { view: 'external' })
      const editor = page.locator('.cm-content[role="textbox"]')
      await expect(editor).toContainText('第12回の構成案です。')
      await editor.click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.insertText('\n私の追記')
      await page.getByTestId('external-edit').click()
      const banner = page.locator('[data-external-change]')
      await expect(banner).toContainText('自動保存は止めています')
      expect(await style(banner, 'backgroundColor')).toBe(await token(page, 'warning-bg'))
      expect(await style(banner, 'borderTopColor')).toBe(await token(page, 'warning-border'))
      expect(await style(banner, 'color')).toBe(await token(page, 'warning-text'))
      expect(await style(banner.locator('svg').first(), 'color')).toBe(await token(page, 'warning-icon'))
    })

    test('the left tabs\' count bubble and the chosen tab\'s underline are `primary`; a dragged divider\'s line too (P2d)', async ({ page }) => {
      await open(page, 'status', theme)
      const tabs = page.getByRole('region', { name: '左のタブ' })
      const count = tabs.locator('[data-left-tab="tasks"] [data-left-tab-name] + span')
      await expect(count).toHaveText('3')
      expect(await style(count, 'backgroundColor'), 'count bubble').toBe(await token(page, 'primary'))
      expect(await style(count, 'color'), 'count text').toBe(await token(page, 'on-primary'))
      const underline = (id: string) => tabs.locator(`[data-left-tab="${id}"]`).evaluate(n => getComputedStyle(n).borderBottomColor)
      expect(await underline('files'), 'chosen tab').toBe(await token(page, 'primary'))
      await tabs.locator('[data-left-tab="tasks"]').click()
      await expect.poll(() => underline('tasks')).toBe(await token(page, 'primary'))
      expect(await underline('files'), 'a tab not chosen has no line').toBe('rgba(0, 0, 0, 0)')

      const divider = page.getByRole('region', { name: '仕切り' }).locator('[role="separator"]')
      const box = (await divider.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + 40)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + 50)
      await expect.poll(() => style(divider, 'backgroundColor'), 'while dragged').toBe(await token(page, 'primary'))
      expect(await style(divider.locator('div').last(), 'backgroundColor'), 'its line').toBe(await token(page, 'primary'))
      await page.mouse.up()
    })
  })
}
