// 「会議のあと」 (4b-4 PR6-A) is built to be thrown away easily (owner memo 「4b-4 挟む部分」 H-9 A, 2026-11-24: 「作りは簡単に
// 変えたり捨てられるように」). Its code lives in three places, and only the doors listed here reach into them, so removing the
// places plus those lines removes the feature (jobs.md "The 4b-4 screens (PR6-A)").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Each place of the feature, and the files outside it allowed to import it (with what they may import). */
const PLACES: Array<{ place: string; doors: Record<string, string[]> }> = [
  {
    place: 'src/features/after-meeting/',
    doors: {
      'src/app/AppShell.tsx': ['src/features/after-meeting/entry'], // under a job's やること, with the company's switch
      'tests/after-meeting-ui.tsx': ['src/features/after-meeting/entry'], // the preview page
    },
  },
  {
    place: 'electron/features/after-meeting/',
    doors: {
      'electron/main.ts': ['electron/features/after-meeting/ipc'],
      'tests/after-meeting.test.ts': ['electron/features/after-meeting/ipc'],
    },
  },
  {
    place: 'shared/after-meeting',
    doors: {
      'shared/ipc-contract.ts': ['shared/after-meeting'],
      'electron/preload.ts': ['shared/after-meeting'],
      'tests/after-meeting.test.ts': ['shared/after-meeting'],
      'tests/after-meeting-ui.tsx': ['shared/after-meeting'],
    },
  },
]
// The feature's own files may import each other.
const OWN = ['src/features/after-meeting/', 'electron/features/after-meeting/', 'shared/after-meeting']

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

test('nothing outside 「会議のあと」 reaches into it except its listed doors', () => {
  const all = ['src', 'electron', 'shared', 'tests', 'connectors'].flatMap(d => files(join(CLIENT, d)))
  const edges = all.flatMap(f => importsOf(f).map(t => [relative(CLIENT, f), t] as [string, string]))
  assert.deepEqual(strayImports(edges), [], 'import the feature only through its entry from the listed files (jobs.md "The 4b-4 screens (PR6-A)")')
  // Every door is still used: a door no longer needed is removed from the list (and the rule).
  for (const { doors } of PLACES) {
    for (const [from, targets] of Object.entries(doors)) {
      for (const t of targets) assert.ok(edges.some(([f, to]) => f === from && to === t), `${from} no longer imports ${t}: update the list`)
    }
  }
})

// The channel and its preload method by name: a leftover mention (a fake, a hand-written call) outside
// these files (and the feature's own places) would outlive a removal unnoticed.
const CHANNEL_NAMES = /afterMeeting:(?:read|note)|readAfterMeeting|noteAfterMeeting/
const CHANNEL_FILES = new Set([
  'shared/ipc-contract.ts', 'electron/preload.ts',
  'tests/ipc-harness/ipc-inventory.txt', 'tests/ipc-path-guard.test.ts', 'tests/after-meeting-ui.tsx', 'tests/after-meeting-removable.test.ts',
])

function textFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' || name.startsWith('dist') || name === 'test-results' ? [] : textFiles(p)
    return /\.(tsx?|mjs|cjs|js|txt|json|html)$/.test(name) ? [p] : []
  })
}

test('the channel\'s name appears only in the listed files', () => {
  const found = ['src', 'electron', 'shared', 'tests', 'connectors', 'scripts'].flatMap(d => textFiles(join(CLIENT, d)))
    .map(f => relative(CLIENT, f))
    .filter(f => !OWN.some(o => f.startsWith(o)))
    .filter(f => CHANNEL_NAMES.test(readFileSync(join(CLIENT, f), 'utf8')))
  assert.deepEqual(found.filter(f => !CHANNEL_FILES.has(f)), [], 'remove the leftover mention, or list the file with the rule\'s removal steps')
  for (const f of CHANNEL_FILES) assert.ok(found.includes(f), `${f} no longer names the channel: update the list`)
})

test('the check sees a stray import (self-test)', () => {
  assert.deepEqual(strayImports([
    ['src/features/tasks/components/TaskCard.tsx', 'src/features/after-meeting/entry'],
    ['src/app/AppShell.tsx', 'src/features/after-meeting/model'],
    ['src/app/AppShell.tsx', 'src/features/after-meeting/entry'],
    ['src/features/after-meeting/entry', 'src/features/after-meeting/model'],
    ['electron/features/jobs/ipc.ts', 'shared/after-meeting'],
  ]), [
    'src/features/tasks/components/TaskCard.tsx -> src/features/after-meeting/entry',
    'src/app/AppShell.tsx -> src/features/after-meeting/model',
    'electron/features/jobs/ipc.ts -> shared/after-meeting',
  ])
})
