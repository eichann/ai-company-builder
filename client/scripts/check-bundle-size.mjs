#!/usr/bin/env node
// Renderer bundle size budget (CI job "Performance baselines"). Run after
// `vite build`: sums the JavaScript in dist/assets (the renderer; the main
// process goes to dist-electron and is not counted), prints one `[perf]` line
// and fails when it is over the budget.
//
// The renderer JS was ~1.92 MiB (2,012,203 bytes) on 2026-10-23 after #154.
// The budget leaves ~15% for growth; raise it deliberately, in the PR that
// needs it, rather than by habit.
//
// Usage: node scripts/check-bundle-size.mjs [distDir] [--budget-mib N]
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = args.indexOf('--budget-mib')
const budgetMiB = flag >= 0 ? Number(args[flag + 1]) : 2.2
const dist = args.find((a, i) => !a.startsWith('--') && (flag < 0 || i !== flag + 1)) ?? 'dist'
const assets = path.join(dist, 'assets')

if (!fs.existsSync(assets)) {
  console.error(`No ${assets}: run \`vite build\` first.`)
  process.exit(2)
}

const files = fs.readdirSync(assets).map(name => ({ name, bytes: fs.statSync(path.join(assets, name)).size }))
const js = files.filter(f => f.name.endsWith('.js'))
const css = files.filter(f => f.name.endsWith('.css'))
const sum = list => list.reduce((n, f) => n + f.bytes, 0)
const jsBytes = sum(js)
const budgetBytes = Math.round(budgetMiB * 1024 * 1024)

for (const f of [...js, ...css].sort((a, b) => b.bytes - a.bytes)) console.log(`  ${f.name}  ${f.bytes} bytes`)
console.log(`[perf] bundle.rendererJs=${jsBytes} bytes (budget ${budgetBytes} bytes = ${budgetMiB} MiB)`)
console.log(`[perf] bundle.rendererCss=${sum(css)} bytes`)

if (jsBytes > budgetBytes) {
  console.error(`::error::Renderer JavaScript is ${(jsBytes / 1024 / 1024).toFixed(2)} MiB, over the ${budgetMiB} MiB budget. Lazy-load the new dependency, or raise the budget in scripts/check-bundle-size.mjs with a reason.`)
  process.exit(1)
}
