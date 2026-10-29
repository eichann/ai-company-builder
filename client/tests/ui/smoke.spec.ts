// Every preview page renders without an uncaught exception: in the dark theme
// where it offers one, and in the light theme where no spec of its own opens
// it. Catches a component that throws on mount (an import cycle, a hook
// order change, a context a split forgot to provide) on pages that have no
// deeper spec of their own (handoff, voice input, consultation reference).
// No pixel snapshots: fonts and antialiasing differ between machines, and the
// specs assert what the member sees through the DOM instead.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectNoPageErrors, openPreview } from './helpers'

const pages = fs.readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  .filter(name => name.endsWith('-ui.html'))
  .map(name => name.replace(/-ui\.html$/, ''))
  .sort()
// Pages that read ?theme=dark.
const themed = new Set(['chat-composer', 'chat-header', 'choice-prompt', 'doc-review', 'download-folders', 'editor-tabs', 'private-folders', 'voice-prompt'])
// Pages whose light theme a spec of their own already opens.
const specified = new Set(['chat-composer', 'chat-header', 'choice-prompt', 'doc-review', 'download-folders', 'editor-tabs', 'private-folders', 'skill-layout', 'tool-rows'])

for (const name of pages) {
  const themes = [...(specified.has(name) ? [] : ['light' as const]), ...(themed.has(name) ? ['dark' as const] : [])]
  for (const theme of themes) {
    test(`${name} (${theme}) renders without errors`, async ({ page }) => {
      const state = await openPreview(page, name, theme === 'dark' ? { theme } : {})
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
      expect((await page.locator('#root').innerText()).trim().length).toBeGreaterThan(0)
      // Let effects and first fetches settle before checking for errors.
      await page.waitForLoadState('networkidle')
      expectNoPageErrors(state)
    })
  }
}

test('tool rows: a 980-tool turn keeps the DOM bounded in the browser', async ({ page }) => {
  // tests/tool-rows-ui.tsx replays the turn that froze the chat; tool-rows.test.ts
  // pins the grouping, this pins that MessageParts still renders it bounded.
  const state = await openPreview(page, 'tool-rows')
  const result = await page.waitForFunction(() => (window as unknown as { __toolRowsResult?: { tools: number; maxButtonsInDom: number } }).__toolRowsResult, null, { timeout: 25_000 })
  const { tools, maxButtonsInDom } = await result.jsonValue() as { tools: number; maxButtonsInDom: number }
  expect(tools).toBe(980)
  expect(maxButtonsInDom).toBeLessThan(60)
  expectNoPageErrors(state)
})
