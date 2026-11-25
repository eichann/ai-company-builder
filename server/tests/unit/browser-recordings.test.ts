/**
 * 「ブラウザ操作」 の記録 on the server (services/browser-recordings.ts, shared/core/browser-recording.ts; agent-browser.md
 * "Recording"; design memo D2 / D3), against a real database and the real PC service. The site is fictional.
 *
 * Guards: only a recording in its kept form is stored — a value, a token field, an unmasked address, label or key, a
 * dangling reference is refused (the server's own check, whatever the app sent); sending needs this PC (an enabled
 * registration, or the owner's exception), the company's 「使う」 and the domain registered; who reads: the sender (only
 * what they sent while a member this time) and current owners / admins — not another member, not another company, not
 * someone who left; the sender's leaving keeps it for the company; deleting removes the content; 30 days later it is
 * gone (every read leaves it out, the server clock deletes it).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sha256TokenDigest } from '../../src/adapters/system'
import { createBrowserDeviceService, type BrowserDeviceService } from '../../src/services/browser-devices'
import { createBrowserRecordingService, type BrowserRecordingService } from '../../src/services/browser-recordings'
import { createBrowserSiteGrants, type BrowserSiteGrants } from '../../src/services/browser-site-grants'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'
import {
  BROWSER_RECORDING_LIMITS, browserAddressPattern, browserKeyPattern, browserLabel, browserRecordingProblem, type BrowserRecordingContent,
} from '../../../shared/core/browser-recording'
import type { BrowserDeviceView } from '../../../shared/types/browser-devices'
import type { Member } from '../../src/services/access'
import type { Refusal } from '../../src/services/outcome'

const T0 = Date.parse('2026-11-25T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const CO = 'co-1'
const OTHER_CO = 'co-2'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const admin: Member = { companyId: CO, userId: 'u-admin', role: 'admin' }
const alice: Member = { companyId: CO, userId: 'u-alice', role: 'member' }
const bob: Member = { companyId: CO, userId: 'u-bob', role: 'member' }
const otherOwner: Member = { companyId: OTHER_CO, userId: 'u-other', role: 'owner' }
const DOMAIN = 'shop.example.test'

let conn: Database.Database
let now: number
let policy: BrowserOperationSettings
let dev: BrowserDeviceService
let svc: BrowserRecordingService
let grants: BrowserSiteGrants
const iso = (ms: number) => new Date(ms).toISOString()
const ids = { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }
const clock = { now: () => iso(now), nowMs: () => now }
const newKey = () => `v1.${randomBytes(32).toString('base64url')}`

function join(companyId: string, userId: string, role: string, at = iso(T0 - 3_600_000)) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, role, at, at)
}
function leave(companyId: string, userId: string) {
  conn.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(companyId, userId)
}
function value<T>(r: { ok: true; value: T } | Refusal): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: { code?: unknown } }) => (r.ok ? 'ok' : r.body?.code)
const status = (r: { ok: boolean; kind?: string }) => (r.ok ? 'ok' : r.kind)

/** A PC registered by `m` and enabled by an owner of its company. */
function enabledPc(m: Member): string {
  const key = newKey()
  const asked = value(dev.register(m, key, { label: 'PC' }))
  value(dev.enable(m.companyId === CO ? owner : otherOwner, (asked.device as BrowserDeviceView).id))
  return key
}

