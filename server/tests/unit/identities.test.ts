/**
 * Matching people and companies (名寄せ, `.claude/rules/identity.md`):
 * services/identities.ts over the real SQLite handle.
 *
 * Guards:
 * - the same address is one 相手; the same company domain is one company —
 *   never a free-mail domain, never a person by domain, never across kinds;
 * - anything else only through a proposal a person approves (merging), a
 *   rejected pair is not proposed again, a pending one is not duplicated;
 * - split takes a record out for good: automatic matching never puts it back,
 *   while new records with the same address still join the original;
 * - history keeps every step;
 * - no leaks: a record the caller cannot read (private folder, someone's own
 *   record — owners and admins included) is missing from members, proposals,
 *   history and address lookups, and naming it gets the missing answer;
 * - another company's records and proposals are missing and stay unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createIdentityService, type IdentityService } from '../../src/services/identities'
import type { Member } from '../../src/services/access'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

const TS = '2026-11-02T00:00:00.000Z'
const CUSTOMER_TYPE = '---\nlabel: 顧客\nversion: 1\nstorage: server\nimplements: [counterpart]\nfields:\n  counterpart_kind: { label: 会社か人か, kind: choice, options: [company, person], source: server }\n  domain: { label: ドメイン, kind: text, source: server }\n  email: { label: メール, kind: text, source: server }\nstates: [active]\n---\n'

let conn: Database.Database
let source: CompanyDataSource
let svc: IdentityService
let n = 0

const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: ROLES[userId] ?? 'member' })

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 秘書室: a folder u-mallory cannot read.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '秘書室', 'folder', ?)").run(`${id}-sec`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-sec-e`, `${id}-sec`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-mallory', 0, 0, ?)").run(`${id}-sec-m`, `${id}-sec`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  const t = parseTypeFile('customer', CUSTOMER_TYPE)
  if (!t.ok) throw new Error(t.errors.join())
  records.insertTypeVersion({ name: 'customer', version: 1, definition: canonicalTypeJson(t.definition), source: 'file', commitSha: null, createdAt: TS })
}

/** A 相手 record (server only), optionally in a folder or someone's own. */
function customer(title: string, fields: Record<string, string>, opts: { co?: string; folder?: string; owner?: string } = {}): string {
  const id = `customer-${String(++n).padStart(8, '0')}`
  const records = source.forCompany(opts.co ?? 'a').records
  records.upsert({
    id, type: 'customer', typeVersion: 1, scopeId: null, path: null, folder: opts.folder ?? null, personalOwner: opts.owner ?? null,
    title, summary: '', createdAt: TS, updatedAt: TS, removedAt: null,
  })
  records.writeState({ recordId: id, state: 'active', fields: JSON.stringify(fields), version: 1, updatedAt: TS }, 0)
  return id
}

const identityOf = (id: string, who = 'u-alice', co = 'a') => ok(svc.ofRecord(m(who, co), id))
const memberIds = (id: string, who = 'u-alice') => identityOf(id, who).members.map(x => x.recordId).sort()
const company_ = (domain: string, email = '') => ({ counterpart_kind: 'company', domain, email })
const person = (email: string) => ({ counterpart_kind: 'person', email })

