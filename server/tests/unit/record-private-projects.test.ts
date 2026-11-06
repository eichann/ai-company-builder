/**
 * 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト", owner decision 2026-11-06): a まとまり whose
 * 見える範囲 is its own private folder, with today's private-folder rights — no new permission.
 *
 * Guards (each mutation-checked):
 * - only who may create a private folder there places a まとまり in it: owners / admins, the
 *   department's managers (a participant, another department's manager, the AI, a task, a folder
 *   deeper inside: all the one answer FOLDER_NOT_PLACEABLE);
 * - someone who does not take part sees nothing — not the まとまり, its tasks, its title in 探す or
 *   query, nor its folder in 見られる人;
 * - a participant added (a rule on the folder, what PUT …/members writes) sees the まとまり and its
 *   linked tasks; one taken off sees them no more;
 * - the card: 「『<title>』の参加者（N人）」 and its private folder (to its readers only).
 * Who may edit the participants is the existing route's (permission matrix row
 * `PUT …/private-folders/:scopeId/members`); its removal mechanics are private-folders-client.md's.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type ActorInput, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createViewersService } from '../../src/services/viewers'
import type { Member } from '../../src/services/access'

const TS = '2026-11-06T00:00:00.000Z'
const CO = 'a'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService

// 営業部's manager u-mgr made 営業部/新製品 private; u-alice takes part; u-carol does not; u-dev manages 開発部.
const PEOPLE = ['u-owner', 'u-admin', 'u-mgr', 'u-alice', 'u-carol', 'u-dev']
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const MANAGES: Record<string, string[]> = { 'u-mgr': ['営業部'], 'u-dev': ['開発部'] }
const m = (userId: string): Member => ({ companyId: CO, userId, role: ROLES[userId] ?? 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'c' }
const PRIVATE = '営業部/新製品'

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: unknown }) => (r.ok ? 'ok' : (r.body as { code?: string }).code)
function rule(id: string, scope: string, type: 'everyone' | 'user', subject: string | null, read: 0 | 1) {
  conn.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, type, subject, read, read, TS)
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let tick = 0
  const clock = { now: () => `2026-11-06T02:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source, transactions: sqliteTransactions(conn), clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: (_c, userId) => MANAGES[userId] ?? [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (PEOPLE.includes(userId) ? ROLES[userId] ?? 'member' : null),
    notify: () => {},
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', TS, TS)
  for (const u of PEOPLE) conn.prepare('INSERT INTO memberships (user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(u, CO, ROLES[u] ?? 'member', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', ?, '', 'company', ?)").run(CO, TS)
  rule('root-r', 'root', 'everyone', null, 1)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('p', ?, ?, 'folder', 'a-repo', ?)").run(CO, PRIVATE, TS)
  rule('p-e', 'p', 'everyone', null, 0)
  rule('p-m', 'p', 'user', 'u-mgr', 1)
  rule('p-a', 'p', 'user', 'u-alice', 1)
  const records = source.forCompany(CO).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
})

const project = (who: string, folder = PRIVATE, actor = HUMAN, type = 'project') =>
  engine.create(m(who), actor, { type, title: '新製品の立ち上げ', fields: type === 'project' ? { owner: who } : { assignee: who }, folder })
const reads = async (who: string, id: string) => (await service.get(m(who), id)).ok

describe('who may make a 非公開 案件・プロジェクト', () => {
  it('owners / admins and the department’s manager, in exactly its private folder', () => {
    for (const who of ['u-owner', 'u-admin', 'u-mgr']) expect(code(project(who))).toBe('ok')
  })

  it('anyone else gets the one answer of any private folder — a participant, another department’s manager, the AI', () => {
    const answers = [project('u-alice'), project('u-dev'), project('u-mgr', PRIVATE, AI), project('u-carol')]
    for (const a of answers) expect(code(a)).toBe('FOLDER_NOT_PLACEABLE')
    expect(new Set(answers.map(a => JSON.stringify(a))).size).toBe(1)
  })

  it('only a まとまり, only the folder itself', () => {
    expect(code(project('u-mgr', PRIVATE, HUMAN, 'task'))).toBe('FOLDER_NOT_PLACEABLE')
    expect(code(project('u-mgr', `${PRIVATE}/中`))).toBe('FOLDER_NOT_PLACEABLE')
  })
})

describe('participants see it; nobody else sees anything', () => {
  it('a non-participant: not the まとまり, its task, its title in query or 見られる人', async () => {
    const p = ok(project('u-mgr')).record
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '試作の手配', fields: { assignee: 'u-alice' }, links: { bundle: p.id } })).record
    expect(await reads('u-alice', p.id)).toBe(true)
    expect(await reads('u-alice', t.id)).toBe(true)
    expect(await reads('u-carol', p.id)).toBe(false)
    expect(await reads('u-carol', t.id)).toBe(false)
    const q = ok(await service.query(m('u-carol'), { text: '新製品' }))
    expect(q.total).toBe(0)
    const viewers = createViewersService({ companyData: source, memberships: { listByCompany: () => PEOPLE.map(u => ({ user_id: u, role: ROLES[u] ?? 'member' })) } as never, accounts: { byIds: (ids: string[]) => new Map(ids.map(id => [id, { name: id.slice(2), email: `${id}@x` }])) } as never })
    const seen = ok(viewers.labels(m('u-carol'), { records: [p.id, t.id] }))
    expect(seen.records).toEqual({})
    expect(JSON.stringify(seen)).not.toMatch(/新製品/)
  })

  it('a participant added sees the まとまり and its tasks; taken off, no more', async () => {
    const p = ok(project('u-mgr')).record
    const t = ok(engine.create(m('u-mgr'), HUMAN, { type: 'task', title: '原価を出す', fields: { assignee: 'u-mgr' }, links: { bundle: p.id } })).record
    expect(await reads('u-carol', p.id)).toBe(false)
    rule('p-c', 'p', 'user', 'u-carol', 1)
    expect(await reads('u-carol', p.id)).toBe(true)
    expect(await reads('u-carol', t.id)).toBe(true)
    conn.prepare("DELETE FROM scope_rules WHERE id = 'p-c'").run()
    expect(await reads('u-carol', p.id)).toBe(false)
    expect(await reads('u-carol', t.id)).toBe(false)
  })
})

describe('the card', () => {
  it('「『<title>』の参加者（N人）」 and its private folder, to its readers', async () => {
    const p = ok(project('u-mgr')).record
    const viewers = createViewersService({ companyData: source, memberships: { listByCompany: () => PEOPLE.map(u => ({ user_id: u, role: ROLES[u] ?? 'member' })) } as never, accounts: { byIds: (ids: string[]) => new Map(ids.map(id => [id, { name: id.slice(2), email: `${id}@x` }])) } as never })
    // u-mgr, u-alice, the owner and the admin.
    expect(ok(viewers.labels(m('u-alice'), { records: [p.id] })).records[p.id]?.text).toBe('『新製品の立ち上げ』の参加者（4人）')
    const detail = ok(await service.get(m('u-alice'), p.id))
    expect(detail.privateFolder).toEqual({ scopeId: 'p', path: PRIVATE })
    // A まとまり in a department: no private folder.
    const open = ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '公開の', fields: { owner: 'u-alice' }, folder: '営業部' })).record
    expect(ok(await service.get(m('u-alice'), open.id)).privateFolder).toBeUndefined()
  })
})
