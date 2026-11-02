// Staging FB (1440×900): with the consultation pane narrow, the model picker 「Opus 5.5 ⌄」 floated
// left of the pane, over the middle's tab strip, hiding its last tab. Guard: whatever the pane's
// width, the header's controls stay inside the pane (src/features/chat/components/ChatHeader.tsx).
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

for (const width of [420, 360, 290]) {
  test(`at ${width} px the consultation's header keeps the model picker inside the pane`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const state = await openPreview(page, 'chat-header', { width: String(width) })
    // A narrow pane lays the consultation list over the chat; with it closed the header shows.
    const backdrop = page.getByRole('button', { name: 'AIへの相談の一覧を閉じる' })
    if (await backdrop.count()) {
      const b = (await backdrop.first().boundingBox())!
      await page.mouse.click(b.x + b.width - 4, b.y + 400)
    }
    const header = page.locator('header').first()
    await expect(header).toBeVisible()
    const pane = (await header.boundingBox())!
    const picker = page.locator('header select').first()
    await expect(picker).toBeVisible()
    const box = await picker.boundingBox()
    // The model picker stays in the header, whole, even at the pane's narrowest.
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(pane.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(pane.x + pane.width + 1)
    // Nothing of the header paints left of the pane.
    const left = await header.evaluate(h => Math.min(...[...h.querySelectorAll('*')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0).map(r => r.left)))
    expect(left).toBeGreaterThanOrEqual(pane.x - 1)
    await page.screenshot({ path: `test-results/chat-header-${width}.png` })
    expectNoPageErrors(state)
  })
}
