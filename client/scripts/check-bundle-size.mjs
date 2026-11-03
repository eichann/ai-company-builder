#!/usr/bin/env node
// Renderer bundle size budget (CI job "Performance baselines"). Run after
// `vite build`: sums the JavaScript in dist/assets (the renderer; the main
// process goes to dist-electron and is not counted), prints one `[perf]` line
// and fails when it is over the budget.
//
// The renderer JS was ~1.92 MiB (2,012,203 bytes) on 2026-10-23 after #154.
// The budget leaves ~15% for growth; raise it deliberately, in the PR that
// needs it, rather than by habit.
// 2026-11-02: 2.2 → 2.3 MiB. Stage 2's task list, card, notices and AI turns (#404–#429) brought it
// to 2,303,266 bytes (99.8%); 「部署に出す」 and the title bar's meetings (#427) passed it. Nothing in
// the renderer is lazy-loaded yet; splitting the task list out is the next lever before raising again.
// 2026-11-02: 2.3 → 2.5 MiB (owner decision): the stage-2 screens keep growing it; code splitting is planned with the visual batch.
// 2026-11-03: 2.5 → 2.55 MiB. next/task-list stood at 2,615,921 bytes (99.8%); 「落とすと、つながります」 (drag
// to link records, consultations and folders, +7.6 KB) passed it. Lazy chunks count here too, so only
// removing code lowers it. Owner decision (option A).
// 2026-11-03: 2.55 → 3.0 MiB (owner decision: 「ちょっと上げて良い」). In exchange each pull request may
// grow the renderer JS by at most 50 KB over its base (`--base`, below): the absolute budget catches the
// total, the growth guard catches one change that adds a lot (a new dependency) while there is room.
//
// Usage: node scripts/check-bundle-size.mjs [distDir] [--budget-mib N] [--base baseDistDir] [--max-growth-kb N]
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const options = new Map()
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) options.set(args[i], args[++i])
  else positional.push(args[i])
}
const budgetMiB = options.has('--budget-mib') ? Number(options.get('--budget-mib')) : 3.0
const maxGrowthKb = options.has('--max-growth-kb') ? Number(options.get('--max-growth-kb')) : 50
const dist = positional[0] ?? 'dist'

const sum = list => list.reduce((n, f) => n + f.bytes, 0)
/** The JS and CSS Vite emitted into `<dir>/assets`. */
function assetsOf(dir) {
  const assets = path.join(dir, 'assets')
  if (!fs.existsSync(assets)) {
    console.error(`No ${assets}: run \`vite build\` first.`)
    process.exit(2)
  }
  const files = fs.readdirSync(assets).map(name => ({ name, bytes: fs.statSync(path.join(assets, name)).size }))
  return { js: files.filter(f => f.name.endsWith('.js')), css: files.filter(f => f.name.endsWith('.css')) }
}

const { js, css } = assetsOf(dist)
const jsBytes = sum(js)
const budgetBytes = Math.round(budgetMiB * 1024 * 1024)
let failed = false

for (const f of [...js, ...css].sort((a, b) => b.bytes - a.bytes)) console.log(`  ${f.name}  ${f.bytes} bytes`)
console.log(`[perf] bundle.rendererJs=${jsBytes} bytes (budget ${budgetBytes} bytes = ${budgetMiB} MiB)`)
console.log(`[perf] bundle.rendererCss=${sum(css)} bytes`)

if (jsBytes > budgetBytes) {
  console.error(`::error::Renderer JavaScript is ${(jsBytes / 1024 / 1024).toFixed(2)} MiB, over the ${budgetMiB} MiB budget. Lazy-load the new dependency, or raise the budget in scripts/check-bundle-size.mjs with a reason.`)
  failed = true
}

// Growth over the pull request's base (CI builds the base commit in the same job, same toolchain).
if (options.has('--base')) {
  const baseBytes = sum(assetsOf(options.get('--base')).js)
  const growth = jsBytes - baseBytes
  const limit = maxGrowthKb * 1000
  console.log(`[perf] bundle.rendererJsGrowth=${growth} bytes (base ${baseBytes} bytes; limit ${limit} bytes = ${maxGrowthKb} KB)`)
  if (growth > limit) {
    console.error(`::error::This change grows the renderer JavaScript by ${(growth / 1000).toFixed(1)} KB, over the ${maxGrowthKb} KB a pull request may add. Lazy-load what is new, or split the change; the owner decides an exception (testing.md "Performance baselines").`)
    failed = true
  }
}

if (failed) process.exit(1)
