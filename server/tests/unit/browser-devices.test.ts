/**
 * The PCs used for 「ブラウザ操作」 (services/browser-devices.ts; agent-browser.md "This PC's registration"; design memo
 * 「ブラウザ操作を担当者の PC で使う」 v2 §3–§8, §14-1), against a real database, the real device service and the real opened
 * lines service (shared/browser-connectors/opened.json: `landing_inspect` approved on map 1.0.1). The old path through
 * the routes, the real composition and the real member removal is tests/integration/browser-plans.test.ts ("this PC").
 *
 * Guards: registering (pending; asked twice → the same one; after a stop a new one; the name; the limit), who enables and
 * stops (owner / admin; their own PC too), stopped is final, leaving stops every registration and coming back revives
 * none; the gate on the new path (no registration, pending, stopped, another member's or another company's registration
 * of the same PC, a malformed key → refused; the owner's transition exception and nobody else's); a plan goes on only on
 * the registration that made it (another PC, or this PC registered again); a refused permit ends the execution; no key
 * stored anywhere; the lines the member may use.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteBrowserLineExecutionLookup } from '../../src/adapters/sqlite/browser-lines'
import { fileBrowserConnectorCatalog, fileBrowserOpenedList } from '../../src/adapters/browser-connector-catalog'
import { sha256TokenDigest } from '../../src/adapters/system'
import { hashCanonical } from '../../src/lib/content-hash'
import { createBrowserLineService, type BrowserLineService } from '../../src/services/browser-lines'
import { createBrowserLineSteps } from '../../src/services/browser-line-steps'
import { createBrowserDeviceService, type BrowserDeviceService } from '../../src/services/browser-devices'
import type { BrowserLinePlanRow } from '../../src/ports/browser-lines'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'
import { BROWSER_DEVICE_LIMITS } from '../../../shared/core/browser-device'
import type { BrowserOpenedFile, BrowserOpenedLineRow } from '../../../shared/core/browser-opened'
import { canonicalJson } from '../../../shared/core/fixed-content'
import type { BrowserDeviceView } from '../../../shared/types/browser-devices'
import type { Member } from '../../src/services/access'
import type { Refusal } from '../../src/services/outcome'

const T0 = Date.parse('2026-11-25T00:00:00.000Z')
const CO = 'co-1'
const OTHER_CO = 'co-2'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const admin: Member = { companyId: CO, userId: 'u-admin', role: 'admin' }
const alice: Member = { companyId: CO, userId: 'u-alice', role: 'member' }
const bob: Member = { companyId: CO, userId: 'u-bob', role: 'member' }
const otherOwner: Member = { companyId: OTHER_CO, userId: 'u-other', role: 'owner' }
const aliceElsewhere: Member = { companyId: OTHER_CO, userId: 'u-alice', role: 'member' }
const HOST = 'manager.linestep.net'
const REAL_OPENED = fileBrowserOpenedList().file() as BrowserOpenedFile
const approvedRow = () => REAL_OPENED.lines.find(l => l.name === 'landing_inspect' && l.mapVersion === '1.0.1') as BrowserOpenedLineRow
const refOf = (row: BrowserOpenedLineRow) => ({ site: row.site, line: row.name, version: row.version, mapVersion: row.mapVersion, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash })
const site = (value: string) => ({ value, from: { kind: 'site_fact' } })
const VALUES = { landing: site('501'), source: site('400') }

let conn: Database.Database
let now: number
let policy: BrowserOperationSettings
let data: CompanyDataSource
let dev: BrowserDeviceService
let svc: BrowserLineService
/** The opened list the lines service reads (a test may approve a writing line). */
let opened: unknown
const iso = (ms: number) => new Date(ms).toISOString()
const ids = { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }
const clock = { now: () => iso(now), nowMs: () => now }
const monotonic = { bootId: 'boot-1', monoMs: () => now - T0 }
const newKey = () => `v1.${randomBytes(32).toString('base64url')}`

