/**
 * File links of a company without the shared folder (records.md "File links without the shared
 * folder", owner decisions 2026-11-07/08): a Google Drive file (fileId + revision + the sha256 of what
 * ACB read) or a file of the member's own PC, shown to that member alone. Companies with the shared
 * folder keep company paths, unchanged.
 *
 * Guards:
 * - a PC file's link never reaches anyone but its owner — not the detail (the card, the AI's
 *   `records_get`), not 経緯 or a replay, not 探す's counts, not the answer of someone else's link
 *   change or undo; nobody else can find it by removing or undoing it;
 * - a Drive link is every reader's, but its name and what ACB read only the linker's;
 * - a Drive link needs the connector's check (never a body), and only a person links either kind;
 * - decision materials / attachments: a Drive file at the revision and fingerprint kept when it was
 *   linked; never a PC file; never the old `{ path, commit }` here;
 * - a company with the shared folder refuses both kinds and links company paths as before.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type ActorInput, type RecordEngine } from '../../src/services/record-engine'
import type { VerifiedDriveFile } from '../../src/services/record-engine/types'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createRecordFind, type RecordFind } from '../../src/services/record-find'
import type { Member } from '../../src/services/access'

const TS = '2026-11-08T00:00:00.000Z'
const PEOPLE = ['u-owner', 'u-alice', 'u-bob']
/** `n`: no shared folder; `g`: the company repository, as every company had. */
const NONE = 'n'
const GIT = 'g'
const LOCAL = '営業部/転職の相談メモ.md'
const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUv'
const SHA = 'a'.repeat(64)
const DRIVE: VerifiedDriveFile = { fileId: FILE_ID, revisionId: 'rev-1', name: 'A社 提案書（秘）', mimeType: 'application/pdf', sha256: SHA }

let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let find: RecordFind
let tick = 0
const at = () => `2026-11-08T00:00:${String(tick++ % 60).padStart(2, '0')}.000Z`
const m = (userId: string, companyId = NONE): Member => ({ companyId, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const linkLocal = (who: string, id: string, path: string, expectedVersion: number, company = NONE) =>
  engine.fileLink(m(who, company), HUMAN, id, 'link', { target: { kind: 'local', path }, expectedVersion })
const linkDrive = (who: string, id: string, expectedVersion: number, checked: VerifiedDriveFile | null = DRIVE, company = NONE) =>
  engine.fileLink(m(who, company), HUMAN, id, 'link', { target: { kind: 'drive', fileId: FILE_ID }, expectedVersion }, checked ?? undefined)
const detail = async (who: string, id: string, company = NONE) => ok(await service.get(m(who, company), id))
const fileLinks = async (who: string, id: string) => (await detail(who, id)).links.filter(l => l.local || l.drive || l.path)
const historyText = (who: string, id: string) => JSON.stringify(ok(engine.history(m(who), id)).entries)
const versionOf = (id: string, company = NONE) => source.forCompany(company).records.ledger(id).at(-1)!.version

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  source.forCompany(id).records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(source.forCompany(id).records, TS)
}

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: at, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null),
    notify: () => {},
    hasCompanyFolder: c => c === GIT,
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  find = createRecordFind({ companyData: source })
  company(NONE)
  company(GIT)
})

/** A task alice asked of bob (both read it, and so does the company owner). */
const task = (company = NONE) => ok(engine.create(m('u-alice', company), HUMAN, { type: 'task', title: '提案書を作る', fields: { assignee: 'u-bob' } })).record

