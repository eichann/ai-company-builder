// Starts the HTML review demo (main.ts): the preview pages' Vite server on a free port, then Electron
// with the real document views. Stops Vite when Electron exits.
//
//   cd client && node tests/html-review-demo/run.mjs                 # a window to try it by hand
//   cd client && node tests/html-review-demo/run.mjs --shots <dir>   # plays the scenario, writes PNGs
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : ''

const port = await new Promise((resolve, reject) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  server.on('error', reject)
})
const vite = spawn(process.execPath, [path.join(clientDir, 'node_modules/vite/bin/vite.js'), '-c', 'tests/ui/vite.config.ts', '--port', String(port), '--host', '127.0.0.1'], { cwd: clientDir, stdio: ['ignore', 'pipe', 'inherit'] })
const stopVite = () => { if (vite.exitCode === null) vite.kill('SIGTERM') }
process.on('exit', stopVite)
process.on('SIGINT', () => { stopVite(); process.exit(130) })
await new Promise((resolve, reject) => {
  let out = ''
  vite.stdout.on('data', chunk => { out += chunk; if (out.includes('Local:')) resolve() })
  vite.on('exit', () => reject(new Error(`vite stopped:\n${out}`)))
})

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-html-review-demo-'))
const electron = createRequire(import.meta.url)('electron')
const child = spawn(electron, [path.join(clientDir, 'tests/html-review-demo/main.ts')], {
  cwd: clientDir,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', DEMO_DIR: dir, DEMO_PAGE: `http://127.0.0.1:${port}/tests/html-review-ui.html`, DEMO_SHOTS: shots },
  stdio: 'inherit',
})
child.on('exit', code => {
  stopVite()
  // Played: nothing to keep. By hand: the folder stays, to look at the files the review wrote.
  if (shots) fs.rmSync(dir, { recursive: true, force: true })
  else console.log(`[demo] the fictional company folder (the review's files are next to 営業部/月次報告.html): ${dir}`)
  process.exit(code ?? 0)
})
