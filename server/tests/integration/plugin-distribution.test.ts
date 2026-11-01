/**
 * Integration Test: handing business plugins' packages to the members' apps
 * (plan C2 「配る道」, `.claude/rules/plugins.md` "Handing packages to the
 * app") on the real services and database.
 *
 * - The agent policy lists the company's turned-on contract-2 business
 *   plugins with their v2 fingerprint — not contract 1, not connectors, not
 *   another company's, not one turned off or stopped by the operator.
 * - Any member gets the files of a listed version, whose v2 fingerprint is
 *   the listed one; anything not listed is the same 404 as nothing; a package
 *   replaced on disk is not handed out.
 * - Pinned older versions (C5) are listed while on the shelf with the pinned
 *   fingerprint; the operator's stop and turning the plugin off override pins.
 * - A company's extension of a plugin type survives a newer version: the
 *   conflict is reported (409) and nothing is stored over it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { pluginFingerprintV2 } from '../../../shared/core/plugin-fingerprint'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const CO = 'pd-co'
const OTHER = 'pd-other'
const EXT = 'pd-ext'
const ts = () => new Date().toISOString()
const FIXTURES = join(__dirname, '../fixtures/plugins')
const sha256Hex = (d: Uint8Array | string) => createHash('sha256').update(d).digest('hex')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any, services: any
let shelfDir: string
const owner = { companyId: CO, userId: 'pd-owner', role: 'owner' }
const member = { companyId: CO, userId: 'pd-member', role: 'member' }
const otherOwner = { companyId: OTHER, userId: 'pd-other-owner', role: 'owner' }
const otherMember = { companyId: OTHER, userId: 'pd-other-member', role: 'member' }
const extOwner = { companyId: EXT, userId: 'pd-ext-owner', role: 'owner' }

/** sample-flow under another version (no upgrade point: nothing older to move from). */
function putFlow(version: string, edit: (yaml: string) => string = y => y): void {
  const dir = join(shelfDir, `sample-flow@${version}`)
  cpSync(join(FIXTURES, 'sample-flow'), dir, { recursive: true })
  const file = join(dir, 'plugin.yaml')
  writeFileSync(file, edit(readFileSync(file, 'utf8').replace('version: 0.2.0', `version: ${version}`).replace(/\nupgrade:[\s\S]*$/, '\n')))
}

const policyOf = async (m: Json) => (await services.agentPolicy.policyFor(m)).plugins as Json[]
const fingerprintOf = (dir: string) => services.pluginShelf.find(CO, 'sample-flow', dir).fingerprint as string
const stop = (lines: string) => writeFileSync(join(shelfDir, 'stopped'), lines)
const unstop = () => rmSync(join(shelfDir, 'stopped'), { force: true })

beforeAll(async () => {
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-pd-shelf-'))
  putFlow('0.1.0')
  putFlow('0.2.0')
  // A newer version whose deal type goes past a company's extension (EXT).
  putFlow('0.3.0', y => y)
  const deal3 = join(shelfDir, 'sample-flow@0.3.0', 'types', 'deal.md')
  writeFileSync(deal3, readFileSync(deal3, 'utf8').replace('version: 2', 'version: 4').replace('  purpose:', '  region:     { label: 地域, kind: text, source: server }\n  purpose:'))
  cpSync(join(FIXTURES, 'sample-sales'), join(shelfDir, 'sample-sales@0.1.0'), { recursive: true })
  cpSync(join(FIXTURES, 'sample-hub'), join(shelfDir, 'sample-hub@0.1.0'), { recursive: true })

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  for (const co of [CO, OTHER, EXT]) db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'x', ts(), ts())
  for (const m of [owner, member, otherOwner, otherMember, extOwner]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, m.companyId, m.role, ts(), ts())
  }
  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { pluginsDir: shelfDir })
  await services.pluginShelf.load()
})

afterAll(() => {
  rmSync(shelfDir, { recursive: true, force: true })
})

