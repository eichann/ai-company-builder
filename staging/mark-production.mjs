#!/usr/bin/env node
// After a production deploy: record the commit production now runs in the private kit config,
// so every FDE's staging kit follows it on their next `up` / `app` (staging/README.md).
//
//   node staging/mark-production.mjs <commit>        (a full id, or anything `git rev-parse` resolves here)
//
// The config's location is the same local setting the kit reads (ACB_KIT_PRIVATE, or
// ~/.acb-staging-kit/config); this script names no place itself. Only the `production` line is
// changed; plugin lines stay. The write carries the version it read, so a concurrent change is
// refused rather than overwritten. Needs write access to that place (`gh` login).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { withProductionCommit, privateSpecFrom } from './lib/kit.mjs'
import { readPrivateForUpdate, writePrivateText } from './lib/private.mjs'

function resolveCommit(arg) {
  if (/^[0-9a-f]{40}$/.test(arg)) return arg
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${arg}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new Error(`${arg} is not a commit here; pass the full 40-character id`)
  }
}

export function markProduction(arg, env = process.env) {
  const spec = privateSpecFrom(env)
  if (!spec) throw new Error('No private kit config is set (ACB_KIT_PRIVATE or ~/.acb-staging-kit/config).')
  const sha = resolveCommit(arg)
  const current = readPrivateForUpdate(spec) // only "not there" is empty; anything else throws
  const next = withProductionCommit(current.text, sha)
  if (next === current.text) return { sha, changed: false }
  writePrivateText(spec, next, `staging kit: production runs ${sha.slice(0, 12)}`, current.sha)
  return { sha, changed: true }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node staging/mark-production.mjs <commit>')
    const { sha, changed } = markProduction(process.argv[2])
    console.log(changed ? `Recorded: production runs ${sha}.` : `Already recorded: production runs ${sha}.`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
