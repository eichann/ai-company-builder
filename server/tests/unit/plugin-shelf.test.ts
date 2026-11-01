/**
 * The plugin shelf (adapters/plugin-shelf.ts + services/plugin-shelf.ts,
 * `.claude/rules/plugins.md`): only packages that are data and pass the core's
 * rules are used; anything else on the shelf is refused with the folder name
 * and a reason (never the file's content). The fingerprint changes with any
 * file, and `available_to` hides a package from companies not listed. The
 * operator's stop list is read on every call and fails closed. A connector is
 * checked against the business plugin version it maps to (owner decision
 * 2026-11-01) and exists for a company only where that plugin does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
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
    rename('linked@0.1.0')
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
    // The connector carries the business plugin's types (it owns none).
    expect(Object.keys(shelf.find('any-company', 'sample-crm', '0.1.0')!.pkg.types).sort()).toEqual(['customer', 'deal'])
  })

  it('a connector whose business version is not on the shelf, or of the old shape with its own types, is refused (owner decision 2026-11-01)', async () => {
    put('sample-sales', 'sample-sales@0.1.0')
    rename('needs-other@0.1.0')
    const needs = join(root, 'needs-other@0.1.0/plugin.yaml')
    writeFileSync(needs, readFileSync(needs, 'utf8').replace('maps_to: sample-sales@0.1.0', 'maps_to: sample-sales@0.2.0'))
    // hubspot@0.1.x's shape: the connector brought deal / customer itself.
    rename('old-shape@0.1.0')
    const old = join(root, 'old-shape@0.1.0/plugin.yaml')
    writeFileSync(old, readFileSync(old, 'utf8').replace('maps_to: sample-sales@0.1.0', 'types: [deal, customer]'))
    cpSync(join(FIXTURES, 'sample-sales/types'), join(root, 'old-shape@0.1.0/types'), { recursive: true })
    const shelf = createPluginShelf(diskPluginShelf(root))
    const result = await shelf.load()
    expect(result.loaded).toEqual(['sample-sales@0.1.0'])
    const refused = Object.fromEntries(result.refused.map(r => [r.dir, r.reason]))
    expect(refused['needs-other@0.1.0']).toContain('sample-sales@0.2.0 が棚にありません')
    expect(refused['old-shape@0.1.0']).toContain('型を持ちません')
  })

  it('a changed file changes the fingerprint (of the package it is in)', async () => {
    put('sample-sales', 'sample-sales@0.1.0')
    put('sample-crm', 'sample-crm@0.1.0')
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    const before = shelf.find('c', 'sample-crm', '0.1.0')!.fingerprint
    const businessBefore = shelf.find('c', 'sample-sales', '0.1.0')!.fingerprint
    const types = join(root, 'sample-sales@0.1.0/types/deal.md')
    writeFileSync(types, readFileSync(types, 'utf8').replace('# 案件', '# 案件（変えた）'))
    await shelf.load()
    expect(shelf.find('c', 'sample-sales', '0.1.0')!.fingerprint).not.toBe(businessBefore)
    const mapping = join(root, 'sample-crm@0.1.0/mapping.yaml')
    writeFileSync(mapping, readFileSync(mapping, 'utf8').replace('# The recommended mapping', '# The recommended mapping (changed)'))
    await shelf.load()
    expect(shelf.find('c', 'sample-crm', '0.1.0')!.fingerprint).not.toBe(before)
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

  it('a connector exists for a company only where the business plugin it maps to does', async () => {
    put('sample-sales', 'sample-sales@0.1.0')
    put('sample-crm', 'sample-crm@0.1.0')
    const sales = join(root, 'sample-sales@0.1.0/plugin.yaml')
    writeFileSync(sales, readFileSync(sales, 'utf8').replace('contract: 1', 'contract: 1\navailable_to: [only-this-one]'))
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    expect(shelf.packagesFor('only-this-one').map(p => p.pkg.manifest.id)).toEqual(['sample-crm', 'sample-sales'])
    expect(shelf.packagesFor('someone-else')).toEqual([])
    expect(shelf.find('someone-else', 'sample-crm', '0.1.0')).toBeNull()
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
