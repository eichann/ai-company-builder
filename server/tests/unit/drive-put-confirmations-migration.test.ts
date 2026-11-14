/**
 * The waiting-put table of #689 (a Google document's overwrite only) is rebuilt once so a put into a place others see can
 * wait too (google-drive.md "Asking before a put"): a row waiting at the upgrade keeps everything it had and can still be
 * pressed; a new file (no file id) and any kind fit afterwards; running it again changes nothing.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateDrivePutConfirmations } from '../../src/db/schema/connectors'

const OLD = `CREATE TABLE google_drive_overwrite_confirmations (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, request_key TEXT NOT NULL,
  folder_id TEXT NOT NULL, file_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('html', 'markdown')), sha256 TEXT NOT NULL,
  content BLOB, record_id TEXT, fingerprint TEXT NOT NULL, revision TEXT NOT NULL, revision_at TEXT NOT NULL, comments_seen TEXT NOT NULL,
  editors TEXT NOT NULL DEFAULT '[]', commented INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('open', 'writing', 'written', 'declined')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`

describe('migrateDrivePutConfirmations', () => {
  it('keeps a waiting overwrite, then takes a new file of any kind; idempotent', () => {
    const conn = new Database(':memory:')
    conn.exec("CREATE TABLE companies (id TEXT PRIMARY KEY); INSERT INTO companies VALUES ('co')")
    conn.exec(OLD)
    conn.prepare(`INSERT INTO google_drive_overwrite_confirmations VALUES ('drive-confirm-1', 'co', 'u', 'conv', 'key-0001', 'folder1', 'file1', '報告書', 'markdown',
      ?, ?, NULL, 'fp', 'rev', 't', 'cs', '["田中"]', 1, 'open', 't0', 't1')`).run('a'.repeat(64), Buffer.from('# 二版\n'))
    migrateDrivePutConfirmations(conn)
    const row = conn.prepare("SELECT * FROM google_drive_overwrite_confirmations WHERE id = 'drive-confirm-1'").get() as Record<string, unknown>
    expect(row).toMatchObject({ file_id: 'file1', kind: 'markdown', as_form: 'google_doc', fingerprint: 'fp', editors: '["田中"]', commented: 1, state: 'open',
      audience: null, audience_sig: null, private_source: 0, trust_offered: 0 })
    expect(Buffer.from(row.content as Buffer).toString()).toBe('# 二版\n')
    // A new PDF into a folder people outside see: no file id, no document state.
    conn.prepare(`INSERT INTO google_drive_overwrite_confirmations (id, company_id, user_id, conversation_id, request_key, folder_id, file_id, name, kind, as_form, sha256,
      audience, audience_sig, trust_offered, state, created_at, expires_at) VALUES ('drive-confirm-2', 'co', 'u', 'conv', 'key-0002', 'folder1', NULL, '見積.pdf', 'pdf', 'file', ?, '{}', ?, 1, 'open', 't0', 't1')`)
      .run('b'.repeat(64), 'c'.repeat(64))
    migrateDrivePutConfirmations(conn)
    expect((conn.prepare('SELECT COUNT(*) AS n FROM google_drive_overwrite_confirmations').get() as { n: number }).n).toBe(2)
  })
})
