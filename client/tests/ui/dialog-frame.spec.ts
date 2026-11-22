// One dialog frame and the link / selected / AI colours (design-system.md "Dialog frames, link and
// selected (P2c, done)"). Every dialog moved onto `Dialog` draws the token scrim, surface, corner,
// shadow and 15px title in light and dark; its keys follow the confirm dialog's rules (Tab stays
// inside, Esc closes, focus returns). Text links read `link`, picked rows the `selected` set, the AI's
// prepared things the violet `ai` set. Computed colours against the tokens on <html>, not class names.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

type Theme = 'light' | 'dark'

const rootVar = (page: Page, name: string) => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
/** `rgb(r, g, b)` of a `--color-…-rgb` token in the current theme. */
async function token(page: Page, name: string): Promise<string> {
  const raw = await rootVar(page, `--color-${name}-rgb`)
  expect(raw, `--color-${name}-rgb is defined`).toMatch(/^\d+ \d+ \d+$/)
  return `rgb(${raw.split(' ').join(', ')})`
}
/** A colour token as the browser computes it (the scrim is rgba). */
const computedColour = (page: Page, value: string) => page.evaluate(v => {
  const el = document.createElement('div')
  el.style.color = v
  document.body.appendChild(el)
  const c = getComputedStyle(el).color
  el.remove()
  return c
}, value)
const css = (el: Locator, prop: string) => el.evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop)

async function open(page: Page, name: string, theme: Theme, query: Record<string, string> = {}) {
  const state = await openPreview(page, name, query)
  if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'))
  return state
}

/** The frame of an open dialog: scrim, surface, corner, shadow and its title's size, against the tokens. */
async function expectFrame(page: Page, dialog: Locator, { title }: { title?: Locator } = {}) {
  await expect(dialog).toBeVisible()
  const scrim = dialog.locator('xpath=..')
  expect(await css(scrim, 'background-color'), 'scrim').toBe(await computedColour(page, await rootVar(page, '--color-scrim')))
  expect(await css(dialog, 'background-color'), 'surface').toBe(await token(page, 'surface-raised'))
  expect(await css(dialog, 'border-top-left-radius'), 'corner').toBe(await rootVar(page, '--radius-card') || '12px')
  expect(await css(dialog, 'box-shadow'), 'shadow').toContain('24px 56px')
  expect(await dialog.getAttribute('aria-modal')).toBe('true')
  if (title) expect(await css(title, 'font-size'), 'title').toBe('15px')
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test('the confirm dialog and the name dialog share the frame; 「やめる」 left, the main action right', async ({ page }) => {
      const state = await open(page, 'confirm-dialog', theme, { open: 'ordinary' })
      const confirm = page.getByRole('dialog', { name: 'この版を公開しますか？' })
      await expectFrame(page, confirm, { title: confirm.getByRole('heading') })
      expect(await css(confirm, 'padding-top')).toBe('20px')
      expect(await confirm.locator('[data-dialog-footer] button').allTextContents()).toEqual(['やめる', '公開する'])

      await open(page, 'file-tree', theme)
      await page.getByRole('button', { name: 'README.md', exact: true }).click({ button: 'right' })
      await page.getByRole('button', { name: /^名前を変更/ }).click()
      const name = page.getByRole('dialog', { name: '名前を変更' })
      await expectFrame(page, name, { title: name.getByRole('heading', { name: '名前を変更' }) })
      await expect(name.getByRole('textbox')).toBeFocused()
      expect(await name.locator('[data-dialog-footer] button').allTextContents()).toEqual(['キャンセル', '作成'])
      expectNoPageErrors(state)
    })

    test('hand-made dialogs moved onto the frame: new folder, waiting for a reply, invite', async ({ page }) => {
      await open(page, 'private-folders', theme)
      await page.getByRole('button', { name: '新しいフォルダ…' }).click()
      const folder = page.getByRole('dialog', { name: '新しいフォルダ' })
      await expectFrame(page, folder, { title: folder.getByRole('heading', { name: '新しいフォルダ' }) })

      await open(page, 'task-card', theme, { task: 'todo-team' })
      await page.getByTestId('task-card').getByRole('button', { name: 'その他の操作' }).click()
      await page.getByRole('menuitem', { name: /返事待ちにする/ }).click()
      const wait = page.getByRole('dialog', { name: '返事待ちにしますか？' })
      await expectFrame(page, wait, { title: wait.getByRole('heading', { name: '返事待ちにしますか？' }) })
      expect(await wait.locator('[data-dialog-footer] button').allTextContents()).toEqual(['やめておく', '返事待ちにする'])

      await open(page, 'meetings', theme)
      await page.getByRole('button', { name: '定例ミーティングを開く' }).click()
      await page.getByTestId('record-card').getByRole('button', { name: '招待する' }).click()
      await expectFrame(page, page.getByRole('dialog', { name: '会議に人を招待する' }))
    })
  })
}

