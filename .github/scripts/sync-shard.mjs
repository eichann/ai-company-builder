#!/usr/bin/env node
// Prints the sync-harness test files (client/tests/sync/*.test.ts) of one CI
// shard, space-separated, relative to client/.
//
//   node .github/scripts/sync-shard.mjs <shard 1..N>
//
// The groups are balanced by measured duration (CI log of 2026-10-24, full
// soak): node's own `--test-shard` splits by file index, which put the two
// longest files (private-folders ~230 s, the soak ~195 s) on the same runner.
// The LAST shard also takes every file not named here, so a new test file is
// always run; a file named here that no longer exists fails the job instead
// of silently running nothing.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GROUPS = [
  ['private-folders.test.ts'],
  ['scenarios.test.ts', 'folder-exclusions.test.ts', 'large-files.test.ts'],
  ['partial-clone.test.ts', 'outside-checkout.test.ts', 'write-denied.test.ts', 'characterization.test.ts', 'findings.test.ts'],
  ['soak.test.ts'], // + everything not listed above (harness self-test, user hooks, new files)
]

const shard = Number(process.argv[2])
if (!Number.isInteger(shard) || shard < 1 || shard > GROUPS.length) {
  console.error(`usage: sync-shard.mjs <1..${GROUPS.length}>`)
  process.exit(2)
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'tests', 'sync')
const all = fs.readdirSync(dir).filter(f => f.endsWith('.test.ts')).sort()
const listed = GROUPS.flat()
const missing = listed.filter(f => !all.includes(f))
if (missing.length > 0) {
  console.error(`sync-shard.mjs names files that do not exist: ${missing.join(', ')}`)
  process.exit(1)
}

const files = shard === GROUPS.length
  ? [...GROUPS[shard - 1], ...all.filter(f => !listed.includes(f))]
  : GROUPS[shard - 1]
console.log(files.map(f => `tests/sync/${f}`).join(' '))
