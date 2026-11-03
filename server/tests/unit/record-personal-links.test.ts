/**
 * A link into a `.personal/` folder is its maker's alone (records.md "Links into .personal/",
 * owner decision 2026-11-03): the file is on one member's Mac and its name can itself be private.
 *
 * Guards:
 * - another member who reads the record never gets the path: not in the detail (what the app's
 *   card and the AI's `records_get` read), not in `linkedToFile`, not in 経緯 or a replay, not
 *   counted by 探す; the maker gets all of it as before;
 * - another member cannot discover it by unlinking (404 as for a link that is not there) nor by
 *   linking the same path (a link of their own is made);
 * - the maker survives other changes of the record's links, and an undo of the maker's unlink;
 * - a link from before the maker was kept: only an owner-only record's owner sees it.
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
import { createRecordFind, type RecordFind } from '../../src/services/record-find'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
const PEOPLE = ['u-owner', 'u-alice', 'u-bob']
const PERSONAL = '営業部/.personal/inbox/日付別/2026/20261103/転職の相談メモ.md'
const SHARED = '営業部/見積.md'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let find: RecordFind
let tick = 0
const at = () => `2026-11-03T00:00:${String(tick++ % 60).padStart(2, '0')}.000Z`
const m = (userId: string): Member => ({ companyId: 'a', userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const link = (who: string, id: string, path: string, expectedVersion: number, actor = HUMAN) => engine.fileLink(m(who), actor, id, 'link', { path, expectedVersion })
const unlink = (who: string, id: string, path: string, expectedVersion: number) => engine.fileLink(m(who), HUMAN, id, 'unlink', { path, expectedVersion })
const filesOf = async (who: string, id: string) => ok(await service.get(m(who), id)).links.flatMap(l => (l.path !== undefined ? [l.path] : []))
const linkedTo = (who: string, path: string) => ok(service.query(m(who), { linkedToFile: path })).records.map(r => r.id)
const historyText = (who: string, id: string) => JSON.stringify(ok(engine.history(m(who), id)).entries)
const versionOf = (id: string) => source.forCompany('a').records.ledger(id).at(-1)!.version

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
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  find = createRecordFind({ companyData: source })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-root-r', 'a-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  source.forCompany('a').records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(source.forCompany('a').records, TS)
})

/** A task alice asked of bob (both read it), with a shared file linked. */
const sharedTask = () => ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '提案書を作る', fields: { assignee: 'u-bob' }, links: { files: [SHARED] } })).record