test('a moved dialog keeps the keyboard rules: Tab stays inside, Esc closes only it, focus returns to the opener', async ({ page }) => {
  const state = await openPreview(page, 'meetings')
  await page.getByRole('button', { name: '定例ミーティングを開く' }).click()
  const opener = page.getByTestId('record-card').getByRole('button', { name: '招待する' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: '会議に人を招待する' })
  await expect(dialog).toBeVisible()
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab')
    expect(await dialog.evaluate(d => d.contains(document.activeElement)), `focus inside after Tab ${i + 1}`).toBe(true)
  }
  // Past the last button Tab wraps to the first (×), and back.
  await dialog.getByRole('button', { name: 'やめる' }).focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: '閉じる' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('record-card')).toBeVisible() // Esc closed the dialog, not the card under it
  await expect(opener).toBeFocused()
  expectNoPageErrors(state)
})

test('focus returns to the opener when a field inside took focus at opening (autoFocus)', async ({ page }) => {
  await openPreview(page, 'private-folders')
  const opener = page.getByRole('button', { name: '新しいフォルダ…' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: '新しいフォルダ' })
  await expect(dialog.getByRole('textbox', { name: '名前' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('a scrim click closes an ordinary dialog but never a confirm', async ({ page }) => {
  await openPreview(page, 'meetings')
  await page.getByRole('button', { name: '定例ミーティングを開く' }).click()
  await page.getByTestId('record-card').getByRole('button', { name: '招待する' }).click()
  await page.mouse.click(640, 780)
  await expect(page.getByRole('dialog', { name: '会議に人を招待する' })).toHaveCount(0)

  await openPreview(page, 'confirm-dialog', { open: 'ordinary' })
  await page.mouse.click(640, 780)
  await expect(page.getByRole('dialog', { name: 'この版を公開しますか？' })).toBeVisible()
})

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme}: link, selected and AI`, () => {
    test('the file tree\'s chosen row is the selected fill; the task card\'s links are link; 「AI が用意したもの」 is the AI set', async ({ page }) => {
      await open(page, 'file-tree', theme)
      const row = page.getByRole('button', { name: 'README.md', exact: true })
      await row.click()
      // The tree sits on the grey side panel: its chosen row takes the stronger selected step.
      await expect.poll(() => css(row, 'background-color')).toBe(await token(page, 'selected-bg-hover'))

      await open(page, 'task-card', theme)
      const card = page.getByTestId('task-card')
      const link = card.getByRole('button', { name: /ファイル・フォルダをつなぐ/ })
      expect(await css(link, 'color'), 'a text link').toBe(await token(page, 'link'))
      const prepared = card.getByRole('region', { name: 'AI が用意したもの' })
      expect(await css(prepared, 'background-color'), 'AI box fill').toBe(await token(page, 'ai-bg'))
      expect(await css(prepared, 'border-top-color'), 'AI box line').toBe(await token(page, 'ai-border'))
      // Link and selected are separate names even where they share a blue today.
      expect(await token(page, 'link')).not.toBe(await token(page, 'selected-bg'))
    })
  })
}

test('dark mode links are the lighter link blue, not the old accent #1264a3 on a dark surface', async ({ page }) => {
  await open(page, 'task-card', 'dark')
  const link = page.getByTestId('task-card').getByRole('button', { name: /ファイル・フォルダをつなぐ/ })
  expect(await css(link, 'color')).toBe('rgb(108, 176, 234)')
})
