/**
 * 「もう一方の AI に聞く」 as a company setting (owner decision 2026-11-02) on the real schema.
 *
 * What it protects:
 * - a company created after the setting existed may NOT ask the other AI (a company contracted
 *   with one AI vendor must not send its content to the other) — no row = not allowed;
 * - the companies that existed when it shipped keep today's behaviour: the table's first
 *   creation turns it on for each of them, once (a later run never overwrites a change);
 * - only owners and admins change it; a malformed body changes nothing;
 * - the member's policy (`/me/agent-policy`) carries it, and its version moves with it (the
 *   ETag the apps refresh by).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { initDatabase, migrateSecondOpinionSetting } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { createSecondOpinionSettingService, type SecondOpinionSettingService } from '../../src/services/second-opinion-setting'
import { createAgentPolicyService } from '../../src/services/agent-policy'
import type { Member } from '../../src/services/access'

const TS = '2026-11-02T00:00:00.000Z'
let conn: Database.Database
let service: SecondOpinionSettingService

const addCompany = (id: string) =>
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
const as = (role: string, companyId = 'old'): Member => ({ companyId, userId: `u-${role}`, role })

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  service = createSecondOpinionSettingService({
    companyData: sqliteCompanyData(conn),
    accounts: { byIds: ids => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `name of ${id}` }])), bySessionToken: () => null },
    clock: { now: () => TS, nowMs: () => Date.parse(TS) },
  })
})

describe('starting value', () => {
  it('companies existing when the setting ships keep it on; companies created later start off; the carry-over runs once', () => {
    // The database as it was before this version: companies, no setting table.
    conn.exec('DROP TABLE second_opinion_settings')
    addCompany('old')
    addCompany('old-2')
    migrateSecondOpinionSetting(conn)
    addCompany('new')

    expect(service.allowedFor('old')).toBe(true)
    expect(service.allowedFor('old-2')).toBe(true)
    expect(service.allowedFor('new')).toBe(false)
    // The carried-over value counts as the company's starting value, not as someone's change.
    expect(service.get(as('owner'))).toEqual({ ok: true, value: { allowed: true, updatedAt: null, updatedByName: null } })

    // Never again: an owner's later "off" survives the next start.
    expect(service.update(as('owner'), { allowed: false }).ok).toBe(true)
    migrateSecondOpinionSetting(conn)
    expect(service.allowedFor('old')).toBe(false)
    expect(service.allowedFor('new')).toBe(false)
  })

  it('a fresh server: every company starts off', () => {
    addCompany('first')
    expect(service.allowedFor('first')).toBe(false)
  })
})

describe('changing it', () => {
  beforeEach(() => { addCompany('old'); addCompany('other') })

  it('owners and admins switch it; members and department managers cannot; one company only', () => {
    expect(service.update(as('admin'), { allowed: true })).toEqual({
      ok: true, value: { changed: true, view: { allowed: true, updatedAt: TS, updatedByName: 'name of u-admin' } },
    })
    expect(service.allowedFor('old')).toBe(true)
    expect(service.allowedFor('other')).toBe(false)
    expect(service.update(as('admin'), { allowed: true })).toMatchObject({ ok: true, value: { changed: false } })

    for (const role of ['member', 'dept_manager']) {
      expect(service.update(as(role), { allowed: false })).toMatchObject({ ok: false, kind: 'forbidden' })
      expect(service.get(as(role))).toMatchObject({ ok: false, kind: 'forbidden' })
    }
    expect(service.allowedFor('old')).toBe(true)
    expect(service.update(as('owner'), { allowed: false })).toMatchObject({ ok: true, value: { changed: true, view: { allowed: false } } })
    expect(service.allowedFor('old')).toBe(false)
  })

  it('anything but { allowed: boolean } is refused and changes nothing', () => {
    for (const body of [null, {}, { allowed: 'true' }, { allowed: 1 }]) {
      expect(service.update(as('owner'), body)).toMatchObject({ ok: false, kind: 'bad-request' })
    }
    expect(service.allowedFor('old')).toBe(false)
  })
})

describe('the member\'s policy', () => {
  it('carries the company\'s setting, and its version changes with it', async () => {
    addCompany('old')
    const policy = createAgentPolicyService({
      agentSandbox: { policyFor: () => ({ mode: 'off', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' }) },
      agentStops: { policyFor: () => ({ all: false, tools: [] }) },
      secondOpinion: service,
      digest: { digest: (s: string) => createHash('sha256').update(s).digest('hex') },
      push: { announce: () => {} },
    })
    const member = { companyId: 'old', userId: 'u-member' }
    const before = await policy.policyFor(member)
    expect(before.secondOpinion).toEqual({ allowed: false })
    service.update(as('owner'), { allowed: true })
    const after = await policy.policyFor(member)
    expect(after.secondOpinion).toEqual({ allowed: true })
    expect(after.version).not.toBe(before.version)
  })
})