describe('a file of the member’s PC is theirs alone', () => {
  it('the owner sees it on the card; nobody else gets the row, the path, 経緯 or a replay of it', async () => {
    const t = task()
    const linked = ok(linkLocal('u-alice', t.id, LOCAL, 1))
    expect(linked.changed).toBe(true)
    // Stored with its owner in the target: never an absolute path.
    expect(source.forCompany(NONE).records.linksFrom([t.id]).map(l => l.targetPath)).toEqual([`local:u-alice:${LOCAL}`])
    expect((await fileLinks('u-alice', t.id)).map(l => l.local)).toEqual([{ path: LOCAL }])
    expect(historyText('u-alice', t.id)).toContain('転職の相談メモ')

    for (const who of ['u-bob', 'u-owner']) {
      expect(await fileLinks(who, t.id)).toEqual([])
      expect(JSON.stringify(await detail(who, t.id))).not.toContain('転職')
      expect(historyText(who, t.id)).not.toContain('転職')
      // The entry that only linked alice's file says nothing to others: not there at all.
      expect(ok(engine.history(m(who), t.id)).entries.map(e => e.action)).toEqual(['create'])
      expect(JSON.stringify(ok(engine.atVersion(m(who), t.id, '2')))).not.toContain('転職')
    }
  })

  it('two members’ files of the same name stay two links, each seen by its owner only', async () => {
    const t = task()
    ok(linkLocal('u-alice', t.id, LOCAL, 1))
    ok(linkLocal('u-bob', t.id, LOCAL, 2))
    expect(await fileLinks('u-alice', t.id)).toHaveLength(1)
    expect(await fileLinks('u-bob', t.id)).toHaveLength(1)
    // Bob's 経緯 holds his own entry, not alice's link (the create is alice's).
    expect(ok(engine.history(m('u-bob'), t.id)).entries.map(e => e.action)).toEqual(['create', 'link_file'])
    expect(ok(engine.history(m('u-bob'), t.id)).entries.map(e => e.version)).toEqual([1, 3])
  })

  it('nobody else finds it by removing or undoing it, and someone else’s change answers no trace of it', async () => {
    const t = task()
    ok(linkLocal('u-alice', t.id, LOCAL, 1))
    expect(engine.fileLink(m('u-bob'), HUMAN, t.id, 'unlink', { target: { kind: 'local', path: LOCAL }, expectedVersion: 2 }))
      .toMatchObject({ ok: false, body: { code: 'LINK_NOT_FOUND' } })
    // The company owner may undo anyone's entry — but not one that only touched alice's PC file.
    expect(engine.undo(m('u-owner'), HUMAN, t.id, { version: 2, expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'ENTRY_NOT_FOUND' } })
    expect(await fileLinks('u-alice', t.id)).toHaveLength(1)

    // Bob links a Drive file: the answer's entry lists the link's targets without alice's.
    const bobs = ok(linkDrive('u-bob', t.id, 2))
    expect(JSON.stringify(bobs)).not.toContain('転職')
    expect(JSON.stringify(bobs.entry)).toContain(FILE_ID)
    // …and his undo of it answers no trace either, and leaves alice's file linked.
    const undone = ok(engine.undo(m('u-bob'), HUMAN, t.id, { version: 3, expectedVersion: 3 }))
    expect(JSON.stringify(undone)).not.toContain('転職')
    expect(await fileLinks('u-alice', t.id)).toEqual([{ name: 'files', direction: 'out', local: { path: LOCAL } }])
    // Alice still takes her own off.
    ok(engine.fileLink(m('u-alice'), HUMAN, t.id, 'unlink', { target: { kind: 'local', path: LOCAL }, expectedVersion: 4 }))
    expect(await fileLinks('u-alice', t.id)).toEqual([])
  })

  it('探す counts it for its owner only', () => {
    const p = ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: 'サンプル社 研修導入', folder: '営業部', fields: { owner: 'u-alice' } })).record
    ok(linkLocal('u-alice', p.id, LOCAL, p.version))
    ok(linkDrive('u-alice', p.id, versionOf(p.id)))
    const files = (who: string) => ok(find.find(m(who), { text: 'サンプル', today: '2026-11-08' })).hubs[0].counts.files
    expect(files('u-alice')).toBe(2)
    expect(files('u-bob')).toBe(1)
    expect(files('u-owner')).toBe(1)
  })

  it('only a path inside the working folder, and only the member — never their AI', () => {
    const t = task()
    for (const path of ['/Users/alice/秘密.md', '../外.md', '', 'a/../../b']) {
      expect(linkLocal('u-alice', t.id, path, 1)).toMatchObject({ ok: false, body: { code: 'BAD_TARGET' } })
    }
    expect(engine.fileLink(m('u-alice'), AI, t.id, 'link', { target: { kind: 'local', path: LOCAL }, expectedVersion: 1 }))
      .toMatchObject({ ok: false, body: { code: 'TYPED_LINK_PERSON_ONLY' } })
    expect(source.forCompany(NONE).records.linksFrom([t.id])).toEqual([])
  })
})

