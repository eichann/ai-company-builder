// Sizes, type and corners (design-system.md "Sizes, type and corners (P3, done)"): the shared Button's
// two sizes, every dialog's buttons, the switch, the tri-state check box, native check boxes and the
// settings' left list take their size, type, corner and colour from the tokens, in light and dark —
// no indigo left in them. Computed values are compared with what the token itself resolves to on the
// page (a probe element styled with the token), not with class names or fixed pixels.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Theme = 'light' | 'dark'

async function colour(page: Page, name: string): Promise<string> {
  const raw = await page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(`--color-${n}-rgb`).trim(), name)
  expect(raw, `--color-${name}-rgb is defined`).toMatch(/^\d+ \d+ \d+$/)
  return `rgb(${raw.split(' ').join(', ')})`
}
/** What `var(--name)` resolves to as `prop` on a probe element (px for lengths). */
async function tokenAs(page: Page, prop: string, name: string): Promise<string> {
  return page.evaluate(([p, n]) => {
    const probe = document.createElement('div')
    probe.style.setProperty(p, `var(--${n})`)
    document.body.appendChild(probe)
    const v = getComputedStyle(probe).getPropertyValue(p)
    probe.remove()
    return v
  }, [prop, name] as const)
}
const css = (el: Locator, prop: string) => el.evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop)
const box = async (el: Locator) => { const b = await el.boundingBox(); expect(b).not.toBeNull(); return b! }

async function open(page: Page, name: string, theme: Theme, query: Record<string, string> = {}) {
  const state = await openPreview(page, name, theme === 'dark' ? { ...query, theme } : query)
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
  return state
}

