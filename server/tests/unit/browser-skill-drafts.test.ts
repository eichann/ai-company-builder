/**
 * A Skill's draft made from a member's own recordings on the server (services/browser-skill-drafts.ts; agent-browser.md
 * "A Skill's draft from a recording"; design memo 「記録からSkillの下書き」 I1, I2, I5, I6, D2, D5, D9), against a real
 * database, the real recordings and PC services. The site is fictional.
 *
 * Guards (each mutation-checked): the draft is made with the recording in one transaction (a failure stores neither);
 * a draft is its author's alone — another member, an owner, an admin, another company, the author after leaving and
 * coming back get the same 404 and list nothing; only the author's own recordings (sent while a member this time, still
 * kept) are read or used — an owner who reads every recording in the admin console cannot make a draft from someone
 * else's or see it through a draft; a change of `browser.yaml` is taken only when no wider than what the recordings gave
 * (no DELETE, no wide path, no other domain, one budget per recorded target); the base never changes; every change is a
 * compare-and-set on the version; 10 drafts per person; 30 days after the last change.
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
import { createBrowserSiteGrants } from '../../src/services/browser-site-grants'
import { BROWSER_SKILL_DRAFT_SERVER_LIMITS, createBrowserSkillDraftService, type BrowserSkillDraftService } from '../../src/services/browser-skill-drafts'
import { browserRecordingProblem, type BrowserRecordedSend, type BrowserRecordingContent, type BrowserRecordingStep } from '../../../shared/core/browser-recording'
import { browserSkillDraftFrom } from '../../../shared/core/browser-skill-draft'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'
import type { BrowserDeviceView } from '../../../shared/types/browser-devices'
import type { BrowserRecordingSent } from '../../../shared/types/browser-recordings'
import type { BrowserSkillDraftDetail } from '../../../shared/types/browser-skill-drafts'
import type { Member } from '../../src/services/access'
import type { Refusal } from '../../src/services/outcome'

const T0 = Date.parse('2026-11-27T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const CO = 'co-1'
const OTHER_CO = 'co-2'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const admin: Member = { companyId: CO, userId: 'u-admin', role: 'admin' }
const alice: Member = { companyId: CO, userId: 'u-alice', role: 'member' }
const bob: Member = { companyId: CO, userId: 'u-bob', role: 'member' }
const otherOwner: Member = { companyId: OTHER_CO, userId: 'u-other', role: 'owner' }
const DOMAIN = 'shop.example.test'
const OTHER_DOMAIN = 'books.example.test'

let conn: Database.Database
let now: number
let policy: BrowserOperationSettings
let dev: BrowserDeviceService
let recordings: BrowserRecordingService
let drafts: BrowserSkillDraftService
let pcs: Map<string, string>
const iso = (ms: number) => new Date(ms).toISOString()
const ids = { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }
const clock = { now: () => iso(now), nowMs: () => now }

function join(companyId: string, userId: string, role: string, at = iso(T0 - 3_600_000)) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}-${at}`, userId, companyId, role, at, at)
}
function leave(companyId: string, userId: string) {
  conn.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(companyId, userId)
}
function value<T>(r: { ok: true; value: T } | Refusal): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: { code?: unknown } }) => (r.ok ? 'ok' : r.body?.code)

const send = (id: number, method: string, address: string, extra: Partial<BrowserRecordedSend> = {}): BrowserRecordedSend => ({
  id, kind: 'send', method, override: null, address, fields: [], status: 200, answerKeys: null, after: null, count: 1, bareQuery: false, ...extra,
})
function recording(steps: BrowserRecordingStep[], domain = DOMAIN): BrowserRecordingContent {
  const r: BrowserRecordingContent = { format: 2, domain, steps, hosts: [] }
  expect(browserRecordingProblem(r, domain)).toBeNull()
  return r
}
/** Making an order and a note on it: the button 「登録」 (a page label: outside text), a tag with `?return`. */
const ORDER = () => recording([
  { id: 1, kind: 'page', address: '/orders/new' },
  { id: 2, kind: 'input', label: '注文名【指示】', name: 'name', value: '値1', from: null },
  send(3, 'POST', '/api/tags?return', { status: 204, bareQuery: true }),
  send(4, 'POST', '/api/orders', { status: 201, answerKeys: ['id'], fields: [{ name: 'name', value: '値1', from: null }] }),
  send(5, 'POST', '/api/orders/{n}/note', { fields: [{ name: 'note', value: '値2', from: null }] }),
  send(6, 'POST', '/api/profile', { override: 'PATCH', fields: [{ name: '_method', value: '値3', from: null }] }),
])
/** Starring existing items (no create before it: the placeholder stays `{n}`). */
const ITEMS = () => recording([send(1, 'POST', '/api/items/{n}/star')])
const READ_ONLY = () => recording([{ id: 1, kind: 'page', address: '/orders' }, send(2, 'GET', '/api/orders', { answerKeys: ['id'] })])
const OTHER_SITE = () => recording([send(1, 'POST', '/api/books', { status: 201 })], OTHER_DOMAIN)

