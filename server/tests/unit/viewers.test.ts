/**
 * 見られる人 (services/viewers.ts, shared/core/viewers.ts) on the real schema.
 *
 * What it protects:
 * - a private folder's name reaches only someone who can read it (owner decision B): a record in
 *   it is left out for anyone else, and a file path inside it is answered exactly like a path that
 *   does not exist (asking cannot tell it is private, nor name it);
 * - an owner-only record is 「あなただけ」 for its owner and absent for everyone else, owners and
 *   admins included;
 * - the phrase follows who really reads it (readers counted with owners and admins);
 * - a whole list is answered at once, within the limits;
 * - `cannotOpen` counts who reads a record but not a linked path, a number only, never for a
 *   record or a path the caller cannot read.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { createViewersService, type ViewersService } from '../../src/services/viewers'
import type { Member } from '../../src/services/access'
import { viewersLabel } from '../../../shared/core/viewers'

const CO = 'co'
const TS = '2026-11-02T00:00:00.000Z'
const NAMES: Record<string, string> = { owner: '阿部', abe: '安部', sato: '佐藤', tanaka: '田中', suzuki: '鈴木' }
const ROLES: Record<string, string> = { owner: 'owner', abe: 'member', sato: 'member', tanaka: 'member', suzuki: 'member' }
const m = (userId: string): Member => ({ companyId: CO, userId, role: ROLES[userId] })

let conn: Database.Database
let viewers: ViewersService

function privateFolder(id: string, path: string, readers: string[]) {
  conn.prepare('INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES (?, ?, ?, ?)').run(`r-${id}`, CO, id, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, ?, 'folder', ?, ?)").run(id, CO, path, `r-${id}`, TS)
  conn.prepare("INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'everyone', NULL, 0, 0, ?)").run(CO, `${id}-all`, id, TS)
  for (const u of readers) {
    conn.prepare("INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'user', ?, 1, 1, ?)").run(CO, `${id}-${u}`, id, u, TS)
  }
}

function record(id: string, place: { scopeId?: string; path?: string; folder?: string; personalOwner?: string }) {
  conn.prepare('INSERT INTO records (company_id, id, type, scope_id, path, folder, personal_owner, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(CO, id, 'task', place.scopeId ?? null, place.path ?? null, place.folder ?? null, place.personalOwner ?? null, id, TS, TS)
}

function ask(userId: string, body: unknown) {
  const r = viewers.labels(m(userId), body)
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'owner', TS, TS)
  for (const [u, role] of Object.entries(ROLES)) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, role, TS, TS)
  }
  for (const [id, folder, order] of [['d-sales', '営業部', 0], ['d-hr', '人事', 1]] as const) {
    conn.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, CO, folder, folder, order, TS, TS)
  }
  initDatabase(conn) // company + department scopes, everyone read + write
  privateFolder('s-customer', '営業部/顧客A', ['abe', 'sato'])
  privateFolder('s-interview', '人事/面談', ['abe'])
  viewers = createViewersService({
    companyData: sqliteCompanyData(conn),
    memberships: sqliteMembershipRepository(conn),
    accounts: { byIds: ids => new Map(ids.map(id => [id, { name: NAMES[id] ?? null, email: `${id}@example.com` }])) } as never,
  })
})

describe('見られる人', () => {
  it('a private folder is named only to its readers; for anyone else its record is absent and its paths look like nothing', () => {
    record('task-customer', { scopeId: 's-customer', path: '営業部/顧客A/見積.md' })
    record('task-shared', { path: '営業部/提案.md' })
    const asked = { records: ['task-customer', 'task-shared'], files: ['営業部/顧客A/見積.md', '営業部/まだない/x.md'] }

    const reader = ask('abe', asked)
    // Readers: abe, sato, and the owner (owners and admins read every private folder).
    expect(reader.records['task-customer']).toEqual({ kind: 'private-folder', text: '『営業部/顧客A』を見られる人（3人）', count: 3 })
    expect(reader.files['営業部/顧客A/見積.md']).toEqual(reader.records['task-customer'])

    const outsider = ask('tanaka', asked)
    expect(Object.keys(outsider.records)).toEqual(['task-shared'])
    // The path inside the folder answers exactly what a path that does not exist answers.
    expect(outsider.files['営業部/顧客A/見積.md']).toEqual(outsider.files['営業部/まだない/x.md'])
    expect(outsider.files['営業部/まだない/x.md']).toEqual({ kind: 'company', text: '会社のみんな', count: 5 })
    for (const label of [...Object.values(outsider.records), ...Object.values(outsider.files)]) expect(label.text).not.toContain('顧客A')
  })

  it('an owner-only record is 「あなただけ」 for its owner and absent for everyone else, the owner of the company included', () => {
    record('task-mine', { personalOwner: 'abe' })
    expect(ask('abe', { records: ['task-mine'] }).records['task-mine']).toEqual({ kind: 'only-you', text: 'あなただけ', count: 1 })
    expect(ask('owner', { records: ['task-mine'] }).records).toEqual({})
    expect(ask('sato', { records: ['task-mine'] }).records).toEqual({})
  })

  it('two readers: 「あなたと〇〇さん」 (the other one by name); everyone: 「会社のみんな」', () => {
    record('task-interview', { scopeId: 's-interview', path: '人事/面談/メモ.md' })
    record('task-server', { folder: '' })
    expect(ask('abe', { records: ['task-interview'] }).records['task-interview']).toMatchObject({ kind: 'you-and-one', text: 'あなたと阿部さん' })
    expect(ask('owner', { records: ['task-interview'] }).records['task-interview']).toMatchObject({ text: 'あなたと安部さん' })
    expect(ask('suzuki', { records: ['task-server'], files: ['人事/規程.md'] })).toEqual({
      records: { 'task-server': { kind: 'company', text: '会社のみんな', count: 5 } },
      files: { '人事/規程.md': { kind: 'company', text: '会社のみんな', count: 5 } },
    })
  })

  it('answers a whole list at once, within the limits; bad bodies are refused', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `task-${String(i).padStart(3, '0')}`)
    for (const id of ids) record(id, { path: `営業部/${id}.md` })
    expect(Object.keys(ask('sato', { records: ids, files: ids.map(id => `営業部/${id}.md`) }).records)).toHaveLength(200)
    expect(viewers.labels(m('sato'), { records: [...ids, 'task-x'] })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(viewers.labels(m('sato'), { records: 'task-1' })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(viewers.labels(m('sato'), null)).toMatchObject({ ok: false, kind: 'bad-request' })
  })
})

describe('「〇人はこのファイルを開けません」 (linked → cannotOpen)', () => {
  /** 人事 readable only by abe (and owners / admins): a department rule, not a private folder. */
  function restrictHr() {
    const scope = conn.prepare("SELECT id FROM scopes WHERE company_id = ? AND path = '人事'").get(CO) as { id: string } | undefined
    let id = scope?.id
    if (!id) {
      id = 's-hr'
      conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, '人事', 'folder', NULL, ?)").run(id, CO, TS)
    }
    conn.prepare('DELETE FROM scope_rules WHERE scope_id = ?').run(id)
    conn.prepare("INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'hr-all', ?, 'everyone', NULL, 0, 0, ?)").run(CO, id, TS)
    conn.prepare("INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'hr-abe', ?, 'user', 'abe', 1, 1, ?)").run(CO, id, TS)
  }

  it('counts who reads the record but cannot open the path, as a number only', () => {
    restrictHr()
    record('task-company', { folder: '' })
    const answer = ask('abe', { linked: { record: 'task-company', paths: ['人事/規程.md', '営業部/提案.md'] } })
    // sato, tanaka and suzuki read the company's record but not 人事; abe and the owner do.
    expect(answer.cannotOpen).toEqual({ '人事/規程.md': 3 })
    expect(JSON.stringify(answer)).not.toMatch(/佐藤|田中|鈴木|sato|tanaka|suzuki/)
  })

  it('leaves out a path the caller cannot open, and a record the caller cannot read', () => {
    restrictHr()
    record('task-company', { folder: '' })
    record('task-mine', { personalOwner: 'abe' })
    // tanaka reads neither 人事 nor 顧客A: nothing about them comes back (顧客A answers like any 営業部 path).
    expect(ask('tanaka', { linked: { record: 'task-company', paths: ['人事/規程.md', '営業部/顧客A/見積.md'] } }).cannotOpen).toEqual({})
    expect(ask('sato', { linked: { record: 'task-mine', paths: ['営業部/提案.md'] } }).cannotOpen).toBeUndefined()
  })

  it('an owner-only record counts nobody (only its owner sees it)', () => {
    restrictHr()
    record('task-mine2', { personalOwner: 'abe' })
    expect(ask('abe', { linked: { record: 'task-mine2', paths: ['人事/規程.md'] } }).cannotOpen).toEqual({})
  })

  it('refuses a malformed linked', () => {
    expect(viewers.labels(m('sato'), { linked: { record: 'task-1', paths: 'x' } })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(viewers.labels(m('sato'), { linked: { paths: [] } })).toMatchObject({ ok: false, kind: 'bad-request' })
  })
})

describe('the phrase (shared/core/viewers.ts)', () => {
  const base = { viewerId: 'sato', ownerOnly: false, companyMembers: 6, privateFolder: null, fullAccess: new Set(['owner']), nameOf: (id: string) => NAMES[id] ?? id }

  it('「〇〇部のみんな」 only when the readers are exactly the people who belong there (owners and admins aside)', () => {
    const department = { name: '営業部', memberIds: ['sato', 'tanaka', 'owner'] }
    expect(viewersLabel({ ...base, readers: ['owner', 'sato', 'tanaka'], department })).toEqual({ kind: 'department', text: '営業部のみんな', count: 3 })
    expect(viewersLabel({ ...base, readers: ['owner', 'sato', 'tanaka', 'suzuki'], department })).toEqual({ kind: 'people', text: '4人が見られます', count: 4 })
  })
})
