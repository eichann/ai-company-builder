// Shared helpers for the performance baselines (tests/perf/*.perf.test.ts).
//
// Each check prints one `[perf] <name>=<value> <unit> (budget <budget>)` line
// so the CI job log keeps the measured values, then fails when the value is
// over its budget. Budgets are about 10x what a developer Mac measures: CI
// runners vary a lot, so these catch order-of-magnitude regressions (a cap
// that stopped capping, a cache that stopped caching), not small drifts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function budget(name: string, value: number, unit: string, max: number): void {
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(2)
  console.log(`[perf] ${name}=${shown} ${unit} (budget ${max} ${unit})`)
  assert.ok(value <= max, `${name}: ${shown} ${unit} is over the budget of ${max} ${unit}`)
}

/** Wall time of `fn` in milliseconds. */
export async function timeMs<T>(fn: () => T | Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now()
  const value = await fn()
  return { ms: performance.now() - start, value }
}

/** A scratch directory under the OS temp dir (realpath: macOS /var → /private/var). */
export function scratch(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acb-perf-${prefix}-`)))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/**
 * A company-like tree: `departments` folders × `subfolders` each × `files`
 * files per sub-folder (default 30 × 10 × 50 = 15,000 files).
 */
export function generateCompanyTree(
  root: string,
  opts: { departments?: number; subfolders?: number; files?: number; content?: (d: number, s: number, f: number) => string } = {},
): number {
  const departments = opts.departments ?? 30
  const subfolders = opts.subfolders ?? 10
  const files = opts.files ?? 50
  let n = 0
  for (let d = 0; d < departments; d++) {
    for (let s = 0; s < subfolders; s++) {
      const dir = path.join(root, `部署${String(d).padStart(2, '0')}`, `フォルダ${String(s).padStart(2, '0')}`)
      fs.mkdirSync(dir, { recursive: true })
      for (let f = 0; f < files; f++) {
        fs.writeFileSync(path.join(dir, `メモ${String(f).padStart(3, '0')}.md`), opts.content?.(d, s, f) ?? `# ${d}-${s}-${f}\n`)
        n++
      }
    }
  }
  return n
}