function build() {
  data = sqliteCompanyData(conn)
  dev = createBrowserDeviceService({ companyData: data, transactions: sqliteTransactions(conn), clock, ids, tokenDigest: sha256TokenDigest, accounts: { byIds: ids => new Map(ids.map(id => [id, { name: `Name ${id}`, email: `${id}@example.com` }])) } })
  svc = createBrowserLineService({
    companyData: data, transactions: sqliteTransactions(conn), clock, monotonic, ids, tokenDigest: sha256TokenDigest,
    opened: { file: () => opened }, catalog: fileBrowserConnectorCatalog(), executionLookup: sqliteBrowserLineExecutionLookup(conn),
    memberships: sqliteMembershipRepository(conn), accounts: { byIds: () => new Map() },
    browserPolicy: () => policy, aiStops: () => ({ all: false, tools: [] }), devices: dev.gate, log: { warn: () => {} },
  })
}
function join(companyId: string, userId: string, role: string, at = iso(T0 - 3_600_000)) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, role, at, at)
}
function value<T>(r: { ok: true; value: T } | Refusal): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: { code?: unknown } }) => (r.ok ? 'ok' : r.body?.code)
const status = (r: { ok: boolean; kind?: string }) => (r.ok ? 'ok' : r.kind)
function grant(m: Member, row = approvedRow()) {
  value(svc.setGrant(m.role === 'owner' || m.companyId !== CO ? { ...owner, companyId: m.companyId, userId: m.companyId === CO ? owner.userId : otherOwner.userId } : owner, m.userId,
    { site: row.site, line: row.name, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash, allowed: true }))
}
const inspect = (m: Member, key: string | undefined) => svc.create(m, { line: refOf(approvedRow()), values: VALUES }, key)
/** A PC registered by `m` and enabled by the owner (or an admin for another company's member). */
function enabledPc(m: Member, key = newKey()): { key: string; device: BrowserDeviceView } {
  const asked = value(dev.register(m, key, { label: `${m.userId} の Mac` }))
  const by = m.companyId === CO ? owner : otherOwner
  return { key, device: value(dev.enable(by, (asked.device as BrowserDeviceView).id)) }
}
const deviceOf = (r: ReturnType<BrowserDeviceService['register']>) => value(r).device as BrowserDeviceView

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, admin.userId, 'admin'); join(CO, alice.userId, 'member'); join(CO, bob.userId, 'member')
  join(OTHER_CO, otherOwner.userId, 'owner'); join(OTHER_CO, alice.userId, 'member')
  now = T0
  opened = REAL_OPENED
  policy = { mode: 'on', sites: [{ host: HOST, level: 'write', assetHosts: [] }] }
  build()
  for (const m of [owner, admin, alice, bob]) grant(m)
  grant(aliceElsewhere)
})

