// One primary colour (design-system.md "Primary actions (P2a, done)"): the shared Button's primary
// variant, a confirm's main action, the task card's main action and the mail card's buttons paint
// with the `primary` token set in light and dark — the old accent blue, indigo, blue-600 and black
// are gone. The two "proceed anyway" buttons that turned red in P1a are not danger-coloured.
// Computed colours compared with the token's own value on <html>, not class names.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Theme = 'light' | 'dark'

/** `rgb(r, g, b)` of a `--color-…-rgb` token as the page resolves it in the current theme. */
async function token(page: Page, name: string): Promise<string> {
  const raw = await page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(`--color-${n}-rgb`).trim(), name)
  expect(raw, `--color-${name}-rgb is defined`).toMatch(/^\d+ \d+ \d+$/)
  return `rgb(${raw.split(' ').join(', ')})`
}
const background = (el: Locator) => el.evaluate(n => getComputedStyle(n).backgroundColor)
const color = (el: Locator) => el.evaluate(n => getComputedStyle(n).color)

/** Fill and text are the primary set; hovering turns it primary-hover (after the colour transition). */
async function expectPrimary(page: Page, button: Locator, { hover = false } = {}) {
  await expect(button).toBeVisible()
  const name = (await button.textContent())?.trim()
  expect(await background(button), `「${name}」 fill`).toBe(await token(page, 'primary'))
  expect(await color(button), `「${name}」 text`).toBe(await token(page, 'on-primary'))
  if (hover) {
    const want = await token(page, 'primary-hover')
    await button.hover()
    await expect.poll(() => background(button), { message: `「${name}」 on hover` }).toBe(want)
  }
}

async function open(page: Page, name: string, theme: Theme, query: Record<string, string> = {}) {
  const state = await openPreview(page, name, theme === 'dark' ? { ...query, theme } : query)
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
  return state
}

test('the primary token is the owner\'s blue: #1264a3 light, #1b71b8 dark', async ({ page }) => {
  await open(page, 'confirm-dialog', 'light')
  expect(await token(page, 'primary')).toBe('rgb(18, 100, 163)')
  await open(page, 'confirm-dialog', 'dark')
  expect(await token(page, 'primary')).toBe('rgb(27, 113, 184)')
})

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test('the shared Button (primary) and an ordinary confirm\'s main action', async ({ page }) => {
      const state = await open(page, 'confirm-dialog', theme)
      await expectPrimary(page, page.getByRole('button', { name: '下書きを保存' }), { hover: true })
      await page.getByRole('button', { name: '公開…' }).click()
      await expectPrimary(page, page.getByRole('dialog', { name: 'この版を公開しますか？' }).getByRole('button', { name: '公開する' }))
      expectNoPageErrors(state)
    })

    test('the task card\'s main action', async ({ page }) => {
      await open(page, 'task-card', theme)
      await expectPrimary(page, page.getByRole('button', { name: '終わったので見てもらう' }), { hover: true })
    })

    test('the mail draft card\'s main action', async ({ page }) => {
      await open(page, 'mail-draft-card', theme)
      const card = page.getByRole('group', { name: 'メール：本日はありがとうございました' })
      await expectPrimary(page, card.getByRole('button', { name: '確かめて送る' }), { hover: true })
    })

    test('「.backups に保存して進める」 proceeds as the primary action, not as a danger', async ({ page }) => {
      await open(page, 'download-folders', theme, { state: 'confirm' })
      await page.getByRole('checkbox', { name: /開発部/ }).first().click()
      await page.getByRole('button', { name: '適用', exact: true }).click()
      const proceed = page.getByRole('alertdialog').getByRole('button', { name: '.backups に保存して進める' })
      await expectPrimary(page, proceed)
      expect(await background(proceed)).not.toBe(await token(page, 'danger'))
    })

    test('「それでも作成する」 is an ordinary button beside the dialog\'s primary 「作成」, not a danger', async ({ page }) => {
      await open(page, 'private-folders', theme, { state: 'outdated', role: 'admin' })
      await page.getByRole('button', { name: '新しいフォルダ…' }).click()
      const dialog = page.getByRole('dialog', { name: '新しいフォルダ' })
      await dialog.getByRole('textbox', { name: '名前' }).fill('面談')
      await dialog.getByRole('radio', { name: '非公開' }).click()
      await dialog.getByRole('button', { name: '非公開フォルダを作成' }).click()
      const anyway = dialog.getByRole('button', { name: 'それでも作成する' })
      await expect(anyway).toBeVisible()
      const fill = await background(anyway)
      expect(fill).not.toBe(await token(page, 'danger'))
      expect(fill).not.toBe(await token(page, 'primary'))
    })
  })
}