/** A recording as the app writes it (the shapes the core's rules produce). */
function recording(domain = DOMAIN): BrowserRecordingContent {
  return {
    format: 1, domain,
    steps: [
      { id: 1, kind: 'page', address: '/orders/{n}?tab' },
      { id: 2, kind: 'send', method: 'GET', override: null, address: '/api/orders/{n}', fields: [], status: 200, answerKeys: ['id', 'items[].id', 'end_date'], after: null, count: 1 },
      { id: 3, kind: 'input', label: '受付終了日', name: 'end_date', value: '値1', from: { step: 2, key: 'end_date' } },
      { id: 4, kind: 'click', target: 'button', label: '保存', address: null },
      { id: 5, kind: 'send', method: 'POST', override: 'PATCH', address: '/api/orders/{n}', fields: [{ name: 'end_date', value: '値1', from: null }], status: 200, answerKeys: null, after: 4, count: 1 },
      { id: 6, kind: 'click', target: 'link', label: null, address: '/customers/{n}' },
    ],
    hosts: [{ host: 'cdn.example-assets.test', loaded: true }],
  }
}
const send = (m: Member, key: string | undefined, content: unknown = recording(), domain = DOMAIN) => svc.send(m, key, { domain, content })

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, admin.userId, 'admin'); join(CO, alice.userId, 'member'); join(CO, bob.userId, 'member')
  join(OTHER_CO, otherOwner.userId, 'owner')
  now = T0
  policy = { mode: 'on', sites: [{ host: DOMAIN, level: 'read', assetHosts: [] }] }
  const data = sqliteCompanyData(conn)
  dev = createBrowserDeviceService({ companyData: data, transactions: sqliteTransactions(conn), clock, ids, tokenDigest: sha256TokenDigest, accounts: { byIds: () => new Map() } })
  const memberships = sqliteMembershipRepository(conn)
  grants = createBrowserSiteGrants({ companyData: data, clock, memberships, browserPolicy: () => policy })
  svc = createBrowserRecordingService({
    companyData: data, clock, ids, memberships,
    accounts: { byIds: ids => new Map(ids.map(id => [id, { name: `Name ${id}`, email: `${id}@example.com` }])) },
    siteGrants: grants, devices: dev.gate,
  })
})

describe('what may be stored (the server\'s own check)', () => {
  it('a recording in its kept form passes', () => {
    expect(browserRecordingProblem(recording(), DOMAIN)).toBeNull()
  })

  it('a value, a token field, an unmasked address, label or key, or a dangling reference is refused', () => {
    const bad: Array<[string, (c: BrowserRecordingContent) => void]> = [
      ['a raw value instead of a symbol', c => { (c.steps[2] as { value: string }).value = '2026-12-03' }],
      ['a password field kept as a symbol', c => { c.steps[2] = { id: 3, kind: 'input', label: 'パスワード', name: 'password', value: '値1', from: null } }],
      ['a CSRF field sent', c => { (c.steps[4] as { fields: unknown[] }).fields.push({ name: '_token', value: '値2', from: null }) }],
      ['a session field sent', c => { (c.steps[4] as { fields: unknown[] }).fields.push({ name: 'session_id', value: 'empty', from: null }) }],
      ['a field marked secret', c => { (c.steps[4] as { fields: unknown[] }).fields.push({ name: 'note', value: 'secret', from: null }) }],
      ['an id in an address', c => { (c.steps[0] as { address: string }).address = '/orders/48213' }],
      ['a query value', c => { (c.steps[0] as { address: string }).address = '/orders/{n}?tab=detail' }],
      ['an encoded name in an address', c => { (c.steps[0] as { address: string }).address = '/customers/%E5%B1%B1%E7%94%B0' }],
      ['a token in an address', c => { (c.steps[0] as { address: string }).address = '/reset/a8f3k2j9d0s8f7g6h5j4' }],
      ['an unknown placeholder', c => { (c.steps[0] as { address: string }).address = '/orders/{id}' }],
      ['a token spelled around placeholders (never what the rule writes)', c => { (c.steps[0] as { address: string }).address = '/reset/{n}abcdefghijklmnop{n}' }],
      ['a link with its text', c => { (c.steps[5] as { label: string | null }).label = '山田花子さんの注文' }],
      ['a label with an e-mail', c => { (c.steps[3] as { label: string }).label = 'hanako@example.com に送る' }],
      ['a label with a number', c => { (c.steps[3] as { label: string }).label = '注文 48213 を保存' }],
      ['an e-mail as an answer key', c => { (c.steps[1] as { answerKeys: string[] }).answerKeys.push('hanako@example.com') }],
      ['a number as an answer key', c => { (c.steps[1] as { answerKeys: string[] }).answerKeys.push('48213') }],
      ['a non-ASCII answer key', c => { (c.steps[1] as { answerKeys: string[] }).answerKeys.push('山田花子') }],
      ['a reference to a later step', c => { (c.steps[4] as { after: number }).after = 6 }],
      ['a reference to a step that is gone', c => { c.steps.splice(3, 1) }],
      ['a source that is not an answer', c => { (c.steps[2] as { from: unknown }).from = { step: 1, key: 'end_date' } }],
      ['an extra key on a step', c => { (c.steps[3] as Record<string, unknown>).text = 'page text' }],
      ['a body or a header field', c => { (c as unknown as Record<string, unknown>).cookie = 'sid=1' }],
      ['another domain', c => { c.domain = 'other.example.test' }],
      ['the domain as an other host', c => { c.hosts.push({ host: DOMAIN, loaded: true }) }],
      ['ids out of order', c => { (c.steps[1] as { id: number }).id = 1 }],
      ['no step', c => { c.steps = [] }],
    ]
    for (const [what, change] of bad) {
      const c = recording()
      change(c)
      expect(browserRecordingProblem(c, DOMAIN), what).not.toBeNull()
    }
  })

  it('the kept forms: digit runs and tokens masked, query keys only, labels without numbers or e-mails, applying twice changes nothing', () => {
    expect(browserAddressPattern(`https://${DOMAIN}/orders/48213/items/a8f3k2j9d0s8f7g6h5j4?page=2&q=山田#x`, DOMAIN)).toBe('/orders/{n}/items/{x}?page&q')
    expect(browserAddressPattern(`https://other.example.test/orders/1`, DOMAIN)).toBeNull()
    expect(browserAddressPattern(`http://${DOMAIN}/orders/1`, DOMAIN)).toBeNull()
    expect(browserKeyPattern('48213')).toBe('{n}')
    expect(browserKeyPattern('hanako@example.com')).toBe('{mail}')
    expect(browserKeyPattern('山田')).toBe('{x}')
    expect(browserKeyPattern('items[0][name]')).toBe('items[{n}][name]')
    for (const text of ['  保存 ', '注文 48213 を保存', 'hanako@example.com に送る', 'https://x.test/a を開く', '受付終了日'.repeat(20)]) {
      const once = browserLabel(text)
      expect(browserLabel(once)).toBe(once)
      expect(once).not.toMatch(/[0-9]{2}|@/)
    }
  })
})