/** A button of `size`: height, side padding, type size and corner from the tokens. */
async function expectButtonSize(page: Page, button: Locator, size: 'md' | 'sm') {
  await expect(button).toBeVisible()
  const name = (await button.textContent())?.trim()
  const [h, pad, type] = size === 'md' ? ['size-control', 'padding-control-x', 'font-size-body'] : ['size-control-sm', 'padding-control-sm-x', 'font-size-small']
  expect(await css(button, 'height'), `「${name}」 height`).toBe(await tokenAs(page, 'height', h))
  expect(await css(button, 'padding-left'), `「${name}」 side padding`).toBe(await tokenAs(page, 'padding-left', pad))
  expect(await css(button, 'font-size'), `「${name}」 type`).toBe(await tokenAs(page, 'font-size', type))
  expect(await css(button, 'border-top-left-radius'), `「${name}」 corner`).toBe(await tokenAs(page, 'border-top-left-radius', 'radius-control'))
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test('the shared Button: md and sm sizes, the secondary colours from the tokens', async ({ page }) => {
      const state = await open(page, 'confirm-dialog', theme)
      await expectButtonSize(page, page.getByRole('button', { name: '下書きを保存' }), 'md')
      await open(page, 'download-folders', theme, { tab: 'ownkeys' })
      const register = page.getByRole('button', { name: /自分の鍵を登録|鍵を差し替える/ }).first()
      await expectButtonSize(page, register, 'sm')
      expect(await css(register, 'background-color'), 'secondary fill').toBe(await tokenAs(page, 'background-color', 'color-surface'))
      expect(await css(register, 'border-top-color'), 'secondary line').toBe(await colour(page, 'border-control'))
      expect(await css(register, 'color'), 'secondary text').toBe(await colour(page, 'text'))
      expectNoPageErrors(state)
    })

    test('dialog buttons: one size, 「やめる」 secondary and the main action primary', async ({ page }) => {
      const state = await open(page, 'confirm-dialog', theme, { open: 'ordinary' })
      const confirm = page.getByRole('dialog', { name: 'この版を公開しますか？' })
      const cancel = confirm.getByRole('button', { name: 'やめる' })
      await expectButtonSize(page, cancel, 'md')
      await expectButtonSize(page, confirm.getByRole('button', { name: '公開する' }), 'md')
      expect(await css(cancel, 'border-top-color'), 'cancel line').toBe(await colour(page, 'border-control'))

      await open(page, 'file-tree', theme)
      await page.getByRole('button', { name: 'README.md', exact: true }).click({ button: 'right' })
      await page.getByRole('button', { name: /^名前を変更/ }).click()
      const name = page.getByRole('dialog', { name: '名前を変更' })
      await expectButtonSize(page, name.getByRole('button', { name: 'キャンセル' }), 'md')
      await expectButtonSize(page, name.getByRole('button', { name: '名前を変更', exact: true }), 'md')
      expect(await css(name.getByRole('textbox'), 'border-top-left-radius'), 'name field corner').toBe(await tokenAs(page, 'border-top-left-radius', 'radius-control'))

      // A task dialog: its 「やめておく」 used to be a 20px-high chip beside a 30px main action.
      await open(page, 'private-folders', theme)
      await page.getByRole('button', { name: '新しいフォルダ…' }).click()
      const folder = page.getByRole('dialog', { name: '新しいフォルダ' })
      for (const b of await folder.locator('[data-dialog-footer] button').all()) await expectButtonSize(page, b, 'md')
      expectNoPageErrors(state)
    })

    test('switches: 36×20, on = primary, off = border-strong (the settings and 「自分の設定」 alike)', async ({ page }) => {
      const state = await open(page, 'download-folders', theme, { tab: 'mine' })
      const on = page.getByRole('switch', { name: 'AI が自動で進める' })
      const off = page.getByRole('switch', { name: '受信を読む' })
      await expect(on).toHaveAttribute('aria-checked', 'true')
      await expect(off).toHaveAttribute('aria-checked', 'false')
      for (const s of [on, off]) {
        const b = await box(s)
        expect(`${b.width}px`, 'switch width').toBe(await tokenAs(page, 'width', 'size-switch-w'))
        expect(`${b.height}px`, 'switch height').toBe(await tokenAs(page, 'height', 'size-switch-h'))
      }
      expect(await css(on, 'background-color'), 'on').toBe(await colour(page, 'primary'))
      expect(await css(off, 'background-color'), 'off').toBe(await colour(page, 'border-strong'))
      // The thumb sits inside the track at both ends.
      const thumbOn = await box(on.locator('span')), trackOn = await box(on)
      expect(thumbOn.x + thumbOn.width).toBeLessThanOrEqual(trackOn.x + trackOn.width)
      expect(thumbOn.x - trackOn.x).toBeGreaterThan(trackOn.width / 2 - thumbOn.width / 2)

      await open(page, 'download-folders', theme, { tab: 'autosync' })
      const auto = page.getByRole('switch', { name: '自動で受け取る' })
      expect(`${(await box(auto)).width}px`, 'the settings\' switch is the same one').toBe(await tokenAs(page, 'width', 'size-switch-w'))
      expectNoPageErrors(state)
    })

    test('the tri-state check box and native check boxes are "on" in the primary colour', async ({ page }) => {
      const state = await open(page, 'download-folders', theme)
      const checked = page.locator('[data-checkbox][aria-checked="true"]').first()
      const mixed = page.locator('[data-checkbox][aria-checked="mixed"]').first()
      const unchecked = page.locator('[data-checkbox][aria-checked="false"]:not([disabled])').first()
      for (const c of [checked, mixed]) {
        expect(await css(c, 'background-color'), 'checked fill').toBe(await colour(page, 'primary'))
        expect(await css(c, 'color'), 'check mark').toBe(await colour(page, 'on-primary'))
      }
      expect(await css(unchecked, 'border-top-color'), 'unchecked line (3:1)').toBe(await colour(page, 'border-strong'))
      const b = await box(checked)
      expect(`${b.width}px`).toBe(await tokenAs(page, 'width', 'size-checkbox'))
      expect(await css(checked, 'border-top-left-radius')).toBe(await tokenAs(page, 'border-top-left-radius', 'radius-small'))

      await open(page, 'approval-card', theme, { kind: 'create' })
      const native = page.getByRole('checkbox').first()
      expect(await css(native, 'accent-color'), 'native check box').toBe(await colour(page, 'primary'))
      expectNoPageErrors(state)
    })

    test('the settings\' left list: the chosen item raised, its icon selected-blue, no indigo; group names text-subtle', async ({ page }) => {
      const state = await open(page, 'download-folders', theme)
      const nav = page.getByRole('navigation', { name: '設定の項目' })
      const chosen = nav.locator('[aria-current="page"]')
      await expect(chosen).toHaveText('この PC に置くフォルダ')
      expect(await css(chosen, 'background-color'), 'chosen fill').toBe(await colour(page, 'surface-raised'))
      expect(await css(chosen.locator('span').first(), 'color'), 'chosen icon').toBe(await colour(page, 'selected-icon'))
      expect(await css(chosen, 'height'), 'item height').toBe(await tokenAs(page, 'height', 'size-control'))
      const other = nav.getByRole('button', { name: '自動同期' })
      expect(await css(other, 'color'), 'other item text').toBe(await colour(page, 'text-muted'))
      const group = nav.getByText('ファイルと同期', { exact: true })
      expect(await css(group, 'color'), 'group name').toBe(await colour(page, 'text-subtle'))
      expect(await css(group, 'font-size'), 'group name type').toBe(await tokenAs(page, 'font-size', 'font-size-caption'))
      expect(await css(nav.getByText('設定', { exact: true }), 'font-size'), 'title type').toBe(await tokenAs(page, 'font-size', 'font-size-title'))
      expectNoPageErrors(state)
    })
  })
}
