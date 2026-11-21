// The confirm dialog's keyboard rules (design-system.md P1, tests/confirm-dialog-ui.tsx): a danger
// confirm starts on 「やめる」 so a reflex Enter never deletes, an ordinary one on its main action;
// Tab stays inside; Esc cancels only the top dialog; an Enter typed elsewhere (an IME conversion
// in the chat box) never confirms; focus goes back to what opened it. Danger actions everywhere
// are one red set, read out by role and name.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const answers = (page: Page) => page.evaluate(() => (window as unknown as { __acbLog: string[] }).__acbLog.slice())
const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.textContent ?? document.activeElement?.getAttribute('aria-label') ?? '')

test('danger confirm: an alertdialog named by its title and message, focus on やめる, Enter cancels, focus returns to the opener', async ({ page }) => {
  const state = await openPreview(page, 'confirm-dialog')
  const opener = page.getByRole('button', { name: 'フォルダを削除…' })
  await opener.click()
  const dialog = page.getByRole('alertdialog', { name: '「営業部の資料」を削除しますか？' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog).toHaveAccessibleDescription('中のファイル 12 個も消えます。元に戻せません。')
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused()
  // The red button is the danger one (one red set: bg-danger).
  await expect(dialog.getByRole('button', { name: '削除する' })).toHaveAttribute('data-variant', 'danger')
  expect(await dialog.getByRole('button', { name: '削除する' }).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(220, 38, 38)')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(await answers(page)).toEqual(['danger:cancel'])
  await expect(opener).toBeFocused()
  expectNoPageErrors(state)
})

test('ordinary confirm: a dialog (not an alert), focus on the main action, Enter presses it, focus returns', async ({ page }) => {
  await openPreview(page, 'confirm-dialog')
  const opener = page.getByRole('button', { name: '公開…' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'この版を公開しますか？' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '公開する' })).toBeFocused()
  await expect(dialog.getByRole('button', { name: '公開する' })).toHaveAttribute('data-variant', 'primary')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(await answers(page)).toEqual(['ordinary:confirm'])
  await expect(opener).toBeFocused()
})

test('Tab and Shift+Tab stay inside the dialog', async ({ page }) => {
  await openPreview(page, 'confirm-dialog')
  await page.getByRole('button', { name: 'フォルダを削除…' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: '削除する' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: '削除する' })).toBeFocused()
  // A click on the scrim does not take focus out either.
  await page.mouse.click(20, 400)
  expect(await focusedName(page)).toBe('削除する')
  await expect(dialog).toBeVisible()
  expect(await answers(page)).toEqual([])
})

test('Esc cancels', async ({ page }) => {
  await openPreview(page, 'confirm-dialog')
  await page.getByRole('button', { name: 'フォルダを削除…' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toBeHidden()
  expect(await answers(page)).toEqual(['danger:cancel'])
})

test('no Enter listener on the document confirms (a key typed elsewhere, IME included); a dialog that opens while typing (confirmOnEnter=false) ignores the next Enter', async ({ page }) => {
  await openPreview(page, 'confirm-dialog')
  const box = page.getByRole('textbox', { name: '相談の入力欄' })
  await box.click()
  // The member is converting かな→漢字 in the chat box when a confirm opens.
  await box.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'こうかい' })))
  await page.evaluate(() => (window as unknown as { __acbOpenLater: (w: string) => void }).__acbOpenLater('ordinary'))
  const dialog = page.getByRole('dialog', { name: 'この版を公開しますか？' })
  await expect(dialog).toBeVisible()
  // The Enter that commits the conversion (isComposing) reaches the page, wherever it lands.
  await page.evaluate(() => {
    const enter = () => new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })
    document.querySelector('textarea')!.dispatchEvent(enter())
    document.activeElement!.dispatchEvent(enter())
    document.dispatchEvent(enter())
  })
  await expect(dialog).toBeVisible()
  expect(await answers(page)).toEqual([])
  await page.keyboard.press('Escape')

  // A dialog that may open while the member types (confirmOnEnter off): focus lands on the
  // dialog itself, so the next real Enter presses nothing.
  await box.click()
  await page.evaluate(() => (window as unknown as { __acbOpenLater: (w: string) => void }).__acbOpenLater('typing'))
  const typing = page.getByRole('dialog', { name: 'つなぎますか？' })
  await expect(typing).toBeVisible()
  await expect(typing).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  await expect(typing).toBeVisible()
  expect(await answers(page)).toEqual(['ordinary:cancel'])
  await page.keyboard.press('Escape')
  await expect(box).toBeFocused()
})

test('stacked dialogs: only the top one answers Esc and holds focus; closing it returns focus to the one below', async ({ page }) => {
  await openPreview(page, 'confirm-dialog')
  await page.getByRole('button', { name: '重ねて開く' }).click()
  const top = page.getByRole('alertdialog', { name: 'ほかの画面に変更が残っています' })
  const below = page.getByRole('dialog', { name: 'この版を公開しますか？' })
  await expect(top.getByRole('button', { name: '戻る' })).toBeFocused()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab')
    expect(['戻る', '破棄する']).toContain(await focusedName(page))
  }
  await page.keyboard.press('Escape')
  await expect(top).toBeHidden()
  await expect(below).toBeVisible()
  expect(await answers(page)).toEqual(['stacked:cancel'])
  await expect(below.getByRole('button', { name: '公開する' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(below).toBeHidden()
  expect(await answers(page)).toEqual(['stacked:cancel', 'ordinary:cancel'])
})

test('danger menu items and the danger button use the one red (danger-text / bg-danger), not amber or rose', async ({ page }) => {
  await openPreview(page, 'confirm-dialog')
  const red = (sel: ReturnType<Page['locator']>, prop: 'color' | 'backgroundColor') => sel.evaluate((el, p) => getComputedStyle(el)[p], prop)
  const danger = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.className = 'text-danger-text bg-danger'
    document.body.append(probe)
    const s = getComputedStyle(probe)
    const out = { text: s.color, fill: s.backgroundColor }
    probe.remove()
    return out
  })
  expect(await red(page.getByRole('button', { name: '参加者から外す' }), 'backgroundColor')).toBe(danger.fill)

  await page.getByRole('button', { name: 'その他の操作' }).click()
  await expect(page.getByRole('menuitem', { name: /削除する/ })).toBeVisible()
  expect(await red(page.getByRole('menuitem', { name: /削除する/ }).locator('span').first(), 'color')).toBe(danger.text)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '右クリックのメニュー' }).click()
  expect(await red(page.getByRole('button', { name: '削除', exact: true }), 'color')).toBe(danger.text)
})
