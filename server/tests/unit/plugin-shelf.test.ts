/**
 * The plugin shelf (adapters/plugin-shelf.ts + services/plugin-shelf.ts,
 * `.claude/rules/plugins.md`): only packages that are data and pass the core's
 * rules are used; anything else on the shelf is refused with the folder name
 * and a reason (never the file's content). The fingerprint changes with any
 * file, and `available_to` hides a package from companies not listed. The
 * operator's stop list is read on every call and fails closed. Connectors and
 * business plugins are read on their own (owner decision 2026-11-01): a
 * business plugin is used without its connector on the shelf, a connector
 * without any business plugin, and the old shapes (a connector with types, or
 * with `maps_to`) are refused with the reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { diskPluginShelf } from '../../src/adapters/plugin-shelf'
import { createPluginShelf } from '../../src/services/plugin-shelf'

const FIXTURES = join(__dirname, '../fixtures/plugins')
let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'acb-shelf-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const put = (fixture: string, dir: string) => cpSync(join(FIXTURES, fixture), join(root, dir), { recursive: true })
/** The sample CRM under another id (the folder's name), otherwise valid. */
function rename(dir: string) {
  put('sample-crm', dir)
  const file = join(root, dir, 'plugin.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('id: sample-crm', `id: ${dir.split('@')[0]}`))
}

describe('plugin shelf', () => {
  it('uses packages that pass the rules and refuses the rest, naming only the folder', async () => {
    put('sample-sales', 'sample-sales@0.1.0')
    put('sample-crm', 'sample-crm@0.1.0')
    put('sample-crm', 'sample-crm@9.9.9') // folder name does not match the declaration's version
    put('sample-crm', 'bad-key@0.1.0')
    writeFileSync(join(root, 'bad-key@0.1.0/plugin.yaml'), readFileSync(join(root, 'bad-key@0.1.0/plugin.yaml'), 'utf8')
      .replace('id: sample-crm', 'id: bad-key').replace('kind: official', 'kind: official\nscript: "rm -rf /SECRET-CONTENT"'))
    // Valid packages but for one thing that is not data: a program file, a link.
    rename('with-code@0.1.0')
    writeFileSync(join(root, 'with-code@0.1.0/index.js'), 'process.exit(1)')
    put('sample-crm-sales', 'linked@0.1.0')
    const linked = join(root, 'linked@0.1.0/plugin.yaml')
    writeFileSync(linked, readFileSync(linked, 'utf8').replace('id: sample-crm-sales', 'id: linked'))
    const elsewhere = join(root, '.elsewhere.yaml')
    cpSync(join(root, 'linked@0.1.0/mapping.yaml'), elsewhere)
    rmSync(join(root, 'linked@0.1.0/mapping.yaml'))
    symlinkSync(elsewhere, join(root, 'linked@0.1.0/mapping.yaml'))
    mkdirSync(join(root, 'Not A Package'))

    const shelf = createPluginShelf(diskPluginShelf(root))
    const result = await shelf.load()
    expect(result.loaded).toEqual(['sample-crm@0.1.0', 'sample-sales@0.1.0'])
    const refused = Object.fromEntries(result.refused.map(r => [r.dir, r.reason]))
    expect(Object.keys(refused).sort()).toEqual(['Not A Package', 'bad-key@0.1.0', 'linked@0.1.0', 'sample-crm@9.9.9', 'with-code@0.1.0'])
    expect(refused['bad-key@0.1.0']).toMatch(/プログラムは書けません/)
    expect(JSON.stringify(result.refused)).not.toContain('SECRET-CONTENT')
    expect(shelf.packagesFor('any-company').map(p => p.pkg.manifest.id)).toEqual(['sample-crm', 'sample-sales'])
    // The connector owns no type; the business plugin its own.
    expect(shelf.find('any-company', 'sample-crm', '0.1.0')!.pkg.types).toEqual({})
    expect(Object.keys(shelf.find('any-company', 'sample-sales', '0.1.0')!.pkg.types).sort()).toEqual(['customer', 'deal'])
  })

  it('a business plugin is used without its connector on the shelf; the old connector shapes are refused with the reason (owner decision 2026-11-01)', async () => {
    // sample-sales names sample-hub, which is not on this shelf: still used (it works inside ACB until its connector is there).
    put('sample-sales', 'sample-sales@0.1.0')
    // hubspot@0.1.x's shape: the connector brought deal / customer itself.
    rename('old-types@0.1.0')
    cpSync(join(FIXTURES, 'sample-sales/types'), join(root, 'old-types@0.1.0/types'), { recursive: true })
    const oldTypes = join(root, 'old-types@0.1.0/plugin.yaml')
    writeFileSync(oldTypes, `${readFileSync(oldTypes, 'utf8')}types: [deal, customer]\n`)
    // hubspot@0.2.0's shape: the connector named the business plugin it served, and the record types.
    rename('old-maps-to@0.2.0')
    const oldMapsTo = join(root, 'old-maps-to@0.2.0/plugin.yaml')
    writeFileSync(oldMapsTo, readFileSync(oldMapsTo, 'utf8').replace('version: 0.1.0', 'version: 0.2.0')
      .replace('contract: 1', 'contract: 1\nmaps_to: sample-sales@0.1.0').replace('  deal:\n    auto_properties', '  deal:\n    record_type: deal\n    auto_properties'))
    // A connector carrying a mapping (the mapping is the business plugin's).
    rename('with-mapping@0.1.0')
    cpSync(join(FIXTURES, 'sample-crm-sales/mapping.yaml'), join(root, 'with-mapping@0.1.0/mapping.yaml'))
    const shelf = createPluginShelf(diskPluginShelf(root))
    const result = await shelf.load()
    expect(result.loaded).toEqual(['sample-sales@0.1.0'])
    const refused = Object.fromEntries(result.refused.map(r => [r.dir, r.reason]))
    expect(refused['old-types@0.1.0']).toContain('型を持ちません')
    expect(refused['old-maps-to@0.2.0']).toContain('maps_to はなくなりました')
    expect(refused['old-maps-to@0.2.0']).toContain('record_type は、つなぎ先を使う業務のプラグインの objects に書きます')
    expect(refused['with-mapping@0.1.0']).toContain('読み替え表（mapping.yaml）は置けません')
  })

  it('a changed file changes the fingerprint (of the package it is in)', async () => {
    put('sample-sales', 'sample-sales@0.1.0')
    put('sample-crm-sales', 'sample-crm-sales@0.1.0')
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    const before = shelf.find('c', 'sample-crm-sales', '0.1.0')!.fingerprint
    const businessBefore = shelf.find('c', 'sample-sales', '0.1.0')!.fingerprint
    const types = join(root, 'sample-sales@0.1.0/types/deal.md')
    writeFileSync(types, readFileSync(types, 'utf8').replace('# 案件', '# 案件（変えた）'))
    await shelf.load()
    expect(shelf.find('c', 'sample-sales', '0.1.0')!.fingerprint).not.toBe(businessBefore)
    const mapping = join(root, 'sample-crm-sales@0.1.0/mapping.yaml')
    writeFileSync(mapping, readFileSync(mapping, 'utf8').replace('# The recommended mapping', '# The recommended mapping (changed)'))
    await shelf.load()
    expect(shelf.find('c', 'sample-crm-sales', '0.1.0')!.fingerprint).not.toBe(before)
  })

  it('a package listed for other companies does not exist for this one', async () => {
    put('sample-support', 'sample-support@1.0.0')
    put('sample-desk', 'sample-desk@2.3.1')
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    expect(shelf.packagesFor('company-desk-only').map(p => p.pkg.manifest.id)).toEqual(['sample-desk', 'sample-support'])
    expect(shelf.find('company-desk-only', 'sample-desk', '2.3.1')).not.toBeNull()
    expect(shelf.packagesFor('someone-else')).toEqual([])
    expect(shelf.find('someone-else', 'sample-desk', '2.3.1')).toBeNull()
  })

  it("each package's available_to applies on its own: a connector is a shared part, usable without its business plugin", async () => {
    put('sample-sales', 'sample-sales@0.1.0')
    put('sample-hub', 'sample-hub@0.1.0')
    const sales = join(root, 'sample-sales@0.1.0/plugin.yaml')
    writeFileSync(sales, readFileSync(sales, 'utf8').replace('contract: 1', 'contract: 1\navailable_to: [only-this-one]'))
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    expect(shelf.packagesFor('only-this-one').map(p => p.pkg.manifest.id)).toEqual(['sample-hub', 'sample-sales'])
    expect(shelf.packagesFor('someone-else').map(p => p.pkg.manifest.id)).toEqual(['sample-hub'])
    expect(shelf.find('someone-else', 'sample-sales', '0.1.0')).toBeNull()
  })

  it('the stop list is read on every call and fails closed when unreadable', async () => {
    put('sample-sales', 'sample-sales@0.1.0')
    put('sample-crm', 'sample-crm@0.1.0')
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    expect(await shelf.isStopped('sample-crm', '0.1.0')).toBe(false)
    writeFileSync(join(root, 'stopped'), '# problem found\nsample-crm@0.1.0\n')
    expect(await shelf.isStopped('sample-crm', '0.1.0')).toBe(true)
    expect(await shelf.isStopped('sample-crm', '0.2.0')).toBe(false)
    writeFileSync(join(root, 'stopped'), 'sample-crm\n')
    expect(await shelf.isStopped('sample-crm', '0.2.0')).toBe(true)
    if (process.getuid?.() !== 0) {
      chmodSync(join(root, 'stopped'), 0o000)
      expect(await shelf.isStopped('other', '1.0.0')).toBe(true)
    }
  })
})

describe('plugin shelf: contract 2 (plan C1)', () => {
  /** Fingerprint v1 as the shelf has always computed it (path \0 text \0 of plugin.yaml, mapping.yaml, types/ in sorted order). */
  function legacyFingerprint(dir: string): string {
    const hash = createHash('sha256')
    for (const name of readdirSync(dir).sort()) {
      if (name === 'types') for (const t of readdirSync(join(dir, 'types')).sort()) hash.update(`types/${t}`).update('\0').update(readFileSync(join(dir, 'types', t), 'utf8')).update('\0')
      else hash.update(name).update('\0').update(readFileSync(join(dir, name), 'utf8')).update('\0')
    }
    return hash.digest('hex')
  }
  const renameTo = (dir: string) => {
    const file = join(root, dir, 'plugin.yaml')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^id: .*$/m, `id: ${dir.split('@')[0]}`))
  }

  it("keeps a contract-1 package's fingerprint exactly as before, so its installs keep matching", async () => {
    put('sample-crm-sales', 'sample-crm-sales@0.1.0')
    put('sample-hub', 'sample-hub@0.1.0')
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    expect(shelf.find('c', 'sample-crm-sales', '0.1.0')!.fingerprint).toBe(legacyFingerprint(join(root, 'sample-crm-sales@0.1.0')))
    expect(shelf.find('c', 'sample-hub', '0.1.0')!.fingerprint).toBe(legacyFingerprint(join(root, 'sample-hub@0.1.0')))
  })

  it('uses a contract-2 package with steps/ and ui/, fingerprinted v2 over every file: one byte changes it, the signature slot does not', async () => {
    put('sample-flow', 'sample-flow@0.2.0')
    const shelf = createPluginShelf(diskPluginShelf(root))
    expect((await shelf.load()).loaded).toEqual(['sample-flow@0.2.0'])
    const p = shelf.find('c', 'sample-flow', '0.2.0')!
    expect(Object.keys(p.steps).sort()).toEqual(['steps/proposal.md', 'steps/read-minutes.md'])
    expect(p.ui).toEqual(['ui/assets/app.js', 'ui/deal.html', 'ui/index.html'])
    expect(p.signature).toBeNull()
    const base = p.fingerprint
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    // One byte in a frame's script, a file added: each changes it.
    const app = join(root, 'sample-flow@0.2.0/ui/assets/app.js')
    const original = readFileSync(app)
    writeFileSync(app, Buffer.concat([original, Buffer.from(' ')]))
    await shelf.load()
    expect(shelf.find('c', 'sample-flow', '0.2.0')!.fingerprint).not.toBe(base)
    writeFileSync(app, original)
    await shelf.load()
    expect(shelf.find('c', 'sample-flow', '0.2.0')!.fingerprint).toBe(base)
    const step = join(root, 'sample-flow@0.2.0/steps/proposal.md')
    writeFileSync(step, `${readFileSync(step, 'utf8')}.`)
    await shelf.load()
    expect(shelf.find('c', 'sample-flow', '0.2.0')!.fingerprint).not.toBe(base)
    writeFileSync(step, readFileSync(step, 'utf8').slice(0, -1))
    writeFileSync(join(root, 'sample-flow@0.2.0/ui/extra.css'), '')
    await shelf.load()
    expect(shelf.find('c', 'sample-flow', '0.2.0')!.fingerprint).not.toBe(base)
    rmSync(join(root, 'sample-flow@0.2.0/ui/extra.css'))
    // The signature slot: read for shape, never part of the fingerprint, never verified.
    writeFileSync(join(root, 'sample-flow@0.2.0/signature.yaml'), `signer: div\nalgorithm: ed25519\nkey_id: div-2026\nvalue: ${'A'.repeat(86)}==\n`)
    await shelf.load()
    const signed = shelf.find('c', 'sample-flow', '0.2.0')!
    expect(signed.fingerprint).toBe(base)
    expect(signed.signature).toMatchObject({ signer: 'div', keyId: 'div-2026' })
  })

  it('refuses scripts/, other files in ui/ and steps/, and the v2 folders or a signature on a contract-1 package', async () => {
    const variants: Record<string, (dir: string) => void> = {
      'with-scripts@0.2.0': d => { mkdirSync(join(d, 'scripts')); writeFileSync(join(d, 'scripts/rank.js'), 'x') },
      'ui-exe@0.2.0': d => writeFileSync(join(d, 'ui/tool.sh'), 'echo'),
      'ui-link@0.2.0': d => symlinkSync(join(d, 'plugin.yaml'), join(d, 'ui/link.html')),
      'steps-deep@0.2.0': d => { mkdirSync(join(d, 'steps/more')) },
      'bad-signature@0.2.0': d => writeFileSync(join(d, 'signature.yaml'), 'signer: anyone\n'),
    }
    for (const [dir, change] of Object.entries(variants)) {
      put('sample-flow', dir)
      renameTo(dir)
      change(join(root, dir))
    }
    put('sample-sales', 'old-steps@0.1.0')
    renameTo('old-steps@0.1.0')
    mkdirSync(join(root, 'old-steps@0.1.0/steps'))
    writeFileSync(join(root, 'old-steps@0.1.0/steps/a.md'), '# a')
    put('sample-sales', 'old-signed@0.1.0')
    renameTo('old-signed@0.1.0')
    writeFileSync(join(root, 'old-signed@0.1.0/signature.yaml'), `signer: div\nalgorithm: ed25519\nkey_id: k\nvalue: ${'A'.repeat(86)}==\n`)

    const result = await createPluginShelf(diskPluginShelf(root)).load()
    expect(result.loaded).toEqual([])
    const refused = Object.fromEntries(result.refused.map(r => [r.dir, r.reason]))
    expect(refused['with-scripts@0.2.0']).toMatch(/scripts\/ is not allowed/)
    expect(refused['ui-exe@0.2.0']).toMatch(/ui\/ holds only/)
    expect(refused['ui-link@0.2.0']).toMatch(/only plain files/)
    expect(refused['steps-deep@0.2.0']).toMatch(/plain files|steps\/ holds only/)
    expect(refused['bad-signature@0.2.0']).toMatch(/signer は div か/)
    expect(refused['old-steps@0.1.0']).toMatch(/手順書（steps\/）は置けません/)
    expect(refused['old-signed@0.1.0']).toMatch(/contract: 2 の包みだけ/)
  })
})
