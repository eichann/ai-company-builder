/**
 * Integration Test: the connector and the import (milestone 3 P5,
 * `.claude/rules/plugins.md` "Import"), on the real services, database, key
 * broker and a real company repository, against the fake HubSpot.
 *
 * - Imported records are server-only: no file, no commit in the company
 *   repository (owner rule §8-3).
 * - The ledger holds each observed change as `external`, with a receipt
 *   (plugin, version, fingerprint, mapping version, connection, account,
 *   outside id) — never the key.
 * - Only the declared calls leave ACB, to the declared host.
 * - Records are visible where the mapping says (readers of 営業部 only).
 * - The connection is bound to the outside account; another account stops
 *   everything until a new connection, whose records never mix with the old.
 * - One run per company at a time; a stop between requests ends the run.
 * - A single record is refreshed only for someone who may read it (nothing is
 *   asked outside for anyone else).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createFakeHubSpot, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'
import { fakeUpstream } from '../helpers/fake-upstream'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// Creating a real company repository (and its hook) can take a while on a busy machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const KEY = 'pat-fake-NOT-REAL-import-0123456789'
const FIXTURE = join(__dirname, '../fixtures/plugins/sample-hub')
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any, services: any
let kekDir: string, shelfDir: string
let CO: string
let owner: Json, member: Json, reader: Json
let fake: FakeHubSpot
let way: ReturnType<typeof fakeUpstream>
const logged: string[] = []

const MAPPING = `
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
    max: 500
  fields:
    title:      { from: dealname, write: false }
    stage:      { from: dealstage, write: true, values: { appointmentscheduled: first_meeting, qualifiedtobuy: proposal, presentationscheduled: quote, decisionmakerboughtin: final } }
    confidence: { from: juchu_kakudo, write: true, values: { high: a, medium: b, low: c } }
    next_step:  { from: hs_next_step, write: true }
    close_date: { from: closedate, write: true }
    amount:     { from: amount, write: true }
    assignee:   { from: hubspot_owner_id, write: false, people: owners }
  links:
    customer:   { from_association: companies }
company:
  visible_to_folder: 営業部
  fields:
    title: { from: name, write: false }
people:
  owners:
    "75123001": im-member
`

const git = promisify(execFile)
const commits = async () => {
  const { REPOS_DIR } = await import('../../src/lib/config')
  return (await git('git', ['rev-list', '--all', '--count'], { cwd: join(REPOS_DIR, `${CO}.git`) })).stdout.trim()
}
const deals = () => db.prepare("SELECT * FROM records WHERE company_id = ? AND type = 'deal' ORDER BY id").all(CO) as Json[]
const linkOf = (recordId: string) => db.prepare('SELECT * FROM plugin_external_links WHERE company_id = ? AND record_id = ?').get(CO, recordId) as Json
const recordOf = (externalId: string) => (db.prepare("SELECT record_id FROM plugin_external_links WHERE company_id = ? AND object = 'deal' AND external_id = ? ORDER BY seen_at DESC").get(CO, externalId) as Json)?.record_id

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')) })
  kekDir = mkdtempSync(join(tmpdir(), 'acb-im-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-im-shelf-'))
  cpSync(FIXTURE, join(shelfDir, 'sample-hub@0.1.0'), { recursive: true })

  fake = createFakeHubSpot()
  fake.addKey(KEY)
  way = fakeUpstream(() => fake.app)

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { pluginsDir: shelfDir, upstream: way })
  await services.pluginShelf.load()
  const company = await services.companies.create('im-owner', 'Import', 'import')
  CO = company.id
  owner = { companyId: CO, userId: 'im-owner', role: 'owner' }
  member = { companyId: CO, userId: 'im-member', role: 'member' }
  reader = { companyId: CO, userId: 'im-reader', role: 'member' }
  for (const m of [member, reader]) db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, CO, m.role, ts(), ts())
  // 営業部: only im-member (and owners / admins) may read it.
  let sales = (db.prepare("SELECT id FROM scopes WHERE company_id = ? AND path = '営業部'").get(CO) as Json)?.id as string | undefined
  if (!sales) {
    sales = 'im-s-sales'
    db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '営業部', 'folder', ?)`).run(sales, CO, ts())
  }
  db.prepare('DELETE FROM scope_rules WHERE company_id = ? AND scope_id = ?').run(CO, sales)
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'im-r1', ?, 'everyone', NULL, 0, 0, ?)`).run(CO, sales, ts())
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'im-r2', ?, 'user', 'im-member', 1, 1, ?)`).run(CO, sales, ts())
  db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(CO, ts(), 'im-owner')

  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: KEY, audience })).value.keys[0].id
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING })).ok).toBe(true)
  expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
})

afterAll(() => {
  fake.close()
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('import from the outside system', () => {
  it('brings deals in as server-only records — no file, no commit — with an external ledger entry and a receipt', async () => {
    const before = await commits()
    const r = await services.pluginImport.run(owner, 'sample-hub')
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({ status: 'complete', reason: null, objects: { deal: { seen: 10, created: 10, updated: 0, truncated: false } } })
    // Stages and owners the mapping does not translate are reported by field name, never value.
    expect(Object.keys(r.value.objects.deal.problems).sort()).toEqual(['欄「assignee」: 担当者の対応表にない番号です', '欄「stage」: 読み替え表にない値です'])
    expect(await commits()).toBe(before)
    const rows = deals()
    expect(rows).toHaveLength(10)
    expect(rows.every(d => d.path === null && d.scope_id === null && d.folder === '営業部')).toBe(true)
    const sample = rows.find(d => d.title === '研修導入（株式会社サンプル）')
    const state = JSON.parse(db.prepare('SELECT fields FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, sample.id).fields)
    expect(state).toMatchObject({ stage: 'proposal', confidence: 'b', next_step: '資料送付', amount: 1200000, close_date: '2026-12-15', assignee: 'im-member' })
    const [entry] = services.recordEngine.history(owner, sample.id).value.entries
    expect(entry).toMatchObject({ action: 'create', actorKind: 'external', actorSource: 'sample-hub' })
    expect(entry.receipt).toMatchObject({
      plugin: 'sample-hub', pluginVersion: '0.1.0', mappingVersion: 1, accountId: '90000001', object: 'deal', externalId: '1000000001', kind: 'observed', operationId: null,
    })
    expect(linkOf(sample.id)).toMatchObject({ account_id: '90000001', object: 'deal', external_id: '1000000001' })
    // The customer: a server-only record linked from the deal (name only).
    const customer = db.prepare("SELECT r.* FROM record_links l JOIN records r ON r.company_id = l.company_id AND r.id = l.target_id WHERE l.company_id = ? AND l.source_id = ? AND l.name = 'customer'").get(CO, sample.id) as Json
    expect(customer).toMatchObject({ type: 'customer', title: '株式会社サンプル', path: null })
  })

  it('a change made in the outside system arrives as one external entry with before / after; the rest is unchanged', async () => {
    fake.changeDealOutside('1000000001', { juchu_kakudo: 'high', hs_next_step: '11/7 デモ' })
    const r = await services.pluginImport.run(owner, 'sample-hub')
    expect(r.value.objects.deal).toMatchObject({ seen: 10, created: 0, updated: 1, unchanged: 9 })
    const entries = services.recordEngine.history(owner, recordOf('1000000001')).value.entries
    expect(entries.at(-1)).toMatchObject({
      version: 2, action: 'sample-hub.import', actorKind: 'external',
      changes: [{ field: 'confidence', before: 'b', after: 'a' }, { field: 'next_step', before: '資料送付', after: '11/7 デモ' }],
      receipt: { kind: 'observed', externalId: '1000000001' },
    })
  })

  it('only the declared calls, to the declared host; the key never appears in the database or the logs', () => {
    const declared = [/^\/account-info\/v3\/details$/, /^\/crm\/objects\/2026-09\/deals\/search$/, /^\/crm\/objects\/2026-03\/deals\/\d+\?/, /^\/crm\/objects\/2026-03\/companies\/\d+\?/]
    expect(way.sent.length).toBeGreaterThan(10)
    for (const s of way.sent) {
      expect(s.host).toBe('api.hubapi.com')
      expect(declared.some(d => d.test(s.path)), s.path).toBe(true)
    }
    const everything = JSON.stringify(['records', 'record_state', 'record_ledger', 'plugin_history', 'plugin_external_links', 'plugin_installs']
      .map(t => db.prepare(`SELECT * FROM ${t}`).all()))
    expect(everything).not.toContain(KEY)
    expect(logged.join('\n')).not.toContain(KEY)
  })

  it('deals are visible where the mapping says: not to someone who cannot read 営業部', () => {
    const q = (m: Json) => services.records.query(m, { type: 'deal', countOnly: true })
    expect(q(member).value.total).toBe(10)
    expect(q(reader).value.total).toBe(0)
  })
})

describe('one record at a time', () => {
  it('refreshes only for someone who may read it; nothing is asked outside for anyone else', async () => {
    const id = recordOf('1000000003')
    const n = way.sent.length
    expect(await services.pluginImport.refreshRecord(reader, 'sample-hub', id)).toMatchObject({ ok: false, kind: 'not-found' })
    expect(way.sent.length).toBe(n)
    fake.changeDealOutside('1000000003', { amount: '2500000' })
    const r = await services.pluginImport.refreshRecord(member, 'sample-hub', id)
    expect(r).toMatchObject({ ok: true, value: { changed: true, accountId: '90000001' } })
    expect(JSON.parse(db.prepare('SELECT fields FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id).fields).amount).toBe(2500000)
  })
})

describe('runs, stops and connections', () => {
  it('one run per company at a time', async () => {
    fake.faults.delayMs = 20
    const first = services.pluginImport.run(owner, 'sample-hub')
    await new Promise(r => setTimeout(r, 5))
    expect(await services.pluginImport.run(owner, 'sample-hub')).toMatchObject({ ok: false, body: { code: 'IMPORT_RUNNING' } })
    expect((await first).ok).toBe(true)
    fake.faults.delayMs = 0
  })

  it('a stop between requests ends the run: nothing more is sent', async () => {
    fake.faults.delayMs = 20
    const run = services.pluginImport.run(owner, 'sample-hub')
    await new Promise(r => setTimeout(r, 60))
    writeFileSync(join(shelfDir, 'stopped'), 'sample-hub\n')
    const r = await run
    const n = way.sent.length
    expect(r.value).toMatchObject({ status: 'stopped', reason: 'stopped' })
    rmSync(join(shelfDir, 'stopped'))
    fake.faults.delayMs = 0
    expect(way.sent.length).toBe(n)
  })

  it('another outside account stops everything until a new connection, whose records never mix with the old ones', async () => {
    const before = deals().length
    const ledger = db.prepare('SELECT COUNT(*) AS n FROM record_ledger WHERE company_id = ?').get(CO).n
    const old = fake
    fake = createFakeHubSpot({ portalId: 90000002 })
    fake.addKey(KEY)
    const r = await services.pluginImport.run(owner, 'sample-hub')
    expect(r).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'ACCOUNT_CHANGED' } })
    expect(await services.pluginImport.refreshRecord(member, 'sample-hub', recordOf('1000000001'))).toMatchObject({ ok: false, body: { code: 'ACCOUNT_CHANGED' } })
    expect(deals().length).toBe(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM record_ledger WHERE company_id = ?').get(CO).n).toBe(ledger)

    expect(services.pluginImport.renewConnection(owner, 'sample-hub').ok).toBe(true)
    const again = await services.pluginImport.run(owner, 'sample-hub')
    expect(again.value.objects.deal).toMatchObject({ created: 10 })
    expect(deals().length).toBe(before + 10)
    // The same outside id in two accounts: two records, each under its own account.
    const both = db.prepare("SELECT account_id FROM plugin_external_links WHERE company_id = ? AND object = 'deal' AND external_id = '1000000001' ORDER BY account_id").all(CO)
    expect(both.map((b: Json) => b.account_id)).toEqual(['90000001', '90000002'])
    old.close()
  })

  it('the records switch off: no import', async () => {
    db.prepare('UPDATE record_settings SET enabled = 0 WHERE company_id = ?').run(CO)
    expect(await services.pluginImport.run(owner, 'sample-hub')).toMatchObject({ ok: false, body: { code: 'RECORDS_DISABLED' } })
    db.prepare('UPDATE record_settings SET enabled = 1 WHERE company_id = ?').run(CO)
  })

  it('deleting the key the plugin uses is allowed, and leaves the plugin without a key', async () => {
    const keyId = db.prepare("SELECT key_id FROM plugin_installs WHERE company_id = ?").get(CO).key_id
    expect(services.keyBroker.delete(owner, keyId).ok).toBe(true)
    expect(await services.plugins.active(CO, 'sample-hub')).toEqual({ ok: false, problem: 'no-key' })
    expect(await services.pluginImport.run(owner, 'sample-hub')).toMatchObject({ ok: false, body: { code: 'PLUGIN_NOT_ACTIVE', problem: 'no-key' } })
  })
})
