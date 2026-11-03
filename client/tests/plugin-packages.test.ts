// Business plugins' packages kept by the app (plan C2 「配る道」, .claude/rules/plugins.md
// "Handing packages to the app"): the policy's `plugins` part is read strictly (an answer it
// cannot read changes nothing), a fetched package is kept only when every path is a package
// path and its v2 fingerprint is the one the policy listed (not the one in the answer), and a
// package no company lists any more is removed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginFingerprintV2 } from '../../shared/core/plugin-fingerprint'
import type { DistributedPlugin } from '../../shared/types/plugins'
import { parseDistributedPlugins } from '../shared/plugin-packages'
import { createAgentPolicyStore } from '../electron/services/agent-policy-store'
import { createPluginFetcher, sha256Hex, verifyPackage, type PluginFetchResult } from '../electron/features/plugins/fetch'
import { createPluginPackageStore } from '../electron/features/plugins/store'

const quiet = { log: () => {}, warn: () => {}, info: () => {} }
const enc = (s: string) => new TextEncoder().encode(s)
const FILES = [
  { path: 'plugin.yaml', bytes: enc('id: sample-flow\nversion: 0.2.0\n') },
  { path: 'steps/proposal.md', bytes: enc('# 提案書を用意する\n') },
  { path: 'ui/assets/app.js', bytes: enc('console.log(1)\n') },
]
const FP = pluginFingerprintV2(FILES, sha256Hex)
const ENTRY: DistributedPlugin = { id: 'sample-flow', version: '0.2.0', fingerprint: FP, use: 'current' }
const answer = (files = FILES, extra: Record<string, unknown> = {}) => ({
  id: ENTRY.id, version: ENTRY.version, fingerprint: FP,
  files: files.map(f => ({ path: f.path, base64: Buffer.from(f.bytes).toString('base64') })), ...extra,
})

test('the policy\'s plugins: absent or any malformed entry → undefined (the app changes nothing)', () => {
  assert.deepEqual(parseDistributedPlugins([ENTRY]), [ENTRY])
  assert.deepEqual(parseDistributedPlugins([]), [])
  assert.equal(parseDistributedPlugins(undefined), undefined)
  for (const bad of [
    { ...ENTRY, id: '../x' }, { ...ENTRY, version: '1.0' }, { ...ENTRY, fingerprint: 'abc' }, { ...ENTRY, use: 'other' }, null,
  ]) assert.equal(parseDistributedPlugins([ENTRY, bad]), undefined)
})

test('a package is kept only with package paths and the fingerprint the policy listed', () => {
  assert.equal(verifyPackage(ENTRY, answer()).ok, true)
  // One byte changed: refused, even when the answer names the matching fingerprint itself.
  const changed = [FILES[0], FILES[1], { path: 'ui/assets/app.js', bytes: enc('console.log(2)\n') }]
  assert.deepEqual(verifyPackage(ENTRY, answer(changed)), { ok: false, reason: 'fingerprint does not match' })
  assert.equal(verifyPackage(ENTRY, { ...answer(changed), fingerprint: pluginFingerprintV2(changed, sha256Hex) }).ok, false)
  // A path outside the package grammar (a way out of the folder) is refused before anything else.
  for (const p of ['../evil.js', '/etc/x', 'scripts/run.sh', 'ui/a/b/c/d/x.js', 'steps/x.sh', 'ui\\x.js']) {
    const files = [...FILES, { path: p, bytes: enc('x') }]
    assert.deepEqual(verifyPackage(ENTRY, answer(files)), { ok: false, reason: 'a path a package may not hold' }, p)
  }
  assert.equal(verifyPackage(ENTRY, answer(FILES, { id: 'another' })).ok, false)
})

test('the fetcher asks the package route with the session in a header', async () => {
  const calls: Array<{ url: string; cookie: string }> = []
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, cookie: init.headers.Cookie })
    return new Response(JSON.stringify({ success: true, data: answer() }), { status: 200 })
  }) as unknown as typeof fetch
  const got = await createPluginFetcher({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], fetch: f })('co 1', ENTRY)
  assert.equal(got.ok, true)
  assert.deepEqual(calls, [{ url: 'https://acb.example.jp/api/companies/co%201/plugins/sample-flow/package/0.2.0', cookie: 's=1' }])
})

test('the store keeps what a company lists, removes what no company lists, and never keeps an unverified package', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-plugins-'))
  try {
    let next: PluginFetchResult = { ok: true, files: FILES }
    const fetched: string[] = []
    const store = createPluginPackageStore({
      dir: () => dir, userId: () => 'u1', log: quiet,
      fetchPackage: async (companyId, entry) => { fetched.push(`${companyId}:${entry.id}@${entry.version}`); return next },
    })
    await store.sync('co1', [ENTRY])
    await store.sync('co2', [ENTRY])
    const folder = path.join(dir, 'sample-flow@0.2.0')
    assert.equal(fs.readFileSync(path.join(folder, 'ui', 'assets', 'app.js'), 'utf8'), 'console.log(1)\n')
    assert.deepEqual(fetched, ['co1:sample-flow@0.2.0']) // kept and verified: not fetched again
    assert.equal(store.folderOf('co1', 'sample-flow', '0.2.0'), folder)

    // co1 turns it off: still listed by co2, so kept; not this company's any more.
    await store.sync('co1', [])
    assert.equal(fs.existsSync(folder), true)
    assert.equal(store.folderOf('co1', 'sample-flow', '0.2.0'), null)
    // co2 turns it off too (or the operator stopped it): removed.
    await store.sync('co2', [])
    assert.equal(fs.existsSync(folder), false)

    // A failed fetch keeps nothing (and leaves no partial folder).
    next = { ok: false, reason: 'fingerprint does not match' }
    await store.sync('co1', [ENTRY])
    assert.deepEqual(fs.readdirSync(dir).filter(n => n !== 'index.json'), [])
    assert.equal(store.folderOf('co1', 'sample-flow', '0.2.0'), null)

    // The same version listed with another fingerprint: the old folder does not stay as if it were it.
    next = { ok: true, files: FILES }
    await store.sync('co1', [ENTRY])
    next = { ok: false, reason: 'HTTP 409' }
    await store.sync('co1', [{ ...ENTRY, fingerprint: 'f'.repeat(64) }])
    assert.equal(fs.existsSync(folder), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the policy store hands each answer\'s plugins to its listeners; an older server\'s answer has none', async () => {
  const sandbox = { mode: 'off', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' }
  const bodies = [{ version: 'v1', sandbox, plugins: [ENTRY] }, { version: 'v2', sandbox }]
  const f = (async () => new Response(JSON.stringify({ data: bodies.shift() }), { status: 200 })) as unknown as typeof fetch
  const store = createAgentPolicyStore({ baseUrl: () => 'https://acb.example.jp', cookies: () => [], fetch: f, log: quiet })
  const seen: Array<DistributedPlugin[] | undefined> = []
  store.onPolicy((_, policy) => seen.push(policy.plugins))
  await store.refresh('co')
  await store.refresh('co')
  assert.deepEqual(seen, [[ENTRY], undefined])
})