describe('a link into .personal/ is its maker’s alone', () => {
  it('another member never gets the path: detail, linkedToFile, 経緯, replay; the maker gets all of it', async () => {
    const t = sharedTask()
    // Bob's AI in his consultation links the file it made in his 今日のフォルダ: the link is bob's.
    ok(link('u-bob', t.id, PERSONAL, 1, AI))

    expect(await filesOf('u-bob', t.id)).toEqual([SHARED, PERSONAL])
    expect(linkedTo('u-bob', PERSONAL)).toEqual([t.id])
    expect(historyText('u-bob', t.id)).toContain('転職の相談メモ')
    expect(JSON.stringify(ok(engine.atVersion(m('u-bob'), t.id, '2')))).toContain('転職の相談メモ')

    for (const who of ['u-alice', 'u-owner']) {
      expect(await filesOf(who, t.id)).toEqual([SHARED])
      expect(linkedTo(who, PERSONAL)).toEqual([])
      const history = historyText(who, t.id)
      expect(history).not.toContain('.personal')
      // The entry that only linked bob's file says nothing to others, so it is not there at all.
      expect(ok(engine.history(m(who), t.id)).entries.map(e => e.action)).toEqual(['create'])
      expect(JSON.stringify(ok(engine.atVersion(m(who), t.id, '2')))).not.toContain('.personal')
    }
  })

  it('another member cannot find it by unlinking, and linking the same path makes their own link', async () => {
    const t = sharedTask()
    ok(link('u-bob', t.id, PERSONAL, 1))
    expect(unlink('u-alice', t.id, PERSONAL, 2)).toMatchObject({ ok: false, body: { code: 'LINK_NOT_FOUND' } })
    // Alice's own 今日のフォルダ can hold a file of the same name: hers is a link of her own.
    expect(ok(link('u-alice', t.id, PERSONAL, 2))).toMatchObject({ changed: true })
    expect(await filesOf('u-alice', t.id)).toEqual([SHARED, PERSONAL])
    ok(unlink('u-alice', t.id, PERSONAL, 3))
    // Bob's link is untouched by hers coming and going.
    expect(await filesOf('u-bob', t.id)).toEqual([SHARED, PERSONAL])
    expect(await filesOf('u-alice', t.id)).toEqual([SHARED])
  })

  it('the maker keeps it through others’ link changes and an undo of their own unlink', async () => {
    const t = sharedTask()
    ok(link('u-bob', t.id, PERSONAL, 1))
    // Alice links and unlinks another file: every link row is rewritten.
    ok(link('u-alice', t.id, '営業部/メモ.md', 2))
    // Alice's undo rewrites the link's targets from the ledger (which holds bob's path too): still bob's.
    ok(engine.undo(m('u-alice'), HUMAN, t.id, { version: 3, expectedVersion: 3 }))
    expect(await filesOf('u-alice', t.id)).toEqual([SHARED])
    ok(link('u-alice', t.id, '営業部/計画.md', 4))
    ok(unlink('u-alice', t.id, SHARED, 5))
    expect((await filesOf('u-bob', t.id)).sort()).toEqual(['営業部/計画.md', PERSONAL].sort())
    expect(await filesOf('u-alice', t.id)).toEqual(['営業部/計画.md'])
    // Bob takes it off and undoes that: it is his again, still hidden from alice.
    const off = ok(unlink('u-bob', t.id, PERSONAL, versionOf(t.id)))
    ok(engine.undo(m('u-bob'), HUMAN, t.id, { version: off.entry!.version, expectedVersion: off.entry!.version }))
    expect(await filesOf('u-bob', t.id)).toContain(PERSONAL)
    expect(await filesOf('u-alice', t.id)).not.toContain(PERSONAL)
  })

  it('a link made with the record is its maker’s', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '下書き', fields: { assignee: 'u-bob' }, links: { files: [PERSONAL] } })).record
    expect(await filesOf('u-alice', t.id)).toEqual([PERSONAL])
    expect(await filesOf('u-bob', t.id)).toEqual([])
    expect(historyText('u-bob', t.id)).not.toContain('.personal')
  })

  it('探す never counts another member’s .personal link', () => {
    const p = ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: 'サンプル社 研修導入', folder: '営業部', fields: { owner: 'u-alice' }, links: { files: [SHARED] } })).record
    ok(link('u-alice', p.id, PERSONAL, p.version))
    const files = (who: string) => ok(find.find(m(who), { text: 'サンプル', today: '2026-11-03' })).hubs[0].counts.files
    expect(files('u-alice')).toBe(2)
    expect(files('u-bob')).toBe(1)
  })

  it('a link from before the maker was kept: only an owner-only record’s owner sees it', async () => {
    const mine = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分のメモ', personal: true, fields: { assignee: 'u-alice' } })).record
    const shared = sharedTask()
    for (const id of [mine.id, shared.id]) {
      conn.prepare("INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES ('a', ?, 'files', 9, NULL, ?)").run(id, PERSONAL)
    }
    expect(await filesOf('u-alice', mine.id)).toEqual([PERSONAL])
    expect(await filesOf('u-alice', shared.id)).toEqual([SHARED])
    expect(await filesOf('u-bob', shared.id)).toEqual([SHARED])
  })
})
