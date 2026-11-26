// Owner FB 2026-11-26: with the consultation pane narrow, the usage meter's 「66%」 was drawn over
// the model picker and the header shook left and right every frame (the narrow layout's tighter
// padding widened the measured content box past the breakpoint, which undid the narrow layout).
// Guards: at every width the header's controls never overlap and stay inside the header, the
// layout settles after a resize, and what gave way stays reachable through 「…」
// (src/features/chat/components/ChatHeader.tsx, hooks/useHeaderFit.ts).
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

const SCREENSHOTS = process.env.SCREENSHOTS

type Box = { name: string; left: number; right: number; top: number; bottom: number }

/** The header's controls (buttons and pickers), as drawn, plus the header's own box. */
async function controls(page: Page): Promise<{ header: Box; items: Box[] }> {
  return page.locator('header').first().evaluate(h => {
    const box = (e: Element, name: string) => { const r = e.getBoundingClientRect(); return { name, left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
    const items = [...h.querySelectorAll('button, select')]
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => box(e, e.getAttribute('aria-label') || e.getAttribute('title') || e.tagName))
    return { header: box(h, 'header'), items }
  })
}

/** The header's controls over several frames: one distinct layout means it has settled. */
async function layoutsOverFrames(page: Page, frames = 12): Promise<string[]> {
  return page.locator('header').first().evaluate(async (h, n) => {
    // A resize reaches the header through its observer and a render: give that two frames.
    for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r))
    const seen = new Set<string>()
    for (let i = 0; i < n; i++) {
      await new Promise(r => requestAnimationFrame(r))
      seen.add([...h.querySelectorAll('button, select')].map(e => { const r = e.getBoundingClientRect(); return `${e.getAttribute('aria-label') || e.tagName}@${Math.round(r.left)}+${Math.round(r.width)}` }).join(' '))
    }
    return [...seen]
  }, frames)
}

function expectNoOverlap({ header, items }: { header: Box; items: Box[] }) {
  for (const c of items) {
    expect(c.left, `${c.name} starts inside the header`).toBeGreaterThanOrEqual(header.left - 0.5)
    expect(c.right, `${c.name} ends inside the header`).toBeLessThanOrEqual(header.right + 0.5)
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j]
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      expect(overlap, `${a.name} and ${b.name} do not overlap`).toBeLessThanOrEqual(0.5)
    }
  }
}

async function closeNarrowList(page: Page) {
  // A narrow pane lays the consultation list over the chat; with it closed the header shows.
  const backdrop = page.getByRole('button', { name: 'AIへの相談の一覧を閉じる' })
  if (await backdrop.count()) {
    const b = (await backdrop.first().boundingBox())!
    await page.mouse.click(b.x + b.width - 4, b.y + 400)
  }
}

/** Sets the pane's width the way dragging its divider does: the header learns it by observation. */
async function resizePane(page: Page, width: number) {
  await page.locator('header').first().evaluate((h, w) => {
    let pane = h.parentElement
    while (pane && !pane.style.width) pane = pane.parentElement
    pane!.style.width = `${w}px`
  }, width)
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }) })

for (const width of [280, 300, 320, 360, 380, 400, 420, 440, 520, 560, 640, 720]) {
  test(`at ${width} px the header's controls never overlap and the layout holds still`, async ({ page }) => {
    const state = await openPreview(page, 'chat-header', { width: String(width) })
    await closeNarrowList(page)
    const banner = page.getByRole('banner')
    await expect(banner.getByRole('button', { name: /^利用上限:/ })).toBeVisible()
    if (SCREENSHOTS) {
      const h = (await page.locator('header').first().boundingBox())!
      await page.screenshot({ path: `${SCREENSHOTS}/chat-header-${width}.png`, clip: { x: h.x - 8, y: 0, width: h.width + 8, height: h.y + h.height + 8 } })
    }

    expect(await layoutsOverFrames(page), 'one layout over a dozen frames').toHaveLength(1)
    expectNoOverlap(await controls(page))
    // ＋, the list, settings and the model picker are always on the header itself.
    await expect(banner.getByRole('button', { name: '新しい相談' })).toBeVisible()
    await expect(banner.getByRole('button', { name: 'AIへの相談の一覧を開閉' })).toBeVisible()
    await expect(banner.getByRole('button', { name: '設定' })).toBeVisible()
    await expect(banner.getByRole('combobox', { name: 'モデル' })).toBeVisible()
    expectNoPageErrors(state)
  })
}

