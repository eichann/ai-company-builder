#!/usr/bin/env node
// Checks that changed-areas.sh's path lists cover what each area's tests load.
//
//   node .github/scripts/check-areas.mjs
//
// For each area with test entry points, esbuild follows the static imports of
// those entry points; every repository file reached must be one that
// `changed-areas.sh --files <area>` lists (git's own pathspec matching), or a
// pull request that changes it would skip tests that load it. Fails with the
// missing files and the area to extend. Runs in the "Lint (changed files)" job.
//
// Not seen here: files read at run time instead of imported (the pre-receive
// hook template, fixtures). changed-areas.sh names those by hand.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const clientDir = path.join(root, 'client')
// esbuild comes with tsx (and vite); resolve it from the client's tsx.
const esbuild = createRequire(createRequire(path.join(clientDir, 'package.json')).resolve('tsx/package.json'))('esbuild')

const list = (dir, test) => fs.readdirSync(path.join(root, dir)).filter(test).map(f => `${dir}/${f}`)
const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])
const clientTests = os => execFileSync('node', ['.github/scripts/client-tests.mjs', os, '--list'], { cwd: root, encoding: 'utf-8' })
  .split('\n').slice(1).filter(Boolean).map(f => `client/${f}`)

const AREAS = {
  sync: [...list('client/tests/sync', f => f.endsWith('.test.ts')), 'server/src/lib/push-check/entry.ts'],
  client: clientTests('linux'),
  clientmac: clientTests('macos'),
  perf: list('client/tests/perf', f => f.endsWith('.ts')),
  ui: [
    ...list('client/tests', f => /-ui\.tsx$/.test(f)),
    ...walk('client/tests/ui').filter(f => f.endsWith('.ts')),
    'client/src/main.tsx',
  ],
}

// Imports that are not source (styles, assets, Vite's `?raw` / `?url`) and
// packages stay outside the graph; a bare import that does not resolve is
// reported rather than ignored.
const notSource = {
  name: 'not-source',
  setup(build) {
    build.onResolve({ filter: /\?(raw|url|worker|inline)$/ }, args => ({ path: args.path, external: true }))
    build.onResolve({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?|ttf|wasm|node)$/ }, args => ({ path: args.path, external: true }))
  },
}

let failed = false
for (const [area, entries] of Object.entries(AREAS)) {
  const result = await esbuild.build({
    entryPoints: entries.map(e => path.join(root, e)),
    bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', outdir: path.join(root, '.check-areas-out'),
    packages: 'external', logLevel: 'error', plugins: [notSource],
    loader: { '.md': 'text', '.html': 'text', '.sh': 'text', '.txt': 'text' },
  })
  const loaded = Object.keys(result.metafile.inputs)
    .map(f => path.relative(root, path.resolve(root, f)))
    .filter(f => !f.startsWith('..') && !f.includes('node_modules'))
  const covered = new Set(execFileSync('bash', ['.github/scripts/changed-areas.sh', '--files', area], { cwd: root, encoding: 'utf-8' }).split('\n'))
  const uncovered = loaded.filter(f => !covered.has(f)).sort()
  console.log(`${area}: ${entries.length} entry points load ${loaded.length} files${uncovered.length ? `, ${uncovered.length} not in its list` : ''}`)
  if (uncovered.length > 0) {
    failed = true
    console.error(`::error::changed-areas.sh: area '${area}' does not list files its tests load; a PR changing them would skip those tests. Add them to the area's list:\n  ${uncovered.join('\n  ')}`)
  }
}
process.exit(failed ? 1 : 0)
