// Shoots the user manual's screenshots (scenes.ts) into manual/images/. Not a
// test: run it with `pnpm manual:shoot` (playwright.config.ts here), never in
// CI's UI job (whose config only reads tests/ui).
//
// Each shot is made the same way every time: fixed clock, time zone, locale,
// viewport and light theme (playwright.config.ts), fonts loaded, animations and
// the caret off. The annotations are an overlay added to the preview page just
// before the shot; the app's code knows nothing about them.
import { test, expect, type Locator, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectNoPageErrors, openPreview } from '../ui/helpers'
import { scenes, type Scene } from './scenes'

const IMAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../manual/images')
/** The clock every scene sees (relative dates such as 「3日前」 stay put). */
const NOW = new Date('2026-11-20T10:30:00+09:00')

/** One visible element, or the scene fails: a picture must not silently lose its subject. */
async function one(page: Page, selector: string): Promise<Locator> {
  const target = page.locator(selector).filter({ visible: true })
  await expect(target, `scene target ${selector}`).toHaveCount(1)
  return target
}

type Drawn = { kind: 'box' | 'marker'; x: number; y: number; width: number; height: number; label?: string; at?: string }

async function annotate(page: Page, scene: Scene): Promise<void> {
  const drawn: Drawn[] = []
  for (const a of scene.annotations ?? []) {
    const selector = a.box ?? a.marker?.target
    if (!selector) continue
    const box = await (await one(page, selector)).boundingBox()
    if (!box) throw new Error(`scene ${scene.id}: ${selector} has no box`)
    drawn.push(a.box ? { kind: 'box', ...box } : { kind: 'marker', ...box, label: a.marker!.label, at: a.marker!.at ?? 'top-left' })
  }
  await page.evaluate((items: Drawn[]) => {
    // Manual annotation colours (not app UI, so not design tokens).
    const RED = '#e5484d'
    const layer = document.createElement('div')
    layer.setAttribute('data-manual-annotations', '')
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
    const size = 24
    for (const item of items) {
      const el = document.createElement('div')
      if (item.kind === 'box') {
        const pad = 3
        el.style.cssText = `position:absolute;left:${item.x - pad}px;top:${item.y - pad}px;width:${item.width + pad * 2}px;height:${item.height + pad * 2}px;border:3px solid ${RED};border-radius:8px;box-sizing:border-box`
      } else {
        const midY = item.y + item.height / 2 - size / 2
        const [left, top] = item.at === 'left' ? [item.x - size - 6, midY]
          : item.at === 'right' ? [item.x + item.width + 6, midY]
            : item.at === 'below' ? [item.x + item.width / 2 - size / 2, item.y + item.height + 6]
              : [item.x - size / 2, item.y - size / 2]
        const clampedLeft = Math.max(2, Math.min(window.innerWidth - size - 2, left))
        const clampedTop = Math.max(2, Math.min(window.innerHeight - size - 2, top))
        el.textContent = item.label ?? ''
        el.style.cssText = `position:absolute;left:${clampedLeft}px;top:${clampedTop}px;width:${size}px;height:${size}px;border-radius:9999px;background:${RED};color:#fff;font:700 14px/${size}px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.35)`
      }
      layer.appendChild(el)
    }
    document.body.appendChild(layer)
  }, drawn)
}

async function clipFor(page: Page, scene: Scene) {
  if (!scene.crop) return undefined
  if ('region' in scene.crop) return scene.crop.region
  const box = await (await one(page, scene.crop.target)).boundingBox()
  if (!box) throw new Error(`scene ${scene.id}: crop target has no box`)
  const padding = scene.crop.padding ?? 16
  const pad = typeof padding === 'number' ? { x: padding, y: padding } : padding
  const viewport = page.viewportSize()!
  const x = Math.max(0, Math.floor(box.x - pad.x))
  const y = Math.max(0, Math.floor(box.y - pad.y))
  return {
    x, y,
    width: Math.min(viewport.width, Math.ceil(box.x + box.width + pad.x)) - x,
    height: Math.min(viewport.height, Math.ceil(box.y + box.height + pad.y)) - y,
  }
}

for (const scene of scenes) {
  test(scene.id, async ({ page }) => {
    if (scene.viewport) await page.setViewportSize(scene.viewport)
    await page.clock.setFixedTime(NOW)
    const state = await openPreview(page, scene.page, scene.query ?? {})
    await page.waitForLoadState('networkidle')
    for (const step of scene.steps ?? []) {
      if ('click' in step) await (await one(page, step.click)).click()
      else await one(page, step.waitFor)
    }
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready)
    // Hover and focus rings belong to the pointer, not the screen being explained.
    await page.mouse.move(0, 0)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const clip = await clipFor(page, scene)
    await annotate(page, scene)
    expectNoPageErrors(state)
    await page.screenshot({ path: path.join(IMAGES, `${scene.id}.png`), clip, animations: 'disabled', caret: 'hide' })
  })
}
