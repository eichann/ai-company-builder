#!/usr/bin/env node
// Every preload Vite emits must load in a sandboxed window (google-drive.md "The Picker",
// ipc-and-main-process.md). Run after `vite build` (CI "Renderer bundle size (Linux)", and
// `pnpm build` before electron-builder packs the app).
//
// Electron runs a sandboxed preload as a classic script, wrapped in a function that receives its
// own `require` — which, in Electron 45, gives out only `electron` (deployment.md). An ES-module
// preload (a top-level `import`) fails to parse there, the bridge is never exposed, and the page
// finds no `window.acbPicker` / `window.electronAPI`: release-20261109 shipped such a
// picker-preload.js and the Google Picker window showed 「この画面はアプリの中でだけ使えます。」.
//
// This loads each file the same way under Node's vm: compiled as a function body (so `import` /
// `export` are syntax errors, as in Electron), run with a require that has only a fake
// `electron`, and checked to expose its one bridge name.
//
// Usage: node scripts/check-preloads.mjs [dist-electron]
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const dir = process.argv[2] ?? 'dist-electron'

/** Each preload file and the one name it exposes (electron-adapter.ts sets the windows up). */
const PRELOADS = [
  { file: 'preload.js', exposes: 'electronAPI' },
  { file: 'picker-preload.js', exposes: 'acbPicker' },
]

/** What a sandboxed preload sees: the wrapper's parameters, `require` limited to `electron`. */
function loadAsSandboxedPreload(source, filename) {
  const exposed = []
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: name => exposed.push(name) },
    ipcRenderer: { invoke() {}, send() {}, sendSync() {}, on() {}, once() {}, removeListener() {} },
    webUtils: { getPathForFile: () => '' },
  }
  const sandboxRequire = id => {
    if (id === 'electron') return fakeElectron
    throw new Error(`a sandboxed preload cannot require "${id}" (only "electron")`)
  }
  const wrapper = new vm.Script(
    `(function (require, process, global, exports, module) {${source}\n})`,
    { filename },
  ).runInNewContext({})
  const module = { exports: {} }
  wrapper(sandboxRequire, { platform: process.platform, env: {} }, {}, module.exports, module)
  return exposed
}

let failed = false
for (const { file, exposes } of PRELOADS) {
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) {
    console.error(`[preload] ${full} is missing (run vite build first)`)
    failed = true
    continue
  }
  try {
    const exposed = loadAsSandboxedPreload(fs.readFileSync(full, 'utf8'), full)
    if (!exposed.includes(exposes)) throw new Error(`it did not expose window.${exposes} (exposed: ${exposed.join(', ') || 'nothing'})`)
    console.log(`[preload] ${file}: loads in a sandbox, exposes window.${exposes}`)
  } catch (error) {
    console.error(`[preload] ${file} would not load in a sandboxed window: ${error.message}`)
    console.error('  A preload must be CommonJS (vite.config.ts commonJsPreload) and require only "electron".')
    failed = true
  }
}
if (failed) process.exit(1)
