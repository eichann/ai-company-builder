/**
 * Integration Test: 「HubSpot に聞いて確かめる」 (milestone 3 P8,
 * `.claude/rules/plugins.md` "The mapping"), on the real services, database
 * and key broker, against the fake HubSpot.
 *
 * - It works right after install — plugin off, auto fields not acknowledged
 *   — on the text being edited: unknown properties / values and a write to a
 *   read-only property are errors, a write to a property HubSpot sets itself
 *   is a warning.
 * - It writes nothing (no mapping version, no account binding, no record).
 * - Owners / admins only; the operator's stop and an invalid text send nothing.
 * - A key HubSpot refuses → "could not ask", and the key value is nowhere.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { createFakeHubSpot, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'
import { fakeUpstream } from '../helpers/fake-upstream'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const KEY = 'pat-fake-NOT-REAL-mapcheck-0123456789'
const FIXTURE = join(__dirname, '../fixtures/plugins/sample-hub')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any, services: any
let kekDir: string, shelfDir: string
let CO: string
let owner: Json, admin: Json, member: Json
let fake: FakeHubSpot
let way: ReturnType<typeof fakeUpstream>
const logged: string[] = []

/** A mapping with one of each finding against the fake's property list. */
const MAPPING = `
deal:
  visible_to_folder: 営業部
  fields:
    title:      { from: dealname, write: false }
    confidence: { from: juchu_kakudo, write: true, values: { high: a, medium: b, huge: c } }
    next_step:  { from: hs_next_stepp, write: true }
    amount:     { from: hs_deal_stage_probability, write: true }
    closed:     { from: hs_is_closed_won, write: true }
`

const ts = () => new Date().toISOString()
const versions = () => (db.prepare('SELECT COUNT(*) AS n FROM plugin_mappings WHERE company_id = ?').get(CO) as Json).n as number
const install = () => db.prepare('SELECT * FROM plugin_installs WHERE company_id = ? AND plugin_id = ?').get(CO, 'sample-hub') as Json
const check = (who: Json, body: unknown) => services.pluginMappingCheck.check(who, 'sample-hub', body)

beforeAll(async () => {
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')) })
  kekDir = mkdtempSync(join(tmpdir(), 'acb-mc-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-mc-shelf-'))
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
  const company = await services.companies.create('mc-owner', 'MapCheck', 'mapcheck')
  CO = company.id
  owner = { companyId: CO, userId: 'mc-owner', role: 'owner' }
  admin = { companyId: CO, userId: 'mc-admin', role: 'admin' }
  member = { companyId: CO, userId: 'mc-member', role: 'member' }
  for (const m of [admin, member]) db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, CO, m.role, ts(), ts())

  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: KEY, audience })).value.keys[0].id
  // Installed only: off, no mapping saved, nothing acknowledged.
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
})

afterAll(() => {
  fake.close()
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('「HubSpot に聞いて確かめる」', () => {
  it('checks the text being edited against HubSpot before the plugin is on, and writes nothing', async () => {
    const sentBefore = way.sent.length
    const r = await check(admin, { text: MAPPING })
    expect(r.ok).toBe(true)
    expect(r.value.reachable).toBe(true)
    const { errors, warnings } = r.value.objects.deal
    expect(errors.some((e: string) => e.includes('hs_next_stepp'))).toBe(true)
    expect(errors.some((e: string) => e.includes('huge'))).toBe(true)
    expect(errors.some((e: string) => e.includes('hs_is_closed_won') && e.includes('書き換えられない'))).toBe(true)
    expect(warnings.some((w: string) => w.includes('hs_deal_stage_probability'))).toBe(true)
    // The known ones pass.
    expect(errors.some((e: string) => e.includes('dealname') || e.includes('juchu_kakudo」は'))).toBe(false)
    // Only the declared property list was asked, with the key in its header.
    const sent = way.sent.slice(sentBefore)
    expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['GET /crm/properties/2026-03/deals'])
    // Nothing written: no mapping version, the account not bound, no record.
    expect(versions()).toBe(0)
    expect(install().account_id).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM records WHERE company_id = ?').get(CO) as Json).n).toBe(0)
  })

  it('is for owners and admins only, and refuses an invalid text or a stopped package with nothing sent', async () => {
    const sentBefore = way.sent.length
    const asMember = await check(member, { text: MAPPING })
    expect(asMember.ok).toBe(false)
    expect(asMember.kind).toBe('forbidden')

    const invalid = await check(owner, { text: 'deal:\n  fields:\n    nosuch: { from: x, write: false }\n' })
    expect(invalid.ok).toBe(false)
    expect(invalid.body.code).toBe('MAPPING_INVALID')

    // No mapping saved and none given: nothing to check.
    const none = await check(owner, {})
    expect(none.ok).toBe(false)
    expect(none.body.code).toBe('MAPPING_INVALID')

    writeFileSync(join(shelfDir, 'stopped'), 'sample-hub\n')
    try {
      const stopped = await check(owner, { text: MAPPING })
      expect(stopped.ok).toBe(false)
      expect(stopped.body).toMatchObject({ code: 'PLUGIN_NOT_READY', problem: 'stopped' })
    } finally {
      rmSync(join(shelfDir, 'stopped'), { force: true })
    }
    expect(way.sent.length).toBe(sentBefore)
  })

  it('says HubSpot could not be asked when it refuses the key — and the key is nowhere', async () => {
    fake.removeKey(KEY)
    try {
      const r = await check(owner, { text: MAPPING })
      expect(r.ok).toBe(true)
      expect(r.value).toMatchObject({ reachable: false, reason: 'key-rejected', objects: {} })
      expect(JSON.stringify(r)).not.toContain(KEY)
      expect(logged.join('\n')).not.toContain(KEY)
    } finally {
      fake.addKey(KEY)
    }
  })
})