describe('a Google Drive file', () => {
  it('every reader gets the row; only the linker gets its name and what ACB read', async () => {
    const t = task()
    ok(linkDrive('u-alice', t.id, 1))
    expect((await fileLinks('u-alice', t.id))[0].drive).toEqual({
      fileId: FILE_ID, mine: true, name: DRIVE.name, revisionId: 'rev-1', sha256: SHA, mimeType: 'application/pdf', linkedAt: expect.any(String),
    })
    for (const who of ['u-bob', 'u-owner']) {
      expect((await fileLinks(who, t.id)).map(l => l.drive)).toEqual([{ fileId: FILE_ID, mine: false }])
      expect(JSON.stringify(await detail(who, t.id))).not.toContain('提案書（秘）')
      expect(historyText(who, t.id)).not.toContain('提案書（秘）')
    }
  })

  it('the connector is asked only after every record check (missing, unreadable, stale, already linked answer first)', () => {
    const t = task()
    const before = (who: string, id: string, expectedVersion: number) =>
      engine.fileLinkBeforeDrive(m(who), HUMAN, id, { target: { kind: 'drive', fileId: FILE_ID }, expectedVersion })
    expect(before('u-alice', t.id, 1)).toEqual({ ok: true, value: 'ask-drive' })
    const own = ok(engine.create(m('u-bob'), HUMAN, { type: 'task', title: 'ボブのメモ', personal: true, fields: { assignee: 'u-bob' } })).record
    expect(before('u-alice', own.id, 1)).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
    expect(before('u-alice', 'task-000000000000', 1)).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
    expect(before('u-alice', t.id, 7)).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT' } })
    ok(linkDrive('u-alice', t.id, 1))
    expect(before('u-alice', t.id, 2)).toMatchObject({ ok: true, value: { changed: false } })
    // Nothing was written by asking.
    expect(versionOf(t.id)).toBe(2)
  })

  it('is linked only after the connector checked it, and only by a person', () => {
    const t = task()
    // Without the route's check (the AI route never makes one; a body cannot claim it).
    expect(linkDrive('u-alice', t.id, 1, null)).toMatchObject({ ok: false, body: { code: 'DRIVE_NOT_PICKED' } })
    expect(linkDrive('u-alice', t.id, 1, { ...DRIVE, fileId: 'ZZZZZZZZZZZZZZZZZZZZ' })).toMatchObject({ ok: false, body: { code: 'DRIVE_NOT_PICKED' } })
    expect(engine.fileLink(m('u-alice'), AI, t.id, 'link', { target: { kind: 'drive', fileId: FILE_ID }, expectedVersion: 1 }, DRIVE))
      .toMatchObject({ ok: false, body: { code: 'TYPED_LINK_PERSON_ONLY' } })
    expect(source.forCompany(NONE).records.linksFrom([t.id])).toEqual([])
  })

  it('a decision rests on it at the revision and fingerprint kept; never on a PC file or a company path here', () => {
    const t = task()
    ok(linkDrive('u-alice', t.id, 1))
    ok(linkLocal('u-alice', t.id, LOCAL, 2))
    const cancel = (materials: unknown[]) => engine.act(m('u-alice'), HUMAN, t.id, 'cancel', { expectedVersion: 3, note: 'やめます', decision: { materials } })
    return (async () => {
      expect(await cancel([{ kind: 'local', path: LOCAL }])).toMatchObject({ ok: false, body: { code: 'LOCAL_FILE_NOT_SHARED' } })
      expect(await cancel([{ kind: 'file', path: '営業部/見積.md', commit: 'a'.repeat(40) }])).toMatchObject({ ok: false, body: { code: 'NO_COMPANY_FOLDER' } })
      expect(await cancel([{ kind: 'drive', fileId: 'ZZZZZZZZZZZZZZZZZZZZ' }])).toMatchObject({ ok: false, body: { code: 'BAD_MATERIAL' } })
      // The body's revision is never taken: the link's is.
      const done = ok(await cancel([{ kind: 'drive', fileId: FILE_ID, revisionId: 'forged', sha256: 'b'.repeat(64) }]))
      expect(done.entry.decision?.materials).toEqual([{ kind: 'drive', fileId: FILE_ID, revisionId: 'rev-1', sha256: SHA }])
    })()
  })

  it('a Drive file ACB could not read cannot be material', async () => {
    const t = task()
    ok(linkDrive('u-alice', t.id, 1, { ...DRIVE, sha256: null }))
    expect(await engine.act(m('u-alice'), HUMAN, t.id, 'cancel', { expectedVersion: 2, note: 'やめます', decision: { materials: [{ kind: 'drive', fileId: FILE_ID }] } }))
      .toMatchObject({ ok: false, body: { code: 'DRIVE_VERSION_NOT_FIXED' } })
  })

  it('an attached version is the Drive file as linked; never a PC file', async () => {
    const t = task()
    ok(linkDrive('u-bob', t.id, 1))
    ok(linkLocal('u-bob', t.id, LOCAL, 2))
    const review = (attachments: unknown[]) => engine.act(m('u-bob'), HUMAN, t.id, 'request_review', { expectedVersion: 3, args: { reviewer: 'u-alice' }, attachments })
    expect(await review([{ link: 'files', target: { kind: 'local', path: LOCAL } }])).toMatchObject({ ok: false, body: { code: 'LOCAL_FILE_NOT_SHARED' } })
    expect(await review([{ link: 'files', path: '営業部/見積.md', commit: 'a'.repeat(40) }])).toMatchObject({ ok: false, body: { code: 'NO_COMPANY_FOLDER' } })
    const done = ok(await review([{ link: 'files', target: { kind: 'drive', fileId: FILE_ID } }]))
    expect(done.entry.attachments).toEqual([{ link: 'files', kind: 'drive', fileId: FILE_ID, revisionId: 'rev-1', sha256: SHA }])
  })
})