describe('the agent policy lists the packages the app keeps', () => {
  it('a turned-on contract-2 business plugin, with its v2 fingerprint; not contract 1, not a connector, not another company', async () => {
    expect(await policyOf(member)).toEqual([])
    const before = (await services.agentPolicy.policyFor(member)).version
    // The other company turns on a contract-1 business plugin and a connector: nothing for its apps.
    expect((await services.plugins.install(otherOwner, 'sample-sales', { version: '0.1.0', keyId: null })).ok).toBe(true)
    expect((await services.plugins.setEnabled(otherOwner, 'sample-sales', { enabled: true })).ok).toBe(true)
    expect(await policyOf(otherMember)).toEqual([])

    expect((await services.plugins.install(owner, 'sample-flow', { version: '0.2.0', keyId: null })).ok).toBe(true)
    expect(await policyOf(member)).toEqual([]) // installed, not on
    expect((await services.plugins.setEnabled(owner, 'sample-flow', { enabled: true })).ok).toBe(true)
    const listed = await policyOf(member)
    expect(listed).toEqual([{ id: 'sample-flow', version: '0.2.0', fingerprint: fingerprintOf('0.2.0'), use: 'current' }])
    expect((await services.agentPolicy.policyFor(member)).version).not.toBe(before)
    expect(await policyOf(otherMember)).toEqual([])
  })

  it('any member gets the files of a listed version, and they make the listed fingerprint', async () => {
    const got = await services.pluginDistribution.packageFor(member, 'sample-flow', '0.2.0')
    expect(got.ok).toBe(true)
    const files = (got.value.files as Json[]).map(f => ({ path: f.path as string, bytes: new Uint8Array(Buffer.from(f.base64, 'base64')) }))
    expect(files.map(f => f.path).sort()).toEqual([
      'plugin.yaml', 'steps/proposal.md', 'steps/read-minutes.md', 'types/customer.md', 'types/deal.md',
      'ui/assets/app.js', 'ui/deal.html', 'ui/index.html',
    ])
    expect(pluginFingerprintV2(files, sha256Hex)).toBe(fingerprintOf('0.2.0'))
    expect(got.value.fingerprint).toBe(fingerprintOf('0.2.0'))
  })

  it('anything not listed is the same 404 as nothing: another company, another version, a connector, a contract-1 plugin', async () => {
    const missing = await services.pluginDistribution.packageFor(member, 'no-such-plugin', '0.1.0')
    expect(missing).toMatchObject({ ok: false, kind: 'not-found', body: { code: 'PLUGIN_NOT_FOUND' } })
    expect(await services.pluginDistribution.packageFor(otherMember, 'sample-flow', '0.2.0')).toEqual(missing)
    expect(await services.pluginDistribution.packageFor(member, 'sample-flow', '0.1.0')).toEqual(missing)
    expect(await services.pluginDistribution.packageFor(otherMember, 'sample-sales', '0.1.0')).toEqual(missing)
    expect(await services.pluginDistribution.packageFor(otherMember, 'sample-hub', '0.1.0')).toEqual(missing)
  })

  it('the operator\'s stop removes it from the policy and stops the files at once', async () => {
    stop('sample-flow@0.2.0\n')
    try {
      expect(await policyOf(member)).toEqual([])
      expect(await services.pluginDistribution.packageFor(member, 'sample-flow', '0.2.0')).toMatchObject({ ok: false, kind: 'not-found' })
    } finally { unstop() }
    expect(await policyOf(member)).toHaveLength(1)
  })

  it('a package replaced on disk under the same version is not handed out', async () => {
    const file = join(shelfDir, 'sample-flow@0.2.0', 'ui', 'index.html')
    const original = readFileSync(file)
    writeFileSync(file, Buffer.concat([original, Buffer.from(' ')]))
    try {
      expect(await services.pluginDistribution.packageFor(member, 'sample-flow', '0.2.0')).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'PACKAGE_CHANGED' } })
    } finally { writeFileSync(file, original) }
    expect((await services.pluginDistribution.packageFor(member, 'sample-flow', '0.2.0')).ok).toBe(true)
  })

  it('pinned older versions are kept while pinned; the operator\'s stop and turning off override pins', async () => {
    const { createPluginDistribution } = await import('../../src/services/plugin-distribution')
    const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
    let pins = [{ version: '0.1.0', fingerprint: fingerprintOf('0.1.0') }]
    const pinned = createPluginDistribution({ companyData: sqliteCompanyData(db), shelf: services.pluginShelf, pinnedVersions: () => pins })
    expect(await pinned.pluginsFor(CO)).toEqual([
      { id: 'sample-flow', version: '0.1.0', fingerprint: fingerprintOf('0.1.0'), use: 'pinned' },
      { id: 'sample-flow', version: '0.2.0', fingerprint: fingerprintOf('0.2.0'), use: 'current' },
    ])
    expect((await pinned.packageFor(member, 'sample-flow', '0.1.0')).ok).toBe(true)
    // A pin to other content than the shelf's is not handed out.
    pins = [{ version: '0.1.0', fingerprint: '0'.repeat(64) }]
    expect((await pinned.pluginsFor(CO)).map(p => p.version)).toEqual(['0.2.0'])
    pins = [{ version: '0.1.0', fingerprint: fingerprintOf('0.1.0') }]
    stop('sample-flow@0.1.0\n')
    try {
      expect((await pinned.pluginsFor(CO)).map(p => p.version)).toEqual(['0.2.0'])
    } finally { unstop() }
    expect((await services.plugins.setEnabled(owner, 'sample-flow', { enabled: false })).ok).toBe(true)
    expect(await pinned.pluginsFor(CO)).toEqual([])
    expect(await policyOf(member)).toEqual([])
    expect(await services.pluginDistribution.packageFor(member, 'sample-flow', '0.2.0')).toMatchObject({ ok: false, kind: 'not-found' })
  })
})

