// The voice key (member-configurable; default ⌘⇧M) through chat.toggleVoiceInput
// (tests/voice-input-ui.tsx). The availability states are the page's other
// scenarios (smoke.spec.ts renders them).
import { test, expect, type Locator, type Page } from '@playwright/test'
import { openPreview } from './helpers'

// One key on every platform: Ctrl+Shift+M (the default is ⌘ on macOS, Ctrl elsewhere).
const KEY = 'Control+Shift+M'
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('acb.voice.shortcut', JSON.stringify({ code: 'KeyM', meta: false, ctrl: true, alt: false, shift: true })))
})

const startButton = (scope: Page | Locator) => scope.getByRole('button', { name: '音声入力を開始' })
const preparing = (scope: Page | Locator) => scope.getByText('マイクを準備中…')

test('the voice key starts voice input, and Esc cancels it', async ({ page }) => {
  await openPreview(page, 'voice-input', { scenario: 'healthy' })
  await expect(startButton(page)).toBeEnabled({ timeout: 10_000 })
  await page.keyboard.press(KEY)
  await expect(preparing(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(preparing(page)).toHaveCount(0)
  await expect(startButton(page)).toBeEnabled()
})

test('with two chat panes the voice key reaches only the pane used last', async ({ page }) => {
  await openPreview(page, 'voice-input', { panes: '2' })
  const left = page.getByRole('region', { name: '左の相談' })
  const right = page.getByRole('region', { name: '右の相談' })
  await expect(startButton(left)).toBeEnabled({ timeout: 10_000 })
  await expect(startButton(right)).toBeEnabled()

  await right.getByRole('textbox').click()
  await page.keyboard.press(KEY)
  await expect(preparing(right)).toBeVisible()
  await expect(preparing(left)).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(preparing(right)).toHaveCount(0)
  await left.getByRole('textbox').click()
  await page.keyboard.press(KEY)
  await expect(preparing(left)).toBeVisible()
  await expect(preparing(right)).toHaveCount(0)
})
