import { expect, type Page } from '@playwright/test'

/**
 * Opens a preview page (tests/<name>-ui.html) with the given query and fails
 * the test on any uncaught exception in the page — a component that throws
 * during render usually still shows *something*, so assertions alone can miss
 * it.
 */
export async function openPreview(page: Page, name: string, query: Record<string, string> = {}): Promise<{ errors: string[] }> {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const search = new URLSearchParams(query).toString()
  await page.goto(`/tests/${name}-ui.html${search ? `?${search}` : ''}`)
  await expect(page.locator('#root > *').first()).toBeAttached()
  return { errors }
}

/** No uncaught exception happened in the page so far. */
export function expectNoPageErrors(state: { errors: string[] }): void {
  expect(state.errors, 'uncaught exceptions in the page').toEqual([])
}