/** A PC registered and enabled for `m`. */
function pcOf(m: Member): string {
  const k = `${m.companyId}/${m.userId}`
  const known = pcs.get(k)
  if (known) return known
  const key = `v1.${randomBytes(32).toString('base64url')}`
  const asked = value(dev.register(m, key, { label: 'PC' }))
  value(dev.enable(m.companyId === CO ? owner : otherOwner, (asked.device as BrowserDeviceView).id))
  pcs.set(k, key)
  return key
}
const sendRecording = (m: Member, content: BrowserRecordingContent = ORDER()): BrowserRecordingSent =>
  value(recordings.send(m, pcOf(m), { domain: content.domain, content }))
/** A recording sent by `m` and its draft. */
function draftOf(m: Member = alice, content: BrowserRecordingContent = ORDER()): BrowserSkillDraftDetail {
  const sent = sendRecording(m, content)
  return value(drafts.get(m, sent.draftId as string))
}

function build(makeOnSend?: BrowserSkillDraftService['makeOnSend']) {
  const data = sqliteCompanyData(conn)
  const memberships = sqliteMembershipRepository(conn)
  const transactions = sqliteTransactions(conn)
  dev = createBrowserDeviceService({ companyData: data, transactions, clock, ids, tokenDigest: sha256TokenDigest, accounts: { byIds: () => new Map() } })
  const grants = createBrowserSiteGrants({ companyData: data, clock, memberships, browserPolicy: () => policy })
  drafts = createBrowserSkillDraftService({ companyData: data, clock, ids, memberships, transactions })
  recordings = createBrowserRecordingService({
    companyData: data, clock, ids, memberships, accounts: { byIds: () => new Map() }, siteGrants: grants, devices: dev.gate, transactions,
    drafts: { makeOnSend: makeOnSend ?? drafts.makeOnSend },
  })
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, admin.userId, 'admin'); join(CO, alice.userId, 'member'); join(CO, bob.userId, 'member')
  join(OTHER_CO, otherOwner.userId, 'owner')
  now = T0
  pcs = new Map()
  policy = { mode: 'on', sites: [{ host: DOMAIN, level: 'write', assetHosts: [] }, { host: OTHER_DOMAIN, level: 'write', assetHosts: [] }] }
  build()
})

describe('made when a recording is sent', () => {
  it('a recording with a write the rule keeps gives a draft in the same answer: the base is the core\'s text, nothing written yet', () => {
    const content = ORDER()
    const sent = sendRecording(alice, content)
    expect(sent.draftId).toMatch(/^bd_[0-9a-f]{32}$/)
    expect(sent.draftNote).toContain('下書きができました')
    const d = value(drafts.get(alice, sent.draftId as string))
    const made = browserSkillDraftFrom([content])
    if (!made.ok) throw new Error('fixture')
    expect(d).toMatchObject({ domain: DOMAIN, recordingIds: [sent.id], baseDeclaration: made.draft.text, declaration: made.draft.text, steps: '', triedVersion: null })
    expect(d.name).toMatch(/^draft-[0-9a-f]{6}$/)
    expect(d.notes.writes.find(w => w.marks.includes('updates-existing'))).toBeTruthy()
    // The recording comes back in its stored kept form: the author's own, nothing added or taken away.
    expect(d.sources).toEqual([{ id: sent.id, createdAt: sent.createdAt, content }])
    expect(d.deleteAt).toBe(iso(T0 + 30 * DAY))
  })

  it('a recording with nothing to write is stored without a draft, and says why', () => {
    const sent = sendRecording(alice, READ_ONLY())
    expect(sent.draftId).toBeNull()
    expect(sent.draftNote).toContain('下書きにできる書き込みがありません')
    expect(value(recordings.get(alice, sent.id)).id).toBe(sent.id)
  })

  it('the recording and its draft are one transaction: a failure while making the draft stores neither', () => {
    build(() => { throw new Error('halfway') })
    expect(() => recordings.send(alice, pcOf(alice), { domain: DOMAIN, content: ORDER() })).toThrow('halfway')
    expect(value(recordings.list(alice)).items).toEqual([])
  })

  it(`at most ${BROWSER_SKILL_DRAFT_SERVER_LIMITS.perMember} drafts per person: the recording is still kept (the company's too), without a draft`, () => {
    for (let i = 0; i < BROWSER_SKILL_DRAFT_SERVER_LIMITS.perMember; i++) sendRecording(alice)
    const sent = sendRecording(alice)
    expect(sent.draftId).toBeNull()
    expect(sent.draftNote).toContain('ひとり10件まで')
    expect(code(drafts.create(alice, { recordingIds: [sent.id] }))).toBe('BROWSER_SKILL_DRAFT_LIMIT')
    // Another person has their own room.
    expect(sendRecording(bob).draftId).not.toBeNull()
    // One deleted frees a place.
    value(drafts.remove(alice, value(drafts.list(alice)).drafts[0].id))
    expect(code(drafts.create(alice, { recordingIds: [sent.id] }))).toBe('ok')
  })
})