describe('registering this PC', () => {
  it('a member asks (pending); asking again for the same PC answers the same registration; another PC is another', () => {
    const key = newKey()
    const first = value(dev.register(alice, key, { label: '  阿部の MacBook ' }))
    expect(first.created).toBe(true)
    expect(first.device).toMatchObject({ state: 'pending', label: '阿部の MacBook', userId: alice.userId, revokeReason: null })
    const again = value(dev.register(alice, key, { label: 'another name' }))
    expect(again).toEqual({ created: false, device: first.device })
    expect(deviceOf(dev.register(alice, newKey(), { label: 'x' })).id).not.toBe((first.device as BrowserDeviceView).id)
    expect(value(dev.mine(alice, key))).toEqual(first.device)
    // The same PC for another member (a shared PC) is that member's own registration; none of it is Alice's.
    expect(value(dev.mine(bob, key))).toEqual({ state: 'none' })
    expect(value(dev.mine(aliceElsewhere, key))).toEqual({ state: 'none' })
  })

  it('the key must be one well-formed header; the name 1–60 plain characters and nothing else in the body', () => {
    for (const bad of [undefined, '', 'v1.short', `v2.${randomBytes(32).toString('base64url')}`]) {
      expect(code(dev.register(alice, bad, { label: 'x' }))).toBe('BROWSER_DEVICE_BAD_KEY')
      expect(code(dev.mine(alice, bad))).toBe('BROWSER_DEVICE_BAD_KEY')
      expect(code(dev.withdraw(alice, bad))).toBe('BROWSER_DEVICE_BAD_KEY')
    }
    for (const body of [{}, { label: '' }, { label: 'x'.repeat(61) }, { label: 'a\u202eb' }, { label: 'x', key: 'y' }, null, 'x']) {
      expect(code(dev.register(alice, newKey(), body))).toBe('BROWSER_DEVICE_BAD_LABEL')
    }
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_devices').get()).toEqual({ n: 0 })
  })

  it('at most a fixed number of registrations not stopped per member; stopping one makes room', () => {
    const made = Array.from({ length: BROWSER_DEVICE_LIMITS.livePerMember }, () => deviceOf(dev.register(alice, newKey(), { label: 'x' })))
    expect(code(dev.register(alice, newKey(), { label: 'x' }))).toBe('BROWSER_DEVICE_LIMIT')
    value(dev.revoke(admin, made[0].id))
    expect(value(dev.register(alice, newKey(), { label: 'x' })).created).toBe(true)
  })

  it('withdrawing (this PC, self) stops it; registering again is a new registration, pending again', () => {
    const { key, device } = enabledPc(alice)
    expect(value(dev.withdraw(alice, key))).toMatchObject({ id: device.id, state: 'revoked', revokeReason: 'self', revokedBy: alice.userId })
    // Withdrawing again changes nothing; a PC never registered is not found.
    expect(value(dev.withdraw(alice, key))).toMatchObject({ id: device.id, state: 'revoked' })
    expect(code(dev.withdraw(alice, newKey()))).toBe('BROWSER_DEVICE_NOT_FOUND')
    now += 60_000
    const again = deviceOf(dev.register(alice, key, { label: 'x' }))
    expect(again.id).not.toBe(device.id)
    expect(again.state).toBe('pending')
    expect(value(dev.mine(alice, key))).toMatchObject({ id: again.id, state: 'pending' })
  })
})

