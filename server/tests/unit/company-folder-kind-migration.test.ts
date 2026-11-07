/**
 * Every company made before the folder kind existed keeps its shared company folder (owner
 * decision 2026-11-07: today's companies are unchanged): the added column says `git` for them,
 * and for a row an older build inserts without it. Running the migration again changes nothing.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrateCompanyFolderKind } from '../../src/db'
import { storedCompanyFolderKind } from '../../shared/core/company-folder'

const BEFORE = `
  CREATE TABLE companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
    repo_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`

describe('migrateCompanyFolderKind', () => {
  it('gives existing companies, and older builds\' inserts, the folder', () => {
    const conn = new Database(':memory:')
    conn.exec(BEFORE)
    conn.prepare('INSERT INTO companies VALUES (?, ?, ?, ?, ?, ?, ?)').run('old', 'Old', 'old', 'u', '/repos/old.git', 't', 't')
    migrateCompanyFolderKind(conn)
    migrateCompanyFolderKind(conn)
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('older-build', 'Older', 'older', 'u', null, 't', 't')
    const kinds = conn.prepare('SELECT id, folder_kind FROM companies ORDER BY id').all() as Array<{ id: string; folder_kind: string }>
    expect(kinds).toEqual([{ id: 'old', folder_kind: 'git' }, { id: 'older-build', folder_kind: 'git' }])
    expect(kinds.map(k => storedCompanyFolderKind(k.folder_kind))).toEqual(['git', 'git'])
    // Only the two kinds are stored.
    expect(() => conn.prepare("UPDATE companies SET folder_kind = 'drive' WHERE id = 'old'").run()).toThrow()
  })

  it('anything but an exact git has no folder (never runs git for an unknown kind)', () => {
    expect(storedCompanyFolderKind('git')).toBe('git')
    for (const v of ['none', 'GIT', 'drive', null, undefined]) expect(storedCompanyFolderKind(v)).toBe('none')
  })
})