describe('whose (I5, D9): the author alone', () => {
  it('another member, an owner, an admin and another company get the same 404 as none, and list nothing of it', () => {
    const d = draftOf(alice)
    expect(code(drafts.get(alice, `bd_${'0'.repeat(32)}`))).toBe('BROWSER_SKILL_DRAFT_NOT_FOUND')
    for (const m of [bob, owner, admin, otherOwner]) {
      expect(code(drafts.get(m, d.id)), m.userId).toBe('BROWSER_SKILL_DRAFT_NOT_FOUND')
      expect(code(drafts.save(m, d.id, { expectedVersion: d.version, steps: 'x' })), m.userId).toBe('BROWSER_SKILL_DRAFT_NOT_FOUND')
      expect(code(drafts.remove(m, d.id)), m.userId).toBe('BROWSER_SKILL_DRAFT_NOT_FOUND')
      expect(value(drafts.list(m)).drafts.map(x => x.id), m.userId).not.toContain(d.id)
    }
    expect(value(drafts.get(alice, d.id)).id).toBe(d.id)
  })

  it('the author who left sees nothing of it — also after coming back', () => {
    const d = draftOf(alice)
    leave(CO, alice.userId)
    expect(code(drafts.get(alice, d.id))).toBe('BROWSER_SKILL_DRAFT_NOT_FOUND')
    expect(value(drafts.list(alice))).toEqual({ drafts: [], recordings: [] })
    now = T0 + DAY
    join(CO, alice.userId, 'member', iso(now))
    expect(code(drafts.get(alice, d.id))).toBe('BROWSER_SKILL_DRAFT_NOT_FOUND')
    expect(value(drafts.list(alice))).toEqual({ drafts: [], recordings: [] })
    expect(code(drafts.create(alice, { recordingIds: d.recordingIds }))).toBe('BROWSER_RECORDING_NOT_FOUND')
  })
})

describe('what the AI may read (I1, D1): the author\'s own recordings only', () => {
  it('the list holds the author\'s own recordings only — an owner\'s too, although the admin console shows them every one', () => {
    const a = sendRecording(alice)
    const o = sendRecording(owner)
    expect(value(recordings.list(owner)).items.map(r => r.id)).toEqual(expect.arrayContaining([a.id, o.id]))
    expect(value(drafts.list(owner)).recordings.map(r => r.id)).toEqual([o.id])
    expect(value(drafts.list(alice)).recordings.map(r => r.id)).toEqual([a.id])
  })

  it('a draft is never made from someone else\'s recording — by an owner or admin neither — and the answer is the one for none', () => {
    const a = sendRecording(alice)
    for (const m of [owner, admin, bob, otherOwner]) {
      expect(code(drafts.create(m, { recordingIds: [a.id] })), m.userId).toBe('BROWSER_RECORDING_NOT_FOUND')
      expect(code(drafts.create(m, { recordingIds: [`br_${'0'.repeat(32)}`] })), m.userId).toBe('BROWSER_RECORDING_NOT_FOUND')
    }
    // Mixed with one of their own: still refused, nothing made.
    const o = sendRecording(owner)
    const before = value(drafts.list(owner)).drafts.length
    expect(code(drafts.create(owner, { recordingIds: [o.id, a.id] }))).toBe('BROWSER_RECORDING_NOT_FOUND')
    expect(value(drafts.list(owner)).drafts.length).toBe(before)
  })

  it('a recording past its 30 days is no longer handed out; the draft keeps its name', () => {
    const d = draftOf(alice)
    now = T0 + 29 * DAY
    value(drafts.save(alice, d.id, { expectedVersion: d.version, steps: '# 手順' }))
    now = T0 + 31 * DAY
    const later = value(drafts.get(alice, d.id))
    expect(later.sources).toEqual([])
    expect(later.recordingIds).toEqual(d.recordingIds)
  })
})

