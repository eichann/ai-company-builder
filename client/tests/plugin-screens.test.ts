// The four slots' screens (stage 4b A6, .claude/rules/plugin-frame.md "The four slots"): main
// answers the renderer only screens read from a kept package's own declaration through the same
// check the frame's files are served with — listed for that company now, the folder equal to its
// fingerprint — so a plugin turned off, stopped (no longer listed) or not matching shows no slot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginFingerprintV2 } from '../../shared/core/plugin-fingerprint'
import type { DistributedPlugin } from '../../shared/types/plugins'
import { sha256Hex } from '../electron/features/plugins/fetch'
import { createPluginFileServer } from '../electron/features/plugins/protocol'
import { createPluginScreens, screensOfPackage } from '../electron/features/plugins/screens'
import { createPluginPackageStore } from '../electron/features/plugins/store'

const quiet = { warn: () => {}, info: () => {} }
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'plugins', 'slots-sample')

function fixtureFiles(): Array<{ path: string; bytes: Uint8Array }> {
  const out: Array<{ path: string; bytes: Uint8Array }> = []
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else out.push({ path: r, bytes: fs.readFileSync(path.join(dir, e.name)) })
    }
  }
  walk(FIXTURE, '')
  return out
}
const FILES = fixtureFiles()
const FP = pluginFingerprintV2(FILES, sha256Hex)
const MANIFEST = fs.readFileSync(path.join(FIXTURE, 'plugin.yaml'), 'utf8')
const REF = { id: 'slots-sample', version: '0.1.0' }
const ENTRY: DistributedPlugin = { ...REF, fingerprint: FP, use: 'current' }
const ALL_FILES = new Set(FILES.map(f => f.path))

test('a package\'s declaration gives the four slots; anything this app cannot show gives none', () => {
  const s = screensOfPackage(REF, MANIFEST, ALL_FILES)
  assert.deepEqual(s, {
    plugin: REF, label: '見本の番組企画',
    tab: { label: '番組', icon: 'FilmSlate', entry: 'ui/index.html' },
    peek: { implements: 'request', stateGroup: 'mine' },
    recordSections: [{ type: 'program_plan', label: '構成', entry: 'ui/plan.html' }, { type: 'task', label: '番組のメモ', entry: 'ui/plan.html' }],
    fileActions: [{ label: '企画の資料にする', entry: 'ui/attach.html', kinds: ['pdf', 'markdown'] }],
  })
  // Another package's name or version than the folder it was kept as.
  assert.equal(screensOfPackage({ ...REF, version: '0.2.0' }, MANIFEST, ALL_FILES), null)
  assert.equal(screensOfPackage({ ...REF, id: 'other' }, MANIFEST, ALL_FILES), null)
  // A frame entry missing from the verified files.
  assert.equal(screensOfPackage(REF, MANIFEST, new Set([...ALL_FILES].filter(p => p !== 'ui/attach.html'))), null)
  // A bridge version this app does not speak, a declaration that does not parse, contract 1.
  assert.equal(screensOfPackage(REF, MANIFEST.replace('bridge: 1', 'bridge: 2'), ALL_FILES), null)
  assert.equal(screensOfPackage(REF, MANIFEST.replace('kinds: [pdf, markdown]', 'kinds: [exe]'), ALL_FILES), null)
  assert.equal(screensOfPackage(REF, MANIFEST.replace(/\nui:[\s\S]*$/, '\n'), ALL_FILES), null)
})

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-plugin-screens-'))
  const changed: string[] = []
  const store = createPluginPackageStore({
    dir: () => dir, userId: () => 'u1', log: quiet, onChanged: companyId => changed.push(companyId),
    fetchPackage: async () => ({ ok: true, files: FILES }),
  })
  const files = createPluginFileServer({ packages: { keptPackage: (id, v, c) => store.keptPackage(id, v, c) }, log: quiet })
  const listed: Record<string, DistributedPlugin[]> = {}
  const screens = createPluginScreens({
    listed: async companyId => listed[companyId] ?? null,
    settled: () => store.idle(),
    declaration: (companyId, ref) => files.declaration(companyId, ref),
    isMainWindow: () => true,
  })
  return { dir, store, listed, changed, screens, folder: path.join(dir, 'slots-sample@0.1.0') }
}

test('only a verified package the company lists now has screens: off, stopped, another company or a changed folder → none', async () => {
  const w = world()
  try {
    w.listed.co1 = [ENTRY]
    await w.store.sync('co1', [ENTRY])
    const ok = await w.screens.list('co1')
    assert.deepEqual(ok.success && ok.screens.map(s => s.plugin), [REF])

    // Another company of the account that does not list it.
    assert.deepEqual(await w.screens.list('co2'), { success: true, screens: [] })
    // A pinned version is kept for older work only: no slot.
    w.listed.co1 = [{ ...ENTRY, use: 'pinned' }]
    assert.deepEqual(await w.screens.list('co1'), { success: true, screens: [] })
    w.listed.co1 = [ENTRY]

    // A file of the kept folder changed after it was verified: no screens until it matches again.
    fs.appendFileSync(path.join(w.folder, 'ui', 'attach.html'), '<script>1</script>')
    assert.deepEqual(await w.screens.list('co1'), { success: true, screens: [] })
    fs.writeFileSync(path.join(w.folder, 'ui', 'attach.html'), FILES.find(f => f.path === 'ui/attach.html')!.bytes)
    assert.equal((await w.screens.list('co1') as { screens: unknown[] }).screens.length, 1)

    // Turned off or stopped: the policy no longer lists it and the store removes it.
    w.listed.co1 = []
    await w.store.sync('co1', [])
    assert.deepEqual(await w.screens.list('co1'), { success: true, screens: [] })
    // Even if a stale policy still named it, the store keeps nothing for the company now.
    w.listed.co1 = [ENTRY]
    assert.deepEqual(await w.screens.list('co1'), { success: true, screens: [] })
  } finally {
    fs.rmSync(w.dir, { recursive: true, force: true })
  }
})

test('the renderer is told only when what a company keeps changed (no refresh loop on an equal policy)', async () => {
  const w = world()
  try {
    await w.store.sync('co1', [ENTRY])
    await w.store.sync('co1', [ENTRY])
    await w.store.sync('co1', [ENTRY])
    assert.deepEqual(w.changed, ['co1'])
    await w.store.sync('co1', [])
    assert.deepEqual(w.changed, ['co1', 'co1'])
    await w.store.sync('co1', [])
    assert.deepEqual(w.changed, ['co1', 'co1'])
  } finally {
    fs.rmSync(w.dir, { recursive: true, force: true })
  }
})
