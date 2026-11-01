// acb-plugin:// (stage 4b A5, .claude/rules/plugin-frame.md): a plugin's screen files are served
// only from the verified package the app keeps — a `ui/` file, of a package a company of the
// account lists now, whose kept folder still matches the fingerprint it was kept with — and every
// answer carries the CSP that allows no network. The store's `keptPackage` says which packages
// those are.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginFingerprintV2 } from '../../shared/core/plugin-fingerprint'
import { sha256Hex } from '../electron/features/plugins/fetch'
import { createPluginFileServer } from '../electron/features/plugins/protocol'
import { createPluginPackageStore } from '../electron/features/plugins/store'
import { parsePluginFrameUrl, pluginFrameUrl } from '../shared/plugin-bridge'

const quiet = { warn: () => {}, info: () => {} }
const enc = (s: string) => new TextEncoder().encode(s)
const FILES = [
  { path: 'plugin.yaml', bytes: enc('id: planning\nversion: 0.1.0\n') },
  { path: 'steps/make.md', bytes: enc('# 企画\n') },
  { path: 'ui/index.html', bytes: enc('<!doctype html><script src="./app.js"></script>') },
  { path: 'ui/app.js', bytes: enc('console.log(1)\n') },
  { path: 'ui/assets/logo.svg', bytes: enc('<svg/>') },
]
const FP = pluginFingerprintV2(FILES, sha256Hex)

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-plugin-frame-'))
  const write = (name: string, files: typeof FILES) => {
    for (const f of files) {
      const target = path.join(root, name, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, f.bytes)
    }
  }
  write('planning@0.1.0', FILES)
  // Another plugin and another version the account does not list now.
  write('other@1.0.0', [{ path: 'ui/index.html', bytes: enc('other') }])
  const kept: Record<string, { folder: string; fingerprint: string }> = {
    'planning@0.1.0': { folder: path.join(root, 'planning@0.1.0'), fingerprint: FP },
  }
  const server = createPluginFileServer({ packages: { keptPackage: (id, v) => kept[`${id}@${v}`] ?? null }, log: quiet })
  const get = async (url: string) => { const r = await server.serve({ url, method: 'GET' }); return { status: r.status, text: await r.text(), headers: r.headers } }
  return { root, kept, server, get }
}

test('a ui/ file of the verified package is served, with the CSP that allows no network', async () => {
  const w = world()
  const page = await w.get('acb-plugin://planning/0.1.0/ui/index.html')
  assert.equal(page.status, 200)
  assert.match(page.text, /app\.js/)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  const csp = page.headers.get('content-security-policy') ?? ''
  const directives = new Map(csp.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
  assert.deepEqual(directives.get('default-src'), ["'none'"])
  // No connect-src at all: fetch / XHR / WebSocket fall back to default-src 'none'.
  assert.equal(directives.has('connect-src'), false)
  // Scripts only from this version's ui/ (not 'self', which would cover every version of the plugin).
  assert.deepEqual(directives.get('script-src'), ['acb-plugin://planning/0.1.0/ui/'])
  for (const d of ['frame-src', 'worker-src', 'object-src', 'form-action', 'base-uri']) assert.deepEqual(directives.get(d), ["'none'"], d)
  assert.doesNotMatch(csp, /\*|https?:|unsafe-eval|'self'/)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await w.get('acb-plugin://planning/0.1.0/ui/assets/logo.svg')).status, 200)
  assert.equal((await w.server.serve({ url: 'acb-plugin://planning/0.1.0/ui/app.js', method: 'POST' })).status, 405)
})