describe('who enables and stops', () => {
  it('only an owner or admin enables or stops (a member: 403); an admin and an owner may enable their own PC with one press', () => {
    const d = deviceOf(dev.register(alice, newKey(), { label: 'x' }))
    expect(status(dev.enable(alice, d.id))).toBe('forbidden')
    expect(status(dev.enable(bob, d.id))).toBe('forbidden')
    expect(status(dev.revoke(alice, d.id))).toBe('forbidden')
    expect(status(dev.list(alice))).toBe('forbidden')
    expect(value(dev.enable(admin, d.id))).toMatchObject({ state: 'enabled', enabledBy: admin.userId })
    for (const m of [owner, admin]) {
      const own = deviceOf(dev.register(m, newKey(), { label: 'mine' }))
      expect(value(dev.enable(m, own.id))).toMatchObject({ state: 'enabled', enabledBy: m.userId })
    }
  })

  it('enable only from pending (a second press or a stopped one → state changed); stopped is final, and a stop never fails twice', () => {
    const d = deviceOf(dev.register(alice, newKey(), { label: 'x' }))
    value(dev.enable(owner, d.id))
    expect(code(dev.enable(admin, d.id))).toBe('BROWSER_DEVICE_STATE_CHANGED')
    expect(value(dev.revoke(admin, d.id))).toMatchObject({ state: 'revoked', revokeReason: 'admin', revokedBy: admin.userId })
    expect(code(dev.enable(owner, d.id))).toBe('BROWSER_DEVICE_STATE_CHANGED')
    expect(value(dev.revoke(owner, d.id))).toMatchObject({ state: 'revoked', revokedBy: admin.userId })
    // The table refuses any way back, whatever a later code does.
    expect(() => conn.prepare("UPDATE browser_devices SET state = 'enabled' WHERE id = ?").run(d.id)).toThrow(/only moves/)
    expect(() => conn.prepare("UPDATE browser_devices SET key_hash = 'x' WHERE id = ?").run(d.id)).toThrow(/only moves/)
    expect(() => conn.prepare('DELETE FROM browser_devices WHERE id = ?').run(d.id)).toThrow(/kept/)
    const p = deviceOf(dev.register(bob, newKey(), { label: 'x' }))
    expect(() => conn.prepare("UPDATE browser_devices SET label = 'y' WHERE id = ?").run(p.id)).toThrow(/only moves/)
    // Who and when go with the state: enabled without its time / person, stopped without its, are refused.
    expect(() => conn.prepare("UPDATE browser_devices SET state = 'enabled' WHERE id = ?").run(p.id)).toThrow(/CHECK/)
    expect(() => conn.prepare("UPDATE browser_devices SET enabled_by = 'u-x' WHERE id = ?").run(p.id)).toThrow(/CHECK/)
    expect(() => conn.prepare("UPDATE browser_devices SET state = 'revoked', revoke_reason = 'admin' WHERE id = ?").run(p.id)).toThrow(/CHECK/)
  })

  it('another company\'s registration is one that does not exist (the same 404), and is left as it was', () => {
    const theirs = deviceOf(dev.register(otherOwner, newKey(), { label: 'x' }))
    const nowhere = `bd_${'0'.repeat(32)}`
    for (const act of [dev.enable, dev.revoke]) {
      const cross = act(owner, theirs.id)
      expect(cross).toEqual(act(owner, nowhere))
      expect(code(cross)).toBe('BROWSER_DEVICE_NOT_FOUND')
    }
    expect(code(dev.enable(owner, 'not-an-id'))).toBe('BROWSER_DEVICE_NOT_FOUND')
    expect(data.forCompany(OTHER_CO).browserDevices.byId(theirs.id)).toMatchObject({ state: 'pending', enabledAt: null, revokedAt: null })
    expect(value(dev.list(owner)).items.map(d => d.id)).not.toContain(theirs.id)
  })

  it('the list (owner / admin): every registration with the person\'s name, newest first, and who did what — never a key or its hash', () => {
    const { key, device } = enabledPc(alice)
    now += 1000
    const pending = deviceOf(dev.register(bob, newKey(), { label: 'Bob の PC' }))
    const list = value(dev.list(admin))
    expect(list.items.map(d => [d.id, d.state, d.name])).toEqual([[pending.id, 'pending', 'Name u-bob'], [device.id, 'enabled', 'Name u-alice']])
    expect(list.more).toBe(false)
    expect(list.history.map(h => [h.deviceId, h.action, h.actorId])).toEqual([[pending.id, 'request', bob.userId], [device.id, 'enable', owner.userId], [device.id, 'request', alice.userId]])
    const text = JSON.stringify(list)
    expect(text).not.toContain(key)
    expect(text).not.toContain(key.slice(3))
    expect(text).not.toContain(sha256TokenDigest.digest(key))
    expect(text).not.toMatch(/keyHash|key_hash/)
  })
})