describe('made again from own recordings (remake)', () => {
  it('1–5 own recordings of one domain, in the order given', () => {
    const first = sendRecording(alice, recording([send(1, 'POST', '/api/tags', { status: 201 })]))
    const second = sendRecording(alice)
    const d = value(drafts.create(alice, { recordingIds: [first.id, second.id], name: 'order-note' }))
    expect(d.recordingIds).toEqual([first.id, second.id])
    expect(d.name).toBe('order-note')
    expect(d.sources.map(s => s.id)).toEqual([first.id, second.id])
    expect(code(drafts.create(alice, { recordingIds: [first.id, second.id], name: 'order-note' }))).toBe('BROWSER_SKILL_DRAFT_NAME_TAKEN')
    const other = sendRecording(alice, OTHER_SITE())
    expect(code(drafts.create(alice, { recordingIds: [first.id, other.id] }))).toBe('BROWSER_SKILL_DRAFT_NONE')
    const six = Array.from({ length: 6 }, () => `br_${randomBytes(16).toString('hex')}`)
    expect(code(drafts.create(alice, { recordingIds: six }))).toBe('BROWSER_SKILL_DRAFT_BAD')
    expect(code(drafts.create(alice, { recordingIds: [first.id, first.id] }))).toBe('BROWSER_SKILL_DRAFT_BAD')
    expect(code(drafts.create(alice, { recordingIds: [first.id], extra: 1 }))).toBe('BROWSER_SKILL_DRAFT_BAD')
    expect(code(drafts.create(alice, { recordingIds: [first.id], name: 'Bad Name' }))).toBe('BROWSER_SKILL_DRAFT_BAD_NAME')
  })
})

describe('a change never widens (I2, I6)', () => {
  const base = (d: BrowserSkillDraftDetail) => d.baseDeclaration
  it('narrowing is taken: a write left out, a fixed field added, a placeholder made a number, reads added', () => {
    const d = draftOf(alice)
    const narrower = base(d)
      .replace('  - { method: POST, path: "/api/profile", max: 1, fields: { _method: PATCH } }\n', '')
      .replace('path: "/api/orders", max: 1 }', 'path: "/api/orders", max: 1, fields: { kind: "0" } }')
      + 'never_read: ["/orders/{n}/delete"]\n'
    expect(narrower).not.toBe(base(d))
    const saved = value(drafts.save(alice, d.id, { expectedVersion: d.version, declaration: narrower, steps: '# 手順', name: 'order-note' }))
    expect(saved).toMatchObject({ declaration: narrower, steps: '# 手順', name: 'order-note', baseDeclaration: base(d) })
    expect(saved.version).not.toBe(d.version)
  })

  it('anything wider is refused and nothing changes: a write never recorded, a DELETE, a path from a placeholder, another domain, one target split past its budget', () => {
    const d = draftOf(alice)
    const wider: Array<[string, string, string]> = [
      ['a write never recorded', base(d).replace('/api/tags', '/api/users'), 'not-covered'],
      ['a DELETE', base(d).replace('method: POST, path: "/api/tags"', 'method: DELETE, path: "/api/tags"'), 'deletes'],
      ['a wide path', base(d).replace('path: "/api/tags"', 'path: "/{x}/tags"'), 'wide-path'],
      ['another domain', base(d).replace(`domain: ${DOMAIN}`, `domain: ${OTHER_DOMAIN}`), 'domain'],
    ]
    for (const [what, text, problem] of wider) {
      const r = drafts.save(alice, d.id, { expectedVersion: d.version, declaration: text })
      expect(code(r), what).toBe('BROWSER_SKILL_DRAFT_WIDER')
      if (!r.ok) expect(r.body.problem, what).toBe(problem)
    }
    expect(code(drafts.save(alice, d.id, { expectedVersion: d.version, declaration: 'domain: [' }))).toBe('BROWSER_SKILL_DRAFT_BAD_DECLARATION')
    expect(value(drafts.get(alice, d.id)).declaration).toBe(base(d))
    // One recorded target split into narrower ones keeps one budget of 20.
    const items = draftOf(alice, ITEMS())
    expect(items.baseDeclaration).toContain('path: "/api/items/{n}/star"')
    const split = `domain: ${DOMAIN}\nwrites:\n  - { method: POST, path: "/api/items/1/star", max: 15 }\n  - { method: POST, path: "/api/items/2/star", max: 15 }\n`
    const r = drafts.save(alice, items.id, { expectedVersion: items.version, declaration: split })
    expect(code(r)).toBe('BROWSER_SKILL_DRAFT_WIDER')
    if (!r.ok) expect(r.body.problem).toBe('too-many-uses')
    expect(code(drafts.save(alice, items.id, { expectedVersion: items.version, declaration: split.replace(/max: 15/g, 'max: 10') }))).toBe('ok')
  })

  it('the base never changes (trigger), nor the author, domain or recordings', () => {
    const d = draftOf(alice)
    for (const set of ["base_declaration = 'x'", "base_notes = '{}'", "user_id = 'u-bob'", "domain = 'x.test'", "recording_ids = '[]'"]) {
      expect(() => conn.prepare(`UPDATE browser_skill_drafts SET ${set} WHERE id = ?`).run(d.id), set).toThrow(/keeps its author/)
    }
  })
})

