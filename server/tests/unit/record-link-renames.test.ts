/**
 * Links to files follow renames and moves (owner decision 10/29;
 * services/record-index.ts followRename, records.md "Links to files"), on
 * the real schema behind real company handles.
 *
 * Guards:
 * - a link to a file follows it when a push renames or moves it;
 * - a record outside a private folder never gets a path inside one by
 *   following (a rename inside the private folder, or a move into it), while
 *   a record inside that folder follows its own folder's renames;
 * - a department renamed by the server takes its server records' folder and
 *   the links to files under it along;
 * - one company's renames never touch another company's links.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { RecordFileRename } from '../../src/ports/record-files'
import { applyRecordChanges } from '../../src/services/record-index'

const TS = '2026-11-01T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource

const DEAL_TYPE = `---
label: 商談
version: 1
storage: server
links:
  files: { label: 資料, target: file, cardinality: many }
states: [open]
---
`
const MEMO_TYPE = `---
label: メモ
version: 1
storage: file
links:
  files: { label: 資料, target: file, cardinality: many }
states: [open]
---
`

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 営業部/評価: a private folder (its own repository).
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, '営業部/評価', 'folder', ?, ?)").run(`${id}-priv`, id, `${id}-repo`, TS)
  source.forCompany(id).records.setEnabled(true, 'u-owner', TS)
  push(id, { changes: { '.acb/types/deal.md': DEAL_TYPE, '.acb/types/memo.md': MEMO_TYPE } })
}

/** A push to company `co`'s repository, or (scope) to its private folder's. */
function push(co: string, opts: { changes?: Record<string, string | null>; renames?: RecordFileRename[]; scope?: boolean }) {
  const handle = source.forCompany(co)
  sqliteTransactions(conn).run(() => applyRecordChanges(handle.records, {
    repoKey: opts.scope ? `scope:${co}-priv` : 'company',
    scopeId: opts.scope ? `${co}-priv` : null,
    prefix: opts.scope ? '営業部/評価' : '',
    full: false,
    tip: 'a'.repeat(40),
    at: TS,
    changes: Object.entries(opts.changes ?? {}).map(([path, text]) => ({ path, text })),
    renames: opts.renames ?? [],
    scopes: handle.scopes.listWithRules(),
  }))
}

/** A server record (as the engine makes one) linking to `files`. */
function serverDeal(co: string, id: string, files: string[], folder: string | null = null) {
  const records = source.forCompany(co).records
  records.upsert({ id, type: 'deal', typeVersion: 1, scopeId: null, path: null, folder, title: id, summary: '', createdAt: TS, updatedAt: TS, removedAt: null })
  records.replaceLinks(id, files.map((targetPath, position) => ({ sourceId: id, name: 'files', position, targetId: null, targetPath })))
}

const linked = (co: string, id: string) => source.forCompany(co).records.linksFrom([id]).map(l => l.targetPath)

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  company('a')
  company('b')
})

describe('links follow renamed and moved files', () => {
  it('a rename and a move in a push carry every link to the file along', () => {
    serverDeal('a', 'deal-srv00001', ['営業部/提案書.pptx', '営業部/見積.xlsx', '営業部/残る.md'])
    push('a', { renames: [{ from: '営業部/提案書.pptx', to: '営業部/提案書_v2.pptx' }, { from: '営業部/見積.xlsx', to: '経理部/見積/見積.xlsx' }] })
    expect(linked('a', 'deal-srv00001')).toEqual(['営業部/提案書_v2.pptx', '経理部/見積/見積.xlsx', '営業部/残る.md'])
  })

  it('a swap in one push maps each link once', () => {
    serverDeal('a', 'deal-srv00002', ['A.md', 'B.md'])
    push('a', { renames: [{ from: 'A.md', to: 'B.md' }, { from: 'B.md', to: 'A.md' }] })
    expect(linked('a', 'deal-srv00002')).toEqual(['B.md', 'A.md'])
  })

  it('never puts a path inside a private folder into a record outside it', () => {
    // A public record that already names a file inside the private folder (stored, shown only to its readers).
    serverDeal('a', 'deal-srv00003', ['営業部/評価/査定.md', '営業部/メモ.md'])
    // The private folder's own record linking to the same file.
    push('a', { scope: true, changes: { 'まとめ.md': '---\nid: memo-priv0001\ntype: memo\nlinks:\n  files: [営業部/評価/査定.md, 営業部/メモ.md]\n---\n# まとめ\n' } })
    push('a', { scope: true, renames: [{ from: '査定.md', to: '査定_最終.md' }] })
    // The public record keeps the old path (it reads as broken); the private one follows.
    expect(linked('a', 'deal-srv00003')).toEqual(['営業部/評価/査定.md', '営業部/メモ.md'])
    expect(linked('a', 'memo-priv0001')).toEqual(['営業部/評価/査定_最終.md', '営業部/メモ.md'])
    // A move from the company repository into the private folder's path is not followed either,
    // not even by the private folder's own record: no link crosses the folder's edge.
    push('a', { renames: [{ from: '営業部/メモ.md', to: '営業部/評価/メモ.md' }] })
    expect(linked('a', 'deal-srv00003')).toEqual(['営業部/評価/査定.md', '営業部/メモ.md'])
    expect(linked('a', 'memo-priv0001')).toEqual(['営業部/評価/査定_最終.md', '営業部/メモ.md'])
  })

  it('one company’s renames never touch another company’s links', () => {
    serverDeal('a', 'deal-srv00004', ['営業部/提案書.pptx'])
    serverDeal('b', 'deal-srv00004', ['営業部/提案書.pptx'])
    push('a', { renames: [{ from: '営業部/提案書.pptx', to: '営業部/新.pptx' }] })
    expect(linked('a', 'deal-srv00004')).toEqual(['営業部/新.pptx'])
    expect(linked('b', 'deal-srv00004')).toEqual(['営業部/提案書.pptx'])
  })
})

describe('a department renamed by the server', () => {
  it('takes its server records’ folder, the links under it and the minutes folder along — only its own, only this company’s', () => {
    const records = source.forCompany('a').records
    serverDeal('a', 'deal-srv00005', ['営業_部/提案書.pptx', '営業_部2/別.md', '営業_部'], '営業_部')
    serverDeal('a', 'deal-srv00006', [], '営業_部2')
    serverDeal('b', 'deal-srv00005', ['営業_部/提案書.pptx'], '営業_部')
    records.setMinutesFolder('営業_部', 'u-owner', TS)
    sqliteTransactions(conn).run(() => records.moveFolder('営業_部', '営業一部'))
    expect(records.find('deal-srv00005')?.folder).toBe('営業一部')
    expect(linked('a', 'deal-srv00005')).toEqual(['営業一部/提案書.pptx', '営業_部2/別.md', '営業一部'])
    // A sibling whose name only starts the same (and `_` is not a wildcard) stays.
    expect(records.find('deal-srv00006')?.folder).toBe('営業_部2')
    expect(records.minutesFolder()).toBe('営業一部')
    expect(source.forCompany('b').records.find('deal-srv00005')?.folder).toBe('営業_部')
    expect(linked('b', 'deal-srv00005')).toEqual(['営業_部/提案書.pptx'])
  })
})
