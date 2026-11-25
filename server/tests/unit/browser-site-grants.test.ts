/**
 * 「ブラウザ操作を使える人」 per site (services/browser-site-grants.ts; agent-browser.md "Who may use a site"), against a real
 * database. Guards: another company's row never counts; an unregistered host is never allowed nor settable; 見るだけ
 * cannot write; 使わない cannot read; a member who left gets nothing, and a row from before they came back is not theirs;
 * the company's level caps the person; owners / admins follow the table (no implicit 変えてよい) and alone change it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { createBrowserSiteGrants, type BrowserSiteGrants } from '../../src/services/browser-site-grants'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { Member } from '../../src/services/access'
import type { Refusal } from '../../src/services/outcome'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'

const T0 = Date.parse('2026-11-25T00:00:00.000Z')
const CO = 'co-1'
const OTHER_CO = 'co-2'
const HOST = 'shop.example.com'
const OTHER_HOST = 'tickets.example.net'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const admin: Member = { companyId: CO, userId: 'u-admin', role: 'admin' }
const alice: Member = { companyId: CO, userId: 'u-alice', role: 'member' }
const otherOwner: Member = { companyId: OTHER_CO, userId: 'u-other', role: 'owner' }
const aliceElsewhere: Member = { companyId: OTHER_CO, userId: alice.userId, role: 'member' }

let conn: Database.Database
let data: CompanyDataSource
let now: number
let policies: Record<string, BrowserOperationSettings>
let svc: BrowserSiteGrants
const iso = (ms: number) => new Date(ms).toISOString()
const site = (host: string, level: 'read' | 'write' | 'delete') => ({ host, level, assetHosts: [] })

function join(companyId: string, userId: string, role: string, at = iso(T0 - 3_600_000)) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, role, at, at)
}
function value<T>(r: { ok: true; value: T } | Refusal): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const refusal = (r: { ok: boolean; kind?: string; body?: { code?: unknown } }) => (r.ok ? 'ok' : `${r.kind}:${r.body?.code ?? ''}`)

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, admin.userId, 'admin'); join(CO, alice.userId, 'member')
  join(OTHER_CO, otherOwner.userId, 'owner'); join(OTHER_CO, alice.userId, 'member')
  now = T0
  policies = {
    [CO]: { mode: 'on', sites: [site(HOST, 'write'), site(OTHER_HOST, 'read')] },
    [OTHER_CO]: { mode: 'on', sites: [site(HOST, 'delete')] },
  }
  data = sqliteCompanyData(conn)
  svc = createBrowserSiteGrants({
    companyData: data, clock: { now: () => iso(now), nowMs: () => now }, memberships: sqliteMembershipRepository(conn),
    browserPolicy: m => policies[m.companyId],
  })
})

describe('what a person may do on a site', () => {
  it('a registered site starts at 見るだけ for everyone, owners and admins included (no implicit 変えてよい)', () => {
    for (const m of [owner, admin, alice]) {
      expect(svc.allows(m, HOST, 'read')).toBe(true)
      expect(svc.allows(m, HOST, 'write')).toBe(false)
    }
  })

  it('見るだけ cannot write; 変えてよい writes; 使わない cannot even read', () => {
    value(svc.set(owner, alice.userId, { host: HOST, level: 'read' }))
    expect([svc.allows(alice, HOST, 'read'), svc.allows(alice, HOST, 'write')]).toEqual([true, false])
    value(svc.set(owner, alice.userId, { host: HOST, level: 'write' }))
    expect([svc.allows(alice, HOST, 'read'), svc.allows(alice, HOST, 'write')]).toEqual([true, true])
    value(svc.set(admin, alice.userId, { host: HOST, level: 'none' }))
    expect([svc.allows(alice, HOST, 'read'), svc.allows(alice, HOST, 'write')]).toEqual([false, false])
    // 変えてよい never reaches beyond the company's level (削除も is not 入力・保存まで).
    value(svc.set(owner, alice.userId, { host: HOST, level: 'write' }))
    expect(svc.allows(alice, HOST, 'delete')).toBe(false)
  })

  it('the company\'s level is the ceiling: 変えてよい on a 見るだけ site reads only, and cannot be chosen there', () => {
    data.forCompany(CO).browserLines.saveSiteGrant({ userId: alice.userId, host: OTHER_HOST, level: 'write', grantedBy: owner.userId, updatedAt: iso(now) })
    expect([svc.allows(alice, OTHER_HOST, 'read'), svc.allows(alice, OTHER_HOST, 'write')]).toEqual([true, false])
    expect(refusal(svc.set(owner, alice.userId, { host: OTHER_HOST, level: 'write' }))).toBe('conflict:BROWSER_SITE_LEVEL_ABOVE_SITE')
    // The company turning 「使わない」 (or the member's own override off) stops everyone, whatever their level.
    value(svc.set(owner, alice.userId, { host: HOST, level: 'write' }))
    policies[CO] = { ...policies[CO], mode: 'off' }
    expect(svc.allows(alice, HOST, 'read')).toBe(false)
  })

  it('an unregistered host is never allowed and cannot be set; a host removed from the list stops counting', () => {
    expect(svc.allows(alice, 'unlisted.example.org', 'read')).toBe(false)
    expect(refusal(svc.set(owner, alice.userId, { host: 'unlisted.example.org', level: 'read' }))).toBe('bad-request:BROWSER_SITE_NOT_REGISTERED')
    // Only the very spelling the company registered.
    expect(refusal(svc.set(owner, alice.userId, { host: 'SHOP.example.com', level: 'read' }))).toBe('bad-request:BROWSER_SITE_NOT_REGISTERED')
    value(svc.set(owner, alice.userId, { host: HOST, level: 'write' }))
    policies[CO] = { mode: 'on', sites: [site(OTHER_HOST, 'read')] }
    expect(svc.allows(alice, HOST, 'read')).toBe(false)
    expect(value(svc.view(owner)).grants).toEqual([])
  })

  it('another company\'s row never counts here, and a change here never reaches the other company', () => {
    value(svc.set(otherOwner, aliceElsewhere.userId, { host: HOST, level: 'write' }))
    expect(svc.allows(alice, HOST, 'write')).toBe(false)
    expect(svc.allows(aliceElsewhere, HOST, 'write')).toBe(true)
    value(svc.set(owner, alice.userId, { host: HOST, level: 'none' }))
    expect(svc.allows(aliceElsewhere, HOST, 'read')).toBe(true)
    expect(value(svc.view(owner)).grants.map(g => [g.userId, g.level])).toEqual([[alice.userId, 'none']])
    // Another company's owner cannot set a level for someone who is not their member.
    expect(refusal(svc.set(otherOwner, admin.userId, { host: HOST, level: 'write' }))).toBe('not-found:')
  })

  it('a member who left gets nothing; invited back, a row from before is not theirs (the default applies)', () => {
    value(svc.set(owner, alice.userId, { host: HOST, level: 'write' }))
    conn.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(CO, alice.userId)
    expect(svc.allows(alice, HOST, 'read')).toBe(false)
    expect(refusal(svc.set(owner, alice.userId, { host: HOST, level: 'read' }))).toBe('not-found:')
    // Back again later, the old row still in the table (memberLeft not run): she starts from 見るだけ.
    join(CO, alice.userId, 'member', iso(T0 + 1000))
    now = T0 + 2000
    expect([svc.allows(alice, HOST, 'read'), svc.allows(alice, HOST, 'write')]).toEqual([true, false])
    expect(value(svc.view(owner)).grants).toEqual([])
    // Leaving removes the rows.
    value(svc.set(owner, alice.userId, { host: HOST, level: 'write' }))
    svc.memberLeft(CO, alice.userId)
    expect(data.forCompany(CO).browserLines.siteGrants()).toEqual([])
  })
})

describe('the admin\'s view and changes', () => {
  it('owners / admins only; a member gets 403 and nothing', () => {
    expect(refusal(svc.view(alice))).toBe('forbidden:')
    expect(refusal(svc.set(alice, alice.userId, { host: HOST, level: 'write' }))).toBe('forbidden:')
    expect(svc.allows(alice, HOST, 'write')).toBe(false)
  })

  it('the view lists the registered sites with their level and the chosen levels; no site\'s job anywhere', () => {
    value(svc.set(admin, alice.userId, { host: HOST, level: 'write' }))
    const v = value(svc.view(owner))
    expect(v).toEqual({
      sites: [{ host: HOST, level: 'write' }, { host: OTHER_HOST, level: 'read' }],
      defaultLevel: 'read',
      grants: [{ userId: alice.userId, host: HOST, level: 'write', grantedBy: admin.userId, updatedAt: iso(now) }],
    })
  })

  it('a change is exactly { host, level } of the known levels', () => {
    for (const body of [null, 'x', [], { host: HOST }, { host: HOST, level: 'delete' }, { host: HOST, level: 'read', extra: 1 }, { host: 1, level: 'read' }]) {
      expect(refusal(svc.set(owner, alice.userId, body)), JSON.stringify(body)).toBe('bad-request:BROWSER_BAD_SITE_GRANT')
    }
  })
})