describe('changes: the version, the name, the size', () => {
  it('a change needs the version read; the later of two gets 409 with the current one', () => {
    const d = draftOf(alice)
    const first = value(drafts.save(alice, d.id, { expectedVersion: d.version, steps: 'A' }))
    const late = drafts.save(alice, d.id, { expectedVersion: d.version, steps: 'B' })
    expect(code(late)).toBe('BROWSER_SKILL_DRAFT_CHANGED')
    if (!late.ok) expect(late.body.version).toBe(first.version)
    expect(value(drafts.get(alice, d.id)).steps).toBe('A')
  })

  it('a name by the Skill name rule, once per author; SKILL.md up to 32 KB; a body of exactly its keys', () => {
    const d = draftOf(alice)
    const e = draftOf(alice)
    value(drafts.save(alice, d.id, { expectedVersion: d.version, name: 'order-note' }))
    expect(code(drafts.save(alice, e.id, { expectedVersion: e.version, name: 'order-note' }))).toBe('BROWSER_SKILL_DRAFT_NAME_TAKEN')
    // Bob may use the same name: names are per author until a request places it.
    const b = draftOf(bob)
    expect(code(drafts.save(bob, b.id, { expectedVersion: b.version, name: 'order-note' }))).toBe('ok')
    for (const name of ['Order', '日本語', '-x', 'a'.repeat(65), 'a/b']) {
      expect(code(drafts.save(alice, e.id, { expectedVersion: e.version, name })), name).toBe('BROWSER_SKILL_DRAFT_BAD_NAME')
    }
    expect(code(drafts.save(alice, e.id, { expectedVersion: e.version, steps: 'あ'.repeat(11_000) }))).toBe('BROWSER_SKILL_DRAFT_TOO_LARGE')
    expect(code(drafts.save(alice, e.id, { expectedVersion: e.version, steps: 'x'.repeat(32 * 1024) }))).toBe('ok')
    expect(code(drafts.save(alice, e.id, { expectedVersion: 'sha256:x' }))).toBe('BROWSER_SKILL_DRAFT_BAD')
    expect(code(drafts.save(alice, e.id, { expectedVersion: e.version, other: 1 }))).toBe('BROWSER_SKILL_DRAFT_BAD')
    expect(code(drafts.save(alice, e.id, { expectedVersion: value(drafts.get(alice, e.id)).version }))).toBe('BROWSER_SKILL_DRAFT_BAD')
  })
})

describe('30 days after the last change (D5)', () => {
  it('a change moves its day; past it every read leaves it out and the server clock deletes it', () => {
    const d = draftOf(alice)
    now = T0 + 20 * DAY
    const saved = value(drafts.save(alice, d.id, { expectedVersion: d.version, steps: '# 手順' }))
    expect(saved.deleteAt).toBe(iso(now + 30 * DAY))
    now = T0 + 49 * DAY
    expect(value(drafts.get(alice, d.id)).id).toBe(d.id)
    expect(drafts.expire(CO)).toBe(0)
    now = T0 + 51 * DAY
    expect(code(drafts.get(alice, d.id))).toBe('BROWSER_SKILL_DRAFT_NOT_FOUND')
    expect(value(drafts.list(alice)).drafts).toEqual([])
    expect(drafts.expire(CO)).toBe(1)
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_skill_drafts').get()).toEqual({ n: 0 })
  })

  it('deleting is the author\'s, and the row is gone', () => {
    const d = draftOf(alice)
    expect(value(drafts.remove(alice, d.id))).toEqual({ deleted: true })
    expect(code(drafts.get(alice, d.id))).toBe('BROWSER_SKILL_DRAFT_NOT_FOUND')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_skill_drafts').get()).toEqual({ n: 0 })
  })
})
