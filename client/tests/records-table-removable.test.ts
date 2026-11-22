// 「記録の一覧」 is built to be thrown away easily (owner, 2026-11-22: not sure it is the right
// view). Its code lives in three places, and only the doors listed here reach into them, so
// removing the places plus those lines removes the feature (tasks-ui.md "The records table (B4)").
// A new import from anywhere else fails: hand what you need through the entry instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Each place of the feature, and the files outside it allowed to import it (with what they may import). */
const PLACES: Array<{ place: string; doors: Record<string, string[]> }> = [
  {
    place: 'src/features/records-table/',
    doors: {
      'src/app/AppShell.tsx': ['src/features/records-table/entry'], // the tab, ［表で見る］, ⌘K's handler
      'src/app/AppDialogs.tsx': ['src/features/records-table/entry'], // ⌘K's entry
      'tests/records-table-ui.tsx': ['src/features/records-table/entry'], // the preview page
    },
  },
  {
    place: 'electron/features/records-table/',
    doors: {
      'electron/main.ts': ['electron/features/records-table/ipc'],
      'tests/records-table.test.ts': ['electron/features/records-table/ipc'],
    },
  },
  {
    place: 'shared/records-table',
    doors: {
      'shared/ipc-contract.ts': ['shared/records-table'],
      'electron/preload.ts': ['shared/records-table'],
      'tests/records-table.test.ts': ['shared/records-table'],
      'tests/records-table-ui.tsx': ['shared/records-table'],
    },
  },
]
// The feature's own files may import each other.
const OWN = ['src/features/records-table/', 'electron/features/records-table/', 'shared/records-table']

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' || name.startsWith('dist') ? [] : files(p)
    return /\.tsx?$/.test(name) ? [p] : []
  })
}

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

/** Client-relative targets of a file's relative imports (extension dropped). */
function importsOf(file: string): string[] {
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  return [...code.matchAll(IMPORT)].map(m => m[1] ?? m[2])
    .filter(spec => spec.startsWith('.'))
    .map(spec => relative(CLIENT, resolve(dirname(file), spec)).replace(/\.tsx?$/, ''))
}

function strayImports(edges: Array<[from: string, to: string]>): string[] {
  const out: string[] = []
  for (const [from, to] of edges) {
    if (OWN.some(o => from.startsWith(o))) continue
    for (const { place, doors } of PLACES) {
      if (!to.startsWith(place)) continue
      if (!(doors[from] ?? []).includes(to)) out.push(`${from} -> ${to}`)
    }
  }
  return out
}

test('nothing outside 「記録の一覧」 reaches into it except its listed doors', () => {
  const all = ['src', 'electron', 'shared', 'tests', 'connectors'].flatMap(d => files(join(CLIENT, d)))
  const edges = all.flatMap(f => importsOf(f).map(t => [relative(CLIENT, f), t] as [string, string]))
  assert.deepEqual(strayImports(edges), [], 'import the feature only through its entry from the listed files (tasks-ui.md "The records table (B4)")')
  // Every door is still used: a door no longer needed is removed from the list (and the rule).
  for (const { doors } of PLACES) {
    for (const [from, targets] of Object.entries(doors)) {
      for (const t of targets) assert.ok(edges.some(([f, to]) => f === from && to === t), `${from} no longer imports ${t}: update the list`)
    }
  }
})

test('the check sees a stray import (self-test)', () => {
  assert.deepEqual(strayImports([
    ['src/features/tasks/components/TaskListPanel.tsx', 'src/features/records-table/entry'],
    ['src/app/AppShell.tsx', 'src/features/records-table/tableState'],
    ['src/app/AppShell.tsx', 'src/features/records-table/entry'],
    ['src/features/records-table/entry', 'src/features/records-table/tableState'],
    ['electron/features/record-views/ipc.ts', 'shared/records-table'],
  ]), [
    'src/features/tasks/components/TaskListPanel.tsx -> src/features/records-table/entry',
    'src/app/AppShell.tsx -> src/features/records-table/tableState',
    'electron/features/record-views/ipc.ts -> shared/records-table',
  ])
})
