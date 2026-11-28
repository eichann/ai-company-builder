// The watch character (.claude/rules/watch.md, tests/watch-character-ui.tsx): every one of the
// preview's 100 members gets their own, its states move only without "reduce motion" (and stop
// with it), the small sizes leave the pattern and tool out, and it follows the theme.
import { test, expect, type Page } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

/** Running animations on the characters inside `selector`. */
const runningIn = (page: Page, selector: string) => page.evaluate(sel => document.getAnimations()
  .filter(a => a.playState === 'running' && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && a.effect.target.closest(sel))
  .length, selector)

test('the 100 members each get a different character, named as the watch', async ({ page }) => {
  const state = await openPreview(page, 'watch-character')
  const kids = page.getByTestId('kid')
  await expect(kids).toHaveCount(100)
  const drawings = await kids.evaluateAll(els => els.map(el => el.querySelector('svg')!.innerHTML.replace(/watch-clip-[A-Za-z0-9_-]+/g, '')))
  expect(new Set(drawings).size).toBe(100)
  await expect(kids.first().getByRole('img', { name: '見張り役' })).toBeVisible()
  expectNoPageErrors(state)
})

test('a state moves the character; with reduce motion nothing moves', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openPreview(page, 'watch-character')
  expect(await runningIn(page, '[data-testid="state-working"]')).toBeGreaterThan(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await expect(page.getByTestId('kid')).toHaveCount(100)
  for (const s of ['idle', 'noticed', 'thinking', 'working', 'done', 'stale']) {
    expect(await runningIn(page, `[data-testid="state-${s}"]`), s).toBe(0)
  }
  expect(await runningIn(page, 'main')).toBe(0)
  // The state still shows in the posture: the noticed one leans towards its words.
  const lean = await page.getByTestId('state-noticed').locator('svg').first().locator('.wc-g-lean').evaluate(el => getComputedStyle(el).transform)
  expect(lean).not.toBe('none')
})

test('at 32 px and under the pattern and the tool are left out', async ({ page }) => {
  await openPreview(page, 'watch-character')
  const parts = (size: number) => page.getByTestId(`size-${size}`).first().evaluate(el => ({
    pattern: el.querySelectorAll('g[clip-path]').length,
    item: el.querySelectorAll('.wc-g-item').length,
  }))
  for (const size of [16, 24, 32]) expect(await parts(size), `${size}px`).toEqual({ pattern: 0, item: 0 })
  for (const size of [64, 128]) expect(await parts(size), `${size}px`).toEqual({ pattern: 1, item: 1 })
})

test('stale closes the eyes in grey, noticed shows the dot; the colours follow the theme', async ({ page }) => {
  const look = (p: Page, s: string) => p.getByTestId(`state-${s}`).locator('svg').first().evaluate(svg => ({
    closed: getComputedStyle(svg.querySelector('.wc-g-closed')!).display,
    dot: getComputedStyle(svg.querySelector('.wc-dot')!).display,
    body: getComputedStyle(svg.querySelector('.wc-body')!).fill,
  }))
  await openPreview(page, 'watch-character')
  const idle = await look(page, 'idle')
  const stale = await look(page, 'stale')
  expect(idle.closed).toBe('none')
  expect(stale.closed).not.toBe('none')
  expect(stale.body).not.toBe(idle.body)
  expect((await look(page, 'noticed')).dot).not.toBe('none')
  expect(idle.dot).toBe('none')

  await openPreview(page, 'watch-character', { theme: 'dark' })
  expect((await look(page, 'idle')).body).not.toBe(idle.body)
})

test('「ほかの子にする」 gives another character and 「元の子に戻す」 the first one again', async ({ page }) => {
  await openPreview(page, 'watch-character')
  const chosen = () => page.getByTestId('chosen').locator('svg').evaluate(el => el.innerHTML.replace(/watch-clip-[A-Za-z0-9_-]+/g, ''))
  const first = await chosen()
  await page.getByRole('button', { name: 'ほかの子にする' }).click()
  expect(await chosen()).not.toBe(first)
  await page.getByRole('button', { name: '元の子に戻す' }).click()
  expect(await chosen()).toBe(first)
})