describe('sending', () => {
  it('a member on an enabled PC sends one; it is kept with 30 days to live', () => {
    const r = value(send(alice, enabledPc(alice)))
    expect(r).toMatchObject({ userId: alice.userId, domain: DOMAIN, lines: 6, createdAt: iso(T0), deleteAt: iso(T0 + 30 * DAY), mine: true })
    expect(value(svc.get(alice, r.id)).content).toEqual(recording())
  })

  it('needs this PC, the company\'s 「使う」 and the domain registered', () => {
    expect(code(send(alice, undefined))).toBe('BROWSER_DEVICE_NOT_REGISTERED')
    const pending = newKey()
    value(dev.register(alice, pending, { label: 'x' }))
    expect(code(send(alice, pending))).toBe('BROWSER_DEVICE_PENDING')
    const key = enabledPc(alice)
    policy = { mode: 'off', sites: [{ host: DOMAIN, level: 'read', assetHosts: [] }] }
    expect(code(send(alice, key))).toBe('BROWSER_NOT_ALLOWED')
    policy = { mode: 'on', sites: [{ host: 'other.example.test', level: 'read', assetHosts: [] }] }
    expect(code(send(alice, key))).toBe('BROWSER_NOT_ALLOWED')
    // Registered now: the domain's own recording goes.
    expect(status(send(alice, key, recording('other.example.test'), 'other.example.test'))).toBe('ok')
    // The owner's transition exception, as for every plan step.
    policy = { mode: 'on', sites: [{ host: DOMAIN, level: 'read', assetHosts: [] }] }
    expect(status(send(owner, undefined))).toBe('ok')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_recordings').get()).toEqual({ n: 2 })
  })

  it('needs the person allowed at least 見るだけ on the domain (「使える人」, the same rule as the AI\'s): 使わない is refused', () => {
    const key = enabledPc(alice)
    value(grants.set(owner, alice.userId, { host: DOMAIN, level: 'none' }))
    expect(code(send(alice, key))).toBe('BROWSER_NOT_ALLOWED')
    value(grants.set(owner, alice.userId, { host: DOMAIN, level: 'read' }))
    expect(status(send(alice, key))).toBe('ok')
    // Owners and admins follow the same table.
    value(grants.set(owner, owner.userId, { host: DOMAIN, level: 'none' }))
    expect(code(send(owner, undefined))).toBe('BROWSER_NOT_ALLOWED')
  })

  it('a recording that is not in its kept form is refused and nothing is stored', () => {
    const key = enabledPc(alice)
    const c = recording()
    ;(c.steps[2] as { value: string }).value = '2026-12-03'
    expect(code(send(alice, key, c))).toBe('BROWSER_RECORDING_BAD')
    expect(code(svc.send(alice, key, { domain: DOMAIN, content: recording(), extra: 1 }))).toBe('BROWSER_RECORDING_BAD')
    const big = recording()
    big.steps = Array.from({ length: BROWSER_RECORDING_LIMITS.steps + 1 }, (_, i) => ({ id: i + 1, kind: 'page' as const, address: '/a' }))
    expect(code(send(alice, key, big))).toBe('BROWSER_RECORDING_BAD')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_recordings').get()).toEqual({ n: 0 })
  })
})

