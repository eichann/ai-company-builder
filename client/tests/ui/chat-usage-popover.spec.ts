// Owner report: hovering the chat header's usage meter (5時間 / 1週間) showed nothing. The header
// clips its row to the pane (chat-narrow.spec.ts), and the details popover sat inside it. Guard:
// at a wide and at the narrowest pane the popover opens on hover and focus, is really painted
// (the topmost element at its centre), stays in the window, and closes on leave and Escape.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

async function closeNarrowList(page: Page) {
  // A narrow pane lays the consultation list over the chat; with it closed the header shows.
  const backdrop = page.getByRole('button', { name: 'AIへの相談の一覧を閉じる' })
  if (await backdrop.count()) {
    const b = (await backdrop.first().boundingBox())!
    await page.mouse.click(b.x + b.width - 4, b.y + 400)
  }
}

async function expectPainted(page: Page) {
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('5時間の枠')
  const box = (await tip.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  const hit = await tip.evaluate(el => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && el.contains(top)
  })
  expect(hit, 'the popover is the topmost element at its centre').toBe(true)
}

for (const width of [760, 290]) {
  test(`at ${width} px the usage meter's details show on hover and focus, unclipped`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const state = await openPreview(page, 'chat-header', { width: String(width) })
    await closeNarrowList(page)
    const meter = page.getByRole('banner').getByRole('button', { name: /^利用上限:/ })
    await expect(meter).toBeVisible()

    await meter.hover()
    await expectPainted(page)
    await expect(meter).toHaveAttribute('aria-describedby', await page.getByRole('tooltip').getAttribute('id') ?? '')
    await page.mouse.move(5, 890)
    await expect(page.getByRole('tooltip')).toHaveCount(0)

    await meter.focus()
    await expectPainted(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    expectNoPageErrors(state)
  })
}