test('narrowing and widening the pane step by step: the header settles at each width without overlap', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { width: '760' })
  for (const width of [640, 560, 520, 470, 444, 440, 436, 420, 380, 360, 320, 290, 280, 360, 444, 520, 760]) {
    await resizePane(page, width)
    expect(await layoutsOverFrames(page), `one layout at ${width} px`).toHaveLength(1)
    expectNoOverlap(await controls(page))
  }
  expectNoPageErrors(state)
})

test('what gives way stays reachable: the effort, the Markdown toggle and the pop-out move into 「…」', async ({ page }) => {
  const state = await openPreview(page, 'chat-header', { width: '280' })
  await closeNarrowList(page)
  const banner = page.getByRole('banner')
  await expect(banner.getByRole('combobox', { name: '思考の強さ' })).toHaveCount(0)
  await banner.getByRole('button', { name: 'その他の操作' }).click()
  // The menu is drawn on the window, not clipped by the header's row.
  const plain = page.getByRole('button', { name: 'プレーン表示に切り替える' })
  await expect(plain).toBeVisible()
  const box = (await plain.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(1440)
  await page.getByRole('button', { name: '思考の強さ：High' }).click()
  await banner.getByRole('button', { name: 'その他の操作' }).click()
  await plain.click()
  await banner.getByRole('button', { name: 'その他の操作' }).click()
  await expect(page.getByRole('button', { name: '装飾表示に切り替える' })).toBeVisible()
  await page.keyboard.press('Escape')

  // The choices made in the menu are the header's own once there is room again.
  await resizePane(page, 760)
  await expect(banner.getByRole('button', { name: 'その他の操作' })).toHaveCount(0)
  await expect(banner.getByRole('combobox', { name: '思考の強さ' })).toHaveValue('high')
  await expect(banner.getByRole('button', { name: /プレーン表示中/ })).toBeVisible()
  expectNoPageErrors(state)
})

for (const width of [280, 360, 440, 640]) {
  test(`Codex: at ${width} px its two pickers and the buttons never overlap`, async ({ page }) => {
    const state = await openPreview(page, 'chat-header', { width: String(width), agent: 'codex' })
    await closeNarrowList(page)
    const banner = page.getByRole('banner')
    await expect(banner.getByRole('combobox', { name: 'Codexモデル' })).toBeVisible()
    expect(await layoutsOverFrames(page), 'one layout over a dozen frames').toHaveLength(1)
    expectNoOverlap(await controls(page))
    await expect(banner.getByRole('button', { name: '設定' })).toBeVisible()
    expectNoPageErrors(state)
  })
}

for (const width of [280, 400, 520]) {
  test(`at ${width} px a running turn's stop button and status fit too`, async ({ page }) => {
    const state = await openPreview(page, 'chat-header', { width: String(width) })
    await closeNarrowList(page)
    await page.locator('.cm-content[role="textbox"]').locator('visible=true').click()
    await page.keyboard.insertText('見積書を作って')
    await page.keyboard.press('Meta+Enter')
    const banner = page.getByRole('banner')
    await expect(banner.getByRole('button', { name: '停止' })).toBeVisible()
    expectNoOverlap(await controls(page))
    await expect(banner.getByRole('button', { name: '設定' })).toBeVisible()
    expectNoPageErrors(state)
  })
}