describe('a company\'s extension of a plugin type survives a newer plugin version', () => {
  const typeRows = () => db.prepare("SELECT name, version, source FROM record_types WHERE company_id = ? AND name = 'deal' ORDER BY version").all(EXT)

  it('reports the conflict and stores nothing over the company\'s fields', async () => {
    expect((await services.plugins.install(extOwner, 'sample-flow', { version: '0.2.0', keyId: null })).ok).toBe(true)
    expect((await services.plugins.setEnabled(extOwner, 'sample-flow', { enabled: true })).ok).toBe(true)
    // The company extends deal (version 3: one field of its own), as its .acb/types/deal.md would.
    const base = readFileSync(join(FIXTURES, 'sample-flow', 'types', 'deal.md'), 'utf8')
    const extended = parseTypeFile('deal', base.replace('version: 2', 'version: 3').replace('  purpose:', '  budget_code: { label: 予算コード, kind: text, source: server }\n  purpose:'))
    if (!extended.ok) throw new Error(extended.errors.join(' / '))
    db.prepare('INSERT INTO record_types (company_id, name, version, definition, source, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(EXT, 'deal', 3, canonicalTypeJson(extended.definition), 'file', 'abc', ts())
    const before = typeRows()

    // Turning it off and on again with the same version: the extension holds everything, no conflict.
    expect((await services.plugins.setEnabled(extOwner, 'sample-flow', { enabled: false })).ok).toBe(true)
    expect((await services.plugins.setEnabled(extOwner, 'sample-flow', { enabled: true })).ok).toBe(true)
    expect(typeRows()).toEqual(before)

    // 0.3.0's deal (version 4, a new field) would go over the company's version 3.
    const changed = await services.plugins.install(extOwner, 'sample-flow', { version: '0.3.0', keyId: null })
    expect(changed).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'TYPE_EXTENSION_CONFLICT' } })
    const conflicts = changed.body.conflicts as string[]
    expect(conflicts.some(c => c.includes('版 3') && c.includes('版 4'))).toBe(true)
    expect(conflicts.some(c => c.includes('region'))).toBe(true)
    expect(db.prepare("SELECT version FROM plugin_installs WHERE company_id = ? AND plugin_id = 'sample-flow'").get(EXT).version).toBe('0.2.0')
    expect(typeRows()).toEqual(before)

    // Off, the version can be chosen; turning it on is refused the same way.
    expect((await services.plugins.setEnabled(extOwner, 'sample-flow', { enabled: false })).ok).toBe(true)
    expect((await services.plugins.install(extOwner, 'sample-flow', { version: '0.3.0', keyId: null })).ok).toBe(true)
    expect(await services.plugins.setEnabled(extOwner, 'sample-flow', { enabled: true })).toMatchObject({ ok: false, body: { code: 'TYPE_EXTENSION_CONFLICT' } })
    expect(typeRows()).toEqual(before)
  })
})