describe('a company with the shared folder is unchanged', () => {
  it('refuses both kinds and links company paths as before; a company without it refuses company paths', async () => {
    const t = task(GIT)
    expect(linkLocal('u-alice', t.id, LOCAL, 1, GIT)).toMatchObject({ ok: false, body: { code: 'FILE_LINK_KIND_NOT_HERE' } })
    expect(linkDrive('u-alice', t.id, 1, DRIVE, GIT)).toMatchObject({ ok: false, body: { code: 'FILE_LINK_KIND_NOT_HERE' } })
    ok(engine.fileLink(m('u-alice', GIT), HUMAN, t.id, 'link', { path: '営業部/見積.md', expectedVersion: 1 }))
    expect((await detail('u-bob', t.id, GIT)).links.map(l => l.path)).toEqual(['営業部/見積.md'])
    const t2 = task(GIT)
    expect(await engine.act(m('u-alice', GIT), HUMAN, t2.id, 'cancel', { expectedVersion: 1, note: 'x', decision: { materials: [{ kind: 'drive', fileId: FILE_ID }] } }))
      .toMatchObject({ ok: false, body: { code: 'FILE_LINK_KIND_NOT_HERE' } })

    const n = task()
    expect(engine.fileLink(m('u-alice'), HUMAN, n.id, 'link', { path: '営業部/見積.md', expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NO_COMPANY_FOLDER' } })
  })
})