test('only ui/ files: traversal, escapes, the declaration, steps and other packages are refused', async () => {
  const w = world()
  for (const url of [
    'acb-plugin://planning/0.1.0/plugin.yaml',
    'acb-plugin://planning/0.1.0/steps/make.md',
    'acb-plugin://planning/0.1.0/ui/../plugin.yaml',
    'acb-plugin://planning/0.1.0/ui/%2e%2e/plugin.yaml',
    'acb-plugin://planning/0.1.0/ui/..%2fplugin.yaml',
    'acb-plugin://planning/0.1.0/ui/..\\plugin.yaml',
    'acb-plugin://planning/0.1.0/../other@1.0.0/ui/index.html',
    'acb-plugin://planning/0.1.0/ui/missing.js',
    'acb-plugin://planning/0.1.0/ui/index.txt',
    'acb-plugin://planning@0.1.0/ui/index.html',
    'acb-plugin://other/1.0.0/ui/index.html',
    'acb-plugin://planning/0.2.0/ui/index.html',
    'acb-plugin://Planning/0.1.0/ui/index.html',
    'local-file:///etc/passwd',
  ]) assert.equal((await w.get(url)).status, 404, url)
  assert.equal(parsePluginFrameUrl('acb-plugin://planning/0.1.0/ui/index.html?v=1#x')?.path, 'ui/index.html')
  assert.equal(pluginFrameUrl({ id: 'planning', version: '0.1.0' }, 'plugin.yaml'), null)
  assert.equal(pluginFrameUrl({ id: 'planning', version: '0.1.0' }, 'ui/../plugin.yaml'), null)
})

test('a folder that no longer matches its fingerprint, or a file changed after the check, is never served', async () => {
  // Kept with another fingerprint (or changed before this run): nothing of it is served.
  const a = world()
  a.kept['planning@0.1.0'].fingerprint = 'f'.repeat(64)
  assert.equal((await a.get('acb-plugin://planning/0.1.0/ui/index.html')).status, 404)

  // A file added to the folder: the folder no longer matches.
  const b = world()
  fs.writeFileSync(path.join(b.root, 'planning@0.1.0', 'ui', 'extra.js'), 'x')
  assert.equal((await b.get('acb-plugin://planning/0.1.0/ui/index.html')).status, 404)

  // Verified, then one byte changed on disk: that file is refused, and so is the rest until it matches again.
  const c = world()
  assert.equal((await c.get('acb-plugin://planning/0.1.0/ui/app.js')).status, 200)
  fs.writeFileSync(path.join(c.root, 'planning@0.1.0', 'ui', 'app.js'), 'console.log(2)\n')
  assert.equal((await c.get('acb-plugin://planning/0.1.0/ui/app.js')).status, 404)
  assert.equal((await c.get('acb-plugin://planning/0.1.0/ui/index.html')).status, 404)
  fs.writeFileSync(path.join(c.root, 'planning@0.1.0', 'ui', 'app.js'), 'console.log(1)\n')
  assert.equal((await c.get('acb-plugin://planning/0.1.0/ui/index.html')).status, 200)

  // A link in the package (even to a file with the right bytes) is not a package file.
  const d = world()
  const app = path.join(d.root, 'planning@0.1.0', 'ui', 'app.js')
  const outside = path.join(d.root, 'outside.js')
  fs.copyFileSync(app, outside)
  fs.rmSync(app)
  fs.symlinkSync(outside, app)
  assert.equal((await d.get('acb-plugin://planning/0.1.0/ui/app.js')).status, 404)
  assert.equal((await d.get('acb-plugin://planning/0.1.0/ui/index.html')).status, 404)

  // Not a package the account lists now (turned off, signed out): nothing.
  const e = world()
  delete e.kept['planning@0.1.0']
  assert.equal((await e.get('acb-plugin://planning/0.1.0/ui/index.html')).status, 404)
})

test('the store answers a kept package only while a company of the signed-in account lists it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-plugin-kept-'))
  let user: string | null = 'u1'
  const files = FILES.map(f => ({ path: f.path, bytes: f.bytes }))
  const store = createPluginPackageStore({ dir: () => dir, userId: () => user, fetchPackage: async () => ({ ok: true, files }), log: quiet })
  const entry = { id: 'planning', version: '0.1.0', fingerprint: FP, use: 'current' as const }
  await store.sync('c1', [entry])
  assert.deepEqual(store.keptPackage('planning', '0.1.0'), { folder: path.join(dir, 'planning@0.1.0'), fingerprint: FP })
  assert.ok(store.keptPackage('planning', '0.1.0', 'c1'))
  assert.equal(store.keptPackage('planning', '0.1.0', 'c2'), null)
  assert.equal(store.keptPackage('planning', '0.2.0'), null)
  assert.equal(store.keptPackage('../x', '0.1.0'), null)
  user = 'u2'
  assert.equal(store.keptPackage('planning', '0.1.0'), null)
  user = 'u1'
  await store.sync('c1', [])
  assert.equal(store.keptPackage('planning', '0.1.0'), null)
})