describe('who reads and deletes', () => {
  it('the sender and current owners / admins read it; another member and another company do not (the same 404 as none)', () => {
    const r = value(send(alice, enabledPc(alice)))
    for (const m of [alice, owner, admin]) expect(value(svc.get(m, r.id)).id).toBe(r.id)
    for (const m of [bob, otherOwner]) {
      expect(code(svc.get(m, r.id))).toBe('BROWSER_RECORDING_NOT_FOUND')
      expect(code(svc.remove(m, r.id))).toBe('BROWSER_RECORDING_NOT_FOUND')
    }
    expect(value(svc.list(bob)).items).toEqual([])
    expect(value(svc.list(otherOwner)).items).toEqual([])
    expect(value(svc.list(alice)).items.map(i => i.id)).toEqual([r.id])
    expect(value(svc.list(admin)).items.map(i => [i.id, i.mine, i.name])).toEqual([[r.id, false, `Name ${alice.userId}`]])
    // A member's own list holds only their own.
    value(send(bob, enabledPc(bob)))
    expect(value(svc.list(alice)).items.map(i => i.id)).toEqual([r.id])
    expect(value(svc.list(owner)).items).toHaveLength(2)
  })

  it('an admin who is demoted reads nothing more at once', () => {
    const r = value(send(alice, enabledPc(alice)))
    expect(status(svc.get({ ...admin, role: 'member' }, r.id))).toBe('not-found')
  })

  it('the sender who left reads nothing — not even after coming back —, and the company keeps it until its 30 days', () => {
    const r = value(send(alice, enabledPc(alice)))
    leave(CO, alice.userId)
    now = T0 + DAY
    join(CO, alice.userId, 'member', iso(now))
    expect(code(svc.get(alice, r.id))).toBe('BROWSER_RECORDING_NOT_FOUND')
    expect(value(svc.list(alice)).items).toEqual([])
    expect(code(svc.remove(alice, r.id))).toBe('BROWSER_RECORDING_NOT_FOUND')
    expect(value(svc.get(owner, r.id)).id).toBe(r.id)
  })

  it('the sender or an owner / admin deletes it, content included', () => {
    const a = value(send(alice, enabledPc(alice)))
    const b = value(send(alice, enabledPc(alice)))
    expect(value(svc.remove(alice, a.id))).toEqual({ deleted: true })
    expect(value(svc.remove(admin, b.id))).toEqual({ deleted: true })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_recordings').get()).toEqual({ n: 0 })
    expect(code(svc.get(owner, a.id))).toBe('BROWSER_RECORDING_NOT_FOUND')
  })

  it('a stored recording never changes', () => {
    const r = value(send(alice, enabledPc(alice)))
    expect(() => conn.prepare("UPDATE browser_recordings SET content = '{}' WHERE id = ?").run(r.id)).toThrow(/never changes/)
  })
})

describe('30 days', () => {
  it('past its 30 days every read leaves it out, and the server clock deletes it', () => {
    const r = value(send(alice, enabledPc(alice)))
    const other = value(send(otherOwner, enabledPc(otherOwner)))
    now = T0 + 30 * DAY - 1
    expect(value(svc.get(owner, r.id)).id).toBe(r.id)
    expect(svc.expire(CO)).toBe(0)
    now = T0 + 30 * DAY
    expect(code(svc.get(owner, r.id))).toBe('BROWSER_RECORDING_NOT_FOUND')
    expect(value(svc.list(owner)).items).toEqual([])
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_recordings WHERE company_id = ?').get(CO)).toEqual({ n: 1 })
    expect(svc.expire(CO)).toBe(1)
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_recordings WHERE company_id = ?').get(CO)).toEqual({ n: 0 })
    // Another company's is its own clock run's.
    expect(conn.prepare('SELECT id FROM browser_recordings WHERE company_id = ?').get(OTHER_CO)).toEqual({ id: other.id })
  })
})