describe('the PC key is never stored', () => {
  it('neither the key nor its base64 part is in any row of any table; only its sha256', () => {
    const { key, device } = enabledPc(alice)
    value(inspect(alice, key))
    const dump = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(t => JSON.stringify(conn.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n')
    expect(dump).not.toContain(key.slice(3))
    expect(dump).not.toContain(Buffer.from(key.slice(3), 'base64url').toString('hex'))
    expect(dump).not.toContain(Buffer.from(key.slice(3), 'base64url').toString('base64'))
    expect(conn.prepare('SELECT key_hash FROM browser_devices WHERE id = ?').get(device.id)).toEqual({ key_hash: createHash('sha256').update(key, 'utf8').digest('hex') })
  })
})

describe('the gate on the new path (an inspection: create)', () => {
  it('a member needs an enabled registration of their own for this PC in this company', () => {
    expect(code(inspect(alice, undefined))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    expect(code(inspect(alice, newKey()))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    expect(code(inspect(alice, 'v1.not-a-key'))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    const key = newKey()
    const d = deviceOf(dev.register(alice, key, { label: 'x' }))
    expect(code(inspect(alice, key))).toBe('BROWSER_DEVICE_PENDING')
    value(dev.enable(owner, d.id))
    expect(code(inspect(alice, key))).toBe('ok')
    value(dev.revoke(owner, d.id))
    expect(code(inspect(alice, key))).toBe('BROWSER_DEVICE_REVOKED')
    // Nothing was made by a refused step.
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_line_plans').get()).toEqual({ n: 1 })
  })

  it('another member\'s registration of the same PC, or this member\'s in another company, does not count', () => {
    const key = newKey()
    enabledPc(bob, key)
    expect(code(inspect(alice, key))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    enabledPc(aliceElsewhere, key)
    expect(code(inspect(alice, key))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    expect(code(svc.create(aliceElsewhere, { line: refOf(approvedRow()), values: VALUES }, key))).toBe('ok')
  })

  it('the transition exception: no header at all passes for an owner only — not an admin, a member, or an owner with a bad header', () => {
    expect(code(inspect(owner, undefined))).toBe('ok')
    expect(code(inspect(admin, undefined))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    expect(code(inspect(alice, undefined))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    expect(code(inspect(owner, 'v1.bad'))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    expect(code(inspect(owner, newKey()))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    // The owner demoted to admin loses it at once (the role is the server's, per request).
    conn.prepare("UPDATE memberships SET role = 'admin' WHERE company_id = ? AND user_id = ?").run(CO, owner.userId)
    expect(code(inspect({ ...owner, role: 'admin' }, undefined))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
  })

  it('the PC check comes first: a stopped PC is refused even where the line or grant would refuse too', () => {
    const { key, device } = enabledPc(bob)
    value(svc.setGrant(owner, bob.userId, { site: 'lstep', line: 'landing_inspect', meaningHash: approvedRow().meaningHash, mechanicsHash: approvedRow().mechanicsHash, allowed: false }))
    expect(code(inspect(bob, key))).toBe('BROWSER_TYPE_NOT_GRANTED')
    value(dev.revoke(owner, device.id))
    expect(code(inspect(bob, key))).toBe('BROWSER_DEVICE_REVOKED')
  })

  it('a passing step notes the day it was used, at most once a day', () => {
    const { key, device } = enabledPc(alice)
    expect(device.lastUsedAt).toBeNull()
    value(inspect(alice, key))
    expect(data.forCompany(CO).browserDevices.byId(device.id)?.lastUsedAt).toBe(iso(T0))
    now += 3_600_000
    value(inspect(alice, key))
    expect(data.forCompany(CO).browserDevices.byId(device.id)?.lastUsedAt).toBe(iso(T0))
    now += 24 * 3_600_000
    value(inspect(alice, key))
    expect(data.forCompany(CO).browserDevices.byId(device.id)?.lastUsedAt).toBe(iso(now))
  })
})

// --- a plan of writes (as a later build would leave one): approve / claim / permit ask the PC first -----------------------

function insertWritePlan(state: BrowserLinePlanRow['state'], bindTo: string | null, m: Member = alice): BrowserLinePlanRow {
  const row = approvedRow()
  const content = canonicalJson({
    shape: 2, company: CO, user: m.userId, conversation: null, line: refOf(row), values: VALUES, writes: [{ kind: 'change', thing: 'action_set', idField: 'id' }],
    locks: [`lock-${randomBytes(4).toString('hex')}`], site: 'lstep', host: HOST, account: '90171', createdAt: iso(now), expiresAt: iso(now + 3_600_000),
  })
  const p: BrowserLinePlanRow = {
    id: `bl_${randomBytes(16).toString('hex')}`, userId: m.userId, shape: 2, site: 'lstep', lineName: row.name, lineVersion: row.version, mapVersion: row.mapVersion,
    meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash, writes: 1, content, contentHash: hashCanonical(content), state, closeReason: null,
    createdAt: iso(now), expiresAt: iso(now + 3_600_000), approvedAt: state === 'draft' ? null : iso(now), closedAt: null, conversationId: null, result: null, reportedAt: null,
  }
  data.forCompany(CO).browserLines.insertPlan(p)
  if (bindTo) data.forCompany(CO).browserDevices.bindPlan('line', p.id, bindTo, iso(now))
  return p
}

describe('a plan goes on only on the PC that made it', () => {
  it('an inspection is bound to the registration that made it (none under the owner\'s exception)', () => {
    const { key, device } = enabledPc(alice)
    const p = value(inspect(alice, key))
    expect(data.forCompany(CO).browserDevices.planDevice('line', p.id)).toBe(device.id)
    const o = value(inspect(owner, undefined))
    expect(data.forCompany(CO).browserDevices.planDevice('line', o.id)).toBeNull()
    expect(() => conn.prepare("UPDATE browser_plan_devices SET device_id = 'x' WHERE plan_id = ?").run(p.id)).toThrow(/never changes/)
    expect(() => conn.prepare('DELETE FROM browser_plan_devices WHERE plan_id = ?').run(p.id)).toThrow(/never changes/)
  })

  it('approve / claim from another PC of the same member, or from this PC registered again → elsewhere; from its own PC the next rule decides', () => {
    const one = enabledPc(alice)
    const two = enabledPc(alice)
    const draft = insertWritePlan('draft', one.device.id)
    expect(code(svc.approve(alice, draft.id, { contentHash: draft.contentHash }, two.key))).toBe('BROWSER_DEVICE_ELSEWHERE')
    expect(code(svc.approve(alice, draft.id, { contentHash: draft.contentHash }, undefined))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    // Its own PC passes the PC check (and the next rule refuses this plan: its line, an inspection's row, writes nothing).
    expect(code(svc.approve(alice, draft.id, { contentHash: draft.contentHash }, one.key))).toBe('BROWSER_LINE_NOT_APPROVED')
    const approved = insertWritePlan('approved', one.device.id)
    expect(code(svc.claim(alice, approved.id, two.key))).toBe('BROWSER_DEVICE_ELSEWHERE')
    // The same PC stopped and registered again: a new registration, so the old plan does not move again.
    value(dev.withdraw(alice, one.key))
    value(dev.enable(owner, deviceOf(dev.register(alice, one.key, { label: 'again' })).id))
    expect(code(svc.claim(alice, approved.id, one.key))).toBe('BROWSER_DEVICE_ELSEWHERE')
    // Another PC may still 「やめる」 (cancel is not gated).
    expect(code(svc.cancel(alice, approved.id))).toBe('ok')
  })

  it('the owner: a plan made without a registration goes on only without one; a registered PC cannot take it over', () => {
    const pc = enabledPc(owner)
    const draft = insertWritePlan('draft', null, owner)
    expect(code(svc.approve(owner, draft.id, { contentHash: draft.contentHash }, pc.key))).toBe('BROWSER_DEVICE_ELSEWHERE')
    expect(code(svc.approve(owner, draft.id, { contentHash: draft.contentHash }, undefined))).toBe('BROWSER_LINE_NOT_APPROVED')
    const bound = insertWritePlan('draft', pc.device.id, owner)
    expect(code(svc.approve(owner, bound.id, { contentHash: bound.contentHash }, undefined))).toBe('BROWSER_DEVICE_ELSEWHERE')
  })

  it('a permit from another PC is refused and ends the claimed execution for good (the reason kept)', () => {
    const one = enabledPc(alice)
    const two = enabledPc(alice)
    const p = insertWritePlan('approved', one.device.id)
    const secret = randomBytes(32).toString('hex')
    const steps = createBrowserLineSteps({ companyData: data, clock, monotonic, ids })
    const c = value(steps.claim(CO, p, { writes: [{ kind: 'change', thing: 'action_set', idField: 'id' }], locks: [`lock-${p.id}`], host: HOST, account: '90171', site: 'lstep', company: CO }, sha256TokenDigest.digest(secret), now))
    expect(code(svc.permit(alice, c.executionId, secret, { index: 1 }, two.key))).toBe('BROWSER_DEVICE_ELSEWHERE')
    expect(data.forCompany(CO).browserLines.execution(c.executionId)).toMatchObject({ state: 'void', voidReason: 'BROWSER_DEVICE_ELSEWHERE' })
  })

  it('a write plan (PR 5c) is bound to the PC that made it; a PC stopped between two writes ends the execution (partial: what was done stays, the rest skipped), and the done write\'s report still lands', () => {
    const writing = JSON.parse(JSON.stringify(opened)) as BrowserOpenedFile
    const row = writing.lines.filter(l => l.name === 'landing_create').at(-1)!
    row.status = 'approved'
    opened = writing; build()
    value(svc.setGrant(owner, alice.userId, { site: row.site, line: row.name, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash, allowed: true }))
    policy = { mode: 'on', sites: [{ host: HOST, level: 'write', assetHosts: [] }] }
    const one = enabledPc(alice)
    const two = enabledPc(alice)
    const person = (v: string) => ({ value: v, from: { kind: 'person', confirmed: true } })
    const site = (v: string) => ({ value: v, from: { kind: 'site_fact' } })
    const values = { source: site('2597458'), tag: site('61'), name: person('試験'), to_date: person('2026-12-03'), to_time: person('18:20') }
    const ref = { site: row.site, line: row.name, version: row.version, mapVersion: row.mapVersion, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash }
    const p = value(svc.create(alice, { line: ref, values, account: '90171' }, one.key))
    expect(code(svc.approve(alice, p.id, { contentHash: p.contentHash }, two.key))).toBe('BROWSER_DEVICE_ELSEWHERE')
    value(svc.approve(alice, p.id, { contentHash: p.contentHash }, one.key))
    const claim = value(svc.claim(alice, p.id, one.key))
    value(svc.permit(alice, claim.executionId, claim.secret, { index: 1 }, one.key))
    // The PC is stopped while write 1 is on its way: its report still lands (clean-up is never gated)…
    value(dev.withdraw(alice, one.key))
    expect(value(svc.report(claim.secret, { index: 1, result: 'done', createdId: '8801' })).step).toBe('done')
    // …and write 2's permit is refused: the execution ends partial, nothing more is permitted.
    expect(code(svc.permit(alice, claim.executionId, claim.secret, { index: 2 }, one.key))).toMatch(/^BROWSER_DEVICE_/)
    const e = data.forCompany(CO).browserLines.execution(claim.executionId)!
    expect(e.state).toBe('partial')
    expect(data.forCompany(CO).browserLines.steps(claim.executionId).map(s => s.state)).toEqual(['done', 'skipped'])
  })
})

describe('leaving the company', () => {
  it('stops every registration of the person (left), recorded; invited back, none returns', () => {
    const a = enabledPc(alice)
    const pending = deviceOf(dev.register(alice, newKey(), { label: 'x' }))
    const theirsElsewhere = enabledPc(aliceElsewhere)
    dev.memberLeft(CO, alice.userId, owner.userId)
    for (const id of [a.device.id, pending.id]) expect(data.forCompany(CO).browserDevices.byId(id)).toMatchObject({ state: 'revoked', revokeReason: 'left', revokedBy: owner.userId })
    // Another company's registration of the same person is that company's own.
    expect(data.forCompany(OTHER_CO).browserDevices.byId(theirsElsewhere.device.id)?.state).toBe('enabled')
    expect(value(dev.list(owner)).history.filter(h => h.action === 'revoke').map(h => [h.deviceId, h.reason]).sort()).toEqual([[a.device.id, 'left'], [pending.id, 'left']].sort())
    expect(code(inspect(alice, a.key))).toBe('BROWSER_DEVICE_REVOKED')
    // Back again: the old registration stays stopped; a new one starts pending (and is the one this PC now has).
    now += 60_000
    expect(value(dev.register(alice, a.key, { label: 'x' })).device).toMatchObject({ state: 'pending' })
    expect(code(inspect(alice, a.key))).toBe('BROWSER_DEVICE_PENDING')
  })
})

describe('the lines the member may use (GET /browser-lines-mine)', () => {
  it('only approved rows with a grant in force, names only', () => {
    // The 1.0.1 row she was granted on, and any approved row that carries it (a reviewed grantsFrom); never a pending one.
    const lines = value(svc.mine(alice)).lines
    expect(lines).toContainEqual({ ...refOf(approvedRow()), label: '流入経路を点検する', writes: false })
    const approved = REAL_OPENED.lines.filter(l => l.status === 'approved' && l.name === 'landing_inspect')
    expect(lines.map(l => l.mechanicsHash).sort()).toEqual(approved.filter(l => l.mechanicsHash === approvedRow().mechanicsHash || (l.grantsFrom ?? []).includes(approvedRow().mechanicsHash)).map(l => l.mechanicsHash).sort())
    value(svc.setGrant(owner, alice.userId, { site: 'lstep', line: 'landing_inspect', meaningHash: approvedRow().meaningHash, mechanicsHash: approvedRow().mechanicsHash, allowed: false }))
    expect(value(svc.mine(alice)).lines).toEqual([])
  })
})
