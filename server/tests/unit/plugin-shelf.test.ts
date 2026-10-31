/**
 * The plugin shelf (adapters/plugin-shelf.ts + services/plugin-shelf.ts,
 * `.claude/rules/plugins.md`): only packages that are data and pass the core's
 * rules are used; anything else on the shelf is refused with the folder name
 * and a reason (never the file's content). The fingerprint changes with any
 * file, and `available_to` hides a package from companies not listed. The
 * operator's stop list is read on every call and fails closed.
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
    expect(result.loaded).toEqual(['sample-crm@0.1.0'])
    const refused = Object.fromEntries(result.refused.map(r => [r.dir, r.reason]))
    expect(Object.keys(refused).sort()).toEqual(['Not A Package', 'bad-key@0.1.0', 'linked@0.1.0', 'sample-crm@9.9.9', 'with-code@0.1.0'])
    expect(refused['bad-key@0.1.0']).toMatch(/プログラムは書けません/)
    expect(JSON.stringify(result.refused)).not.toContain('SECRET-CONTENT')
    expect(shelf.packagesFor('any-company').map(p => p.pkg.manifest.id)).toEqual(['sample-crm'])
  })

  it('a changed file changes the fingerprint', async () => {
    put('sample-crm', 'sample-crm@0.1.0')
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    const before = shelf.find('c', 'sample-crm', '0.1.0')!.fingerprint
    const types = join(root, 'sample-crm@0.1.0/types/deal.md')
    writeFileSync(types, readFileSync(types, 'utf8').replace('# 案件', '# 案件（変えた）'))
    await shelf.load()
    expect(shelf.find('c', 'sample-crm', '0.1.0')!.fingerprint).not.toBe(before)
  })

  it('a package listed for other companies does not exist for this one', async () => {
    put('sample-desk', 'sample-desk@2.3.1')
    const shelf = createPluginShelf(diskPluginShelf(root))
    await shelf.load()
    expect(shelf.packagesFor('company-desk-only').map(p => p.pkg.manifest.id)).toEqual(['sample-desk'])
    expect(shelf.find('company-desk-only', 'sample-desk', '2.3.1')).not.toBeNull()
    expect(shelf.packagesFor('someone-else')).toEqual([])
    expect(shelf.find('someone-else', 'sample-desk', '2.3.1')).toBeNull()
  })

  it('the stop list is read on every call and fails closed when unreadable', async () => {
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
