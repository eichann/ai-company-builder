// No new folder-level import cycles in the admin console (CLAUDE.md "App
// modules point one way too"; the app's and the server's equivalents are in
// client/tests/architecture-boundaries.test.ts and server/tests/unit/layering.test.ts).
// Only imports that name a value count: `import type` is erased at build.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

const SRC = resolve(__dirname, '../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : []
  })
}

/** Imports that name a value (static, side-effect, dynamic); `import type` and all-`type` lists are left out. */
function valueImportsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const typeOnly = (clause: string) => /^\s*type\s/.test(clause)
    || (/^\s*\{[^}]*\}\s*$/.test(clause) && clause.replace(/[{}]/g, '').split(',').map(n => n.trim()).filter(Boolean).every(n => /^type\s/.test(n)))
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\b([^'"]*?)from\s+['"]([^'"]+)['"]/g)].filter(m => !typeOnly(m[1])).map(m => m[2]),
    ...[...code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
  ]
}

/**
 * The folder a src/ file counts under: two levels (app/companies,
 * components/groups); a file in lib/ (flat) or directly in src/ is its own unit.
 */
const folderOf = (srcPath: string) => srcPath.replace(/\.tsx?$/, '').split('/').slice(0, 2).join('/')

/** Strongly connected groups of more than one node (Tarjan), each sorted, as 'a ⇄ b ⇄ c'. */
function cyclesIn(edges: Array<[from: string, to: string]>): string[] {
  const next = new Map<string, Set<string>>()
  for (const [a, b] of edges) if (a !== b) next.set(a, (next.get(a) ?? new Set()).add(b))
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const out: string[] = []
  const visit = (v: string) => {
    index.set(v, counter); low.set(v, counter); counter++
    stack.push(v); onStack.add(v)
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) !== index.get(v)) return
    const group: string[] = []
    let w: string
    do { w = stack.pop()!; onStack.delete(w); group.push(w) } while (w !== v)
    if (group.length > 1) out.push(group.sort().join(' ⇄ '))
  }
  for (const v of next.keys()) if (!index.has(v)) visit(v)
  return out.sort()
}

/** Cycles that exist today, as the sorted folders joined by ' ⇄ ': reason. None on 2026-11-09. */
const KNOWN_FOLDER_CYCLES: Record<string, string> = {}

describe('folder-level import cycles', () => {
  it('no new cycle between admin src/ folders (listed ones only shrink)', () => {
    const files = sourceFiles(SRC)
    const inTree = new Set(files.map(f => relative(SRC, f)))
    const resolveFile = (t: string) => [`${t}.ts`, `${t}.tsx`, `${t}/index.ts`, `${t}/index.tsx`, t].find(c => inTree.has(c))
    const edges: Array<[string, string]> = []
    for (const file of files) {
      for (const spec of valueImportsOf(readFileSync(file, 'utf8'))) {
        const t = spec.startsWith('@/') ? spec.slice(2)
          : spec.startsWith('.') ? relative(SRC, resolve(dirname(file), spec)) : null
        const to = t === null ? undefined : resolveFile(t)
        if (to) edges.push([folderOf(relative(SRC, file)), folderOf(to)])
      }
    }
    expect(edges.length, 'the check sees the imports (self-test)').toBeGreaterThan(200)
    const cycles = cyclesIn(edges)
    expect(cycles.filter(c => !(c in KNOWN_FOLDER_CYCLES)),
      'a folder now imports, directly or through others, a folder that imports it: point the dependency one way (move the shared part to lib/ or components/ui)')
      .toEqual([])
    expect(Object.keys(KNOWN_FOLDER_CYCLES).filter(c => !cycles.includes(c)),
      'a listed cycle is gone or changed: remove it from KNOWN_FOLDER_CYCLES')
      .toEqual([])
  })

  it('finds cycles through several folders and skips type-only imports (self-test)', () => {
    expect(cyclesIn([['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['e', 'f'], ['f', 'e']])).toEqual(['a ⇄ b ⇄ c', 'e ⇄ f'])
    expect(cyclesIn([['a', 'b'], ['b', 'c'], ['a', 'c']])).toEqual([])
    expect(valueImportsOf("import type { A } from './a'\nimport { type B } from './b'\nimport { type C, d } from '@/c'"))
      .toEqual(['@/c'])
    expect(folderOf('components/groups/groups-page.tsx')).toBe('components/groups')
    expect(folderOf('lib/api.ts')).toBe('lib/api')
  })
})
