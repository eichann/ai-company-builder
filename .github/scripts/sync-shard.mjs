#!/usr/bin/env node
// Runs one CI shard of the sync harness (client/tests/sync/*.test.ts).
//
//   node .github/scripts/sync-shard.mjs <shard 1..4>          # run it
//   node .github/scripts/sync-shard.mjs <shard 1..4> --list   # print its files
//
// The groups are balanced by measured duration (CI logs of 2026-10-24): node's
// own `--test-shard` splits by file index, which leaves the longest file
// (private-folders, ~260 s alone) on one runner. That file is split in two
// with SYNC_HARNESS_PART (`<file>#k/n`; see the file). The LAST shard also
// takes every file not named here, so a new test file always runs; a file
// named here that no longer exists fails the job instead of silently running
// nothing.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `soak.test.ts@<worlds>` runs only those soak worlds (plain, mixed, private):
// the others get their seed list set to `none`, the rest of the soak settings
// come from the workflow. Measured on main (full soak, 2026-10-24): plain ~70 s,
// mixed ~120 s, private ~112 s — so plain moves to shard 2.
const GROUPS = [
  ['private-folders.test.ts#1/2', 'folder-exclusions.test.ts', 'characterization.test.ts'],
  ['private-folders.test.ts#2/2', 'scenarios.test.ts', 'findings.test.ts', 'soak.test.ts@plain'],
  ['partial-clone.test.ts', 'outside-checkout.test.ts', 'write-denied.test.ts', 'large-files.test.ts'],
  // + every file not listed above (harness self-test, user hooks, new files).
  // The two heavier soak worlds run one after another, so nothing else long
  // goes here.
  ['soak.test.ts@mixed,private'],
]
const SOAK_WORLD_SEEDS = { plain: 'SYNC_SOAK_SEEDS', mixed: 'SYNC_SOAK_MIXED_SEEDS', private: 'SYNC_SOAK_PRIVATE_SEEDS' }

const shard = Number(process.argv[2])
if (!Number.isInteger(shard) || shard < 1 || shard > GROUPS.length) {
  console.error(`usage: sync-shard.mjs <1..${GROUPS.length}> [--list]`)
  process.exit(2)
}

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')
const all = fs.readdirSync(path.join(clientDir, 'tests', 'sync')).filter(f => f.endsWith('.test.ts')).sort()
const fileOf = entry => entry.split(/[#@]/)[0]
const listed = new Set(GROUPS.flat().map(fileOf))
const missing = [...listed].filter(f => !all.includes(f))
if (missing.length > 0) {
  console.error(`sync-shard.mjs names files that do not exist: ${missing.join(', ')}`)
  process.exit(1)
}

const entries = shard === GROUPS.length
  ? [...GROUPS[shard - 1], ...all.filter(f => !listed.has(f))]
  : GROUPS[shard - 1]
const parts = [...new Set(entries.filter(e => e.includes('#')).map(e => e.split('#')[1]))]
if (parts.length > 1) {
  console.error('sync-shard.mjs: one shard can run only one SYNC_HARNESS_PART')
  process.exit(1)
}
const files = [...new Set(entries.map(e => `tests/sync/${fileOf(e)}`))]

console.log(`Shard ${shard}/${GROUPS.length}: ${entries.join(' ')}`)
if (process.argv.includes('--list')) process.exit(0)

const env = { ...process.env }
if (parts.length === 1) env.SYNC_HARNESS_PART = parts[0]
// Soak worlds: a shard naming `soak.test.ts@a,b` turns the other worlds off.
const soakEntry = entries.find(e => fileOf(e) === 'soak.test.ts' && e.includes('@'))
if (soakEntry) {
  const worlds = soakEntry.split('@')[1].split(',')
  for (const [world, variable] of Object.entries(SOAK_WORLD_SEEDS)) {
    if (!worlds.includes(world)) env[variable] = 'none'
  }
}
// Every soak world must run in exactly one shard.
const soakWorlds = GROUPS.flat().filter(e => fileOf(e) === 'soak.test.ts').flatMap(e => (e.split('@')[1] ?? Object.keys(SOAK_WORLD_SEEDS).join(',')).split(','))
for (const world of Object.keys(SOAK_WORLD_SEEDS)) {
  if (soakWorlds.filter(w => w === world).length !== 1) {
    console.error(`sync-shard.mjs: soak world '${world}' must be in exactly one shard`)
    process.exit(1)
  }
}
const run = spawnSync('npx', ['tsx', '--test', ...files], { cwd: clientDir, env, stdio: 'inherit' })
process.exit(run.status ?? 1)