beforeEach(() => {
  n = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let tick = 0
  let id = 0
  svc = createIdentityService({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => `2026-11-02T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 },
    ids: { newId: () => `id-${++id}`, newToken: () => 't' },
  })
  company('a')
  company('b')
})

describe('automatic matching', () => {
  it('the same address is one person; the same company domain is one company', () => {
    const p1 = customer('鈴木さん（HubSpot）', person('Suzuki@A-Corp.example'))
    const p2 = customer('鈴木 一郎（メール）', person('suzuki@a-corp.example'))
    const c1 = customer('株式会社エー', company_('a-corp.example'))
    const c2 = customer('株式会社エー（freee）', company_('', 'info@a-corp.example'))
    const c3 = customer('エー社', company_('www.A-CORP.example'))
    expect(memberIds(p1)).toEqual([p1, p2].sort())
    expect(memberIds(c1)).toEqual([c1, c2, c3].sort())
    // A person is never put into the company by its domain.
    expect(memberIds(c1)).not.toContain(p1)
    const hist = identityOf(c1).history
    expect(hist.filter(h => h.action === 'joined').map(h => h.how).sort()).toEqual(['domain', 'domain', 'new'])
    expect(hist.every(h => h.actor.kind === 'auto')).toBe(true)
  })

  it('a free-mail domain never makes two companies one, nor people one company', () => {
    const g1 = customer('個人事業 A', company_('gmail.com', 'a.shop@gmail.com'))
    const g2 = customer('個人事業 B', company_('', 'b.shop@gmail.com'))
    const y1 = customer('C 商店', company_('', 'c@mail.yahoo.co.jp'))
    const y2 = customer('D 商店', company_('', 'd@yahoo.co.jp'))
    expect(memberIds(g1)).toEqual([g1])
    expect(memberIds(g2)).toEqual([g2])
    expect(memberIds(y1)).toEqual([y1])
    expect(memberIds(y2)).toEqual([y2])
    // The same Gmail address is still the same 相手.
    const g3 = customer('個人事業 A（請求）', company_('', 'A.Shop@gmail.com'))
    expect(memberIds(g1)).toEqual([g1, g3].sort())
    // Address lookups: a Gmail sender finds its own 相手 but no company by domain.
    expect(ok(svc.resolveAddress(m('u-alice'), 'someone@gmail.com'))).toEqual({ person: [], company: [] })
    expect(ok(svc.resolveAddress(m('u-alice'), 'a.shop@gmail.com')).company.sort()).toEqual([g1, g3].sort())
  })

  it('a company and a person are not matched, even by the same address', () => {
    const c = customer('株式会社ビー', company_('b-corp.example', 'info@b-corp.example'))
    const p = customer('受付', person('info@b-corp.example'))
    expect(memberIds(c)).toEqual([c])
    expect(memberIds(p)).toEqual([p])
  })

  it('an address finds the person and, through the domain, the company', () => {
    const c = customer('株式会社エー', company_('a-corp.example'))
    const p = customer('山口さん', person('yamaguchi@a-corp.example'))
    expect(ok(svc.resolveAddress(m('u-alice'), 'YAMAGUCHI@a-corp.example'))).toEqual({ person: [p], company: [c] })
    expect(ok(svc.resolveAddress(m('u-alice'), 'new@a-corp.example'))).toEqual({ person: [], company: [c] })
  })
})

describe('proposals and approval', () => {
  it('two different-looking 相手 become one only when a person approves', () => {
    const hub = customer('株式会社サンプル', company_('sample.example'))
    const free = customer('株式会社エス（freee）', company_('s-sample.example'))
    const r = ok(svc.propose(m('u-alice'), { kind: 'ai' }, { a: hub, b: free, reason: '請求先の住所と電話番号が同じ', confidence: 0.8 }))
    expect(r.created).toBe(true)
    expect(memberIds(hub)).toEqual([hub])
    expect(ok(svc.proposals(m('u-bob'))).proposals.map(p => p.id)).toEqual([r.proposal.id])
    // The same pair again is the same proposal, not a second one.
    expect(ok(svc.propose(m('u-bob'), { kind: 'ai' }, { a: free, b: hub, reason: '同じ', confidence: null }))).toMatchObject({ created: false, proposal: { id: r.proposal.id } })

    const d = ok(svc.decide(m('u-bob'), r.proposal.id, 'approve'))
    expect(d.proposal).toMatchObject({ status: 'approved', decidedBy: 'u-bob' })
    expect(memberIds(hub)).toEqual([hub, free].sort())
    // A new record with the other's domain now joins the merged identity.
    const later = customer('サンプル社', company_('s-sample.example'))
    expect(memberIds(hub)).toContain(later)
    const actions = identityOf(hub).history.map(h => `${h.recordId === hub ? 'hub' : h.recordId === free ? 'free' : 'later'}:${h.action}:${h.actor.kind}`)
    expect(actions).toEqual(expect.arrayContaining(['hub:joined:auto', 'hub:proposed:ai', 'free:proposed:ai', 'hub:approved:human', 'free:approved:human', 'later:joined:auto']))
    // Decided once.
    expect(svc.decide(m('u-alice'), r.proposal.id, 'reject')).toMatchObject({ ok: false, kind: 'conflict' })
  })

  it('a rejected pair stays apart and is not proposed again', () => {
    const x = customer('エックス商事', company_('x.example'))
    const y = customer('エックス産業', company_('x-sangyo.example'))
    const p = ok(svc.propose(m('u-alice'), { kind: 'ai' }, { a: x, b: y, reason: '名前が似ている' })).proposal
    ok(svc.decide(m('u-bob'), p.id, 'reject'))
    expect(memberIds(x)).toEqual([x])
    expect(svc.propose(m('u-alice'), { kind: 'ai' }, { a: y, b: x, reason: 'やはり同じ' })).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'IDENTITY_REJECTED_BEFORE' } })
  })

  it('a company and a person cannot be proposed as the same', () => {
    const c = customer('株式会社エー', company_('a-corp.example'))
    const p = customer('山口さん', person('yamaguchi@other.example'))
    expect(svc.propose(m('u-alice'), { kind: 'ai' }, { a: c, b: p, reason: 'x' })).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'IDENTITY_KIND_MISMATCH' } })
  })
})

describe('split', () => {
  it('takes a record out for good; new records with the address still join the original', () => {
    const p1 = customer('代表アドレス（営業）', person('info@c-corp.example'))
    const p2 = customer('代表アドレス（経理）', person('info@c-corp.example'))
    expect(memberIds(p1)).toEqual([p1, p2].sort())
    // Split the oldest: it is the first candidate automatic matching would pick.
    const v = ok(svc.split(m('u-alice'), p1))
    expect(v.members).toMatchObject([{ recordId: p1, held: true, how: 'split' }])
    expect(v.history.map(h => h.action)).toEqual(['joined', 'split'])
    const p3 = customer('代表アドレス（総務）', person('info@c-corp.example'))
    expect(memberIds(p2)).toEqual([p2, p3].sort())
    expect(memberIds(p1)).toEqual([p1])
    // Bringing it back is a person's approval.
    const pr = ok(svc.propose(m('u-alice'), { kind: 'human' }, { a: p2, b: p1, reason: '同じ窓口だった' })).proposal
    ok(svc.decide(m('u-bob'), pr.id, 'approve'))
    expect(memberIds(p1)).toEqual([p1, p2, p3].sort())
  })

  it('a record split off is never a target of automatic matching', () => {
    const p1 = customer('共有アドレス 1', person('shared@d-corp.example'))
    const p2 = customer('共有アドレス 2', person('shared@d-corp.example'))
    ok(svc.split(m('u-alice'), p1))
    ok(svc.split(m('u-alice'), p2))
    const p3 = customer('共有アドレス 3', person('shared@d-corp.example'))
    expect(memberIds(p1)).toEqual([p1])
    expect(memberIds(p2)).toEqual([p2])
    expect(memberIds(p3)).toEqual([p3])
  })
})

describe('no leaks', () => {
  it('a record in a folder the caller cannot read is missing everywhere', () => {
    const open = customer('株式会社エー', company_('a-corp.example'))
    const secret = customer('株式会社エー（秘書室メモ）', company_('a-corp.example'), { folder: '秘書室' })
    const other = customer('株式会社ゼット', company_('z.example'))
    const p = ok(svc.propose(m('u-alice'), { kind: 'ai' }, { a: secret, b: other, reason: '同じ' })).proposal
    // Alice reads both.
    expect(memberIds(open)).toEqual([open, secret].sort())
    // Mallory: the secret is not a member, not in the history, its proposal does not exist.
    const view = identityOf(open, 'u-mallory')
    expect(view.members.map(x => x.recordId)).toEqual([open])
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(JSON.stringify(view)).not.toContain('秘書室')
    expect(ok(svc.proposals(m('u-mallory'))).proposals).toEqual([])
    expect(ok(svc.resolveAddress(m('u-mallory'), 'x@a-corp.example')).company).toEqual([open])
    const missingRecord = 'customer-99999999'
    const asMissing = (r: unknown, id: string) => JSON.parse(JSON.stringify(r).replaceAll(id, '<id>'))
    expect(asMissing(svc.ofRecord(m('u-mallory'), secret), secret)).toEqual(asMissing(svc.ofRecord(m('u-mallory'), missingRecord), missingRecord))
    expect(asMissing(svc.split(m('u-mallory'), secret), secret)).toEqual(asMissing(svc.split(m('u-mallory'), missingRecord), missingRecord))
    expect(asMissing(svc.propose(m('u-mallory'), { kind: 'ai' }, { a: secret, b: other, reason: 'x' }), secret))
      .toEqual(asMissing(svc.propose(m('u-mallory'), { kind: 'ai' }, { a: missingRecord, b: other, reason: 'x' }), missingRecord))
    for (const d of ['approve', 'reject'] as const) {
      expect(asMissing(svc.decide(m('u-mallory'), p.id, d), p.id)).toEqual(asMissing(svc.decide(m('u-mallory'), 'no-such-proposal', d), 'no-such-proposal'))
    }
    // Nothing was decided or moved by those attempts.
    expect(ok(svc.proposals(m('u-alice'))).proposals.map(x => x.status)).toEqual(['pending'])
    expect(memberIds(open)).toEqual([open, secret].sort())
  })

  it('someone’s own record is theirs alone — not the company owner’s or an admin’s', () => {
    const shared = customer('株式会社エー', company_('a-corp.example'))
    const mine = customer('エー社（自分のメモ）', company_('a-corp.example'), { owner: 'u-alice' })
    expect(memberIds(shared, 'u-alice')).toEqual([shared, mine].sort())
    for (const who of ['u-owner', 'u-admin', 'u-bob']) {
      expect(memberIds(shared, who)).toEqual([shared])
      expect(svc.ofRecord(m(who), mine)).toMatchObject({ ok: false, kind: 'not-found', body: { code: 'RECORD_NOT_FOUND' } })
    }
  })

  it('another company’s records and proposals are missing, and stay unchanged', () => {
    const theirs = customer('B 社の顧客', company_('a-corp.example'), { co: 'b' })
    const theirs2 = customer('B 社の顧客 2', company_('b2.example'), { co: 'b' })
    const p = ok(svc.propose(m('u-carol', 'b'), { kind: 'ai' }, { a: theirs, b: theirs2, reason: '同じ' })).proposal
    const ours = customer('株式会社エー', company_('a-corp.example'))
    // Same domain in another company is never matched.
    expect(memberIds(ours, 'u-owner')).toEqual([ours])
    const before = conn.prepare("SELECT * FROM identity_members WHERE company_id = 'b' ORDER BY record_id").all()
    expect(svc.ofRecord(m('u-owner'), theirs)).toMatchObject({ ok: false, kind: 'not-found' })
    expect(svc.split(m('u-owner'), theirs)).toMatchObject({ ok: false, kind: 'not-found' })
    expect(svc.decide(m('u-owner'), p.id, 'approve')).toMatchObject({ ok: false, kind: 'not-found', body: { code: 'IDENTITY_PROPOSAL_NOT_FOUND' } })
    expect(ok(svc.proposals(m('u-owner'))).proposals).toEqual([])
    expect(ok(svc.resolveAddress(m('u-owner'), 'x@b2.example')).company).toEqual([])
    expect(conn.prepare("SELECT * FROM identity_members WHERE company_id = 'b' ORDER BY record_id").all()).toEqual(before)
    expect(ok(svc.proposals(m('u-carol', 'b'))).proposals.map(x => x.status)).toEqual(['pending'])
  })
})
