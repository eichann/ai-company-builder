/**
 * SQLite storage of Skill drafts made from recordings (ports/browser-skill-drafts.ts), bound to one company — built only by
 * the company handle (adapters/sqlite/company-data.ts), every statement limited to `companyId` and, but the clock's sweep,
 * to the author.
 */
import type Database from 'better-sqlite3'
import type { BrowserSkillDraftRepository, BrowserSkillDraftRow } from '../../ports/browser-skill-drafts'

type DbRow = {
  id: string; user_id: string; name: string; domain: string; recording_ids: string; base_declaration: string; base_notes: string
  declaration: string; steps: string; version: string; tried_version: string | null; created_at: string; updated_at: string; delete_at: string
}
const COLUMNS = 'id, user_id, name, domain, recording_ids, base_declaration, base_notes, declaration, steps, version, tried_version, created_at, updated_at, delete_at'
const toRow = (r: DbRow): BrowserSkillDraftRow => ({
  id: r.id, userId: r.user_id, name: r.name, domain: r.domain, recordingIds: r.recording_ids, baseDeclaration: r.base_declaration,
  baseNotes: r.base_notes, declaration: r.declaration, steps: r.steps, version: r.version, triedVersion: r.tried_version,
  createdAt: r.created_at, updatedAt: r.updated_at, deleteAt: r.delete_at,
})

export function sqliteBrowserSkillDraftRepository(conn: Database.Database, companyId: string): BrowserSkillDraftRepository {
  return {
    insert(row) {
      conn.prepare(`INSERT INTO browser_skill_drafts (company_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        companyId, row.id, row.userId, row.name, row.domain, row.recordingIds, row.baseDeclaration, row.baseNotes, row.declaration,
        row.steps, row.version, row.triedVersion, row.createdAt, row.updatedAt, row.deleteAt,
      )
    },
    byId(userId, id, now, since) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM browser_skill_drafts WHERE company_id = ? AND user_id = ? AND id = ? AND delete_at > ? AND created_at >= ?`)
        .get(companyId, userId, id, now, since) as DbRow | undefined
      return r ? toRow(r) : null
    },
    list(userId, now, since) {
      return (conn.prepare(`SELECT ${COLUMNS} FROM browser_skill_drafts WHERE company_id = ? AND user_id = ? AND delete_at > ? AND created_at >= ?
        ORDER BY updated_at DESC, rowid DESC`).all(companyId, userId, now, since) as DbRow[]).map(toRow)
    },
    countOf(userId, now, since) {
      return (conn.prepare('SELECT COUNT(*) AS n FROM browser_skill_drafts WHERE company_id = ? AND user_id = ? AND delete_at > ? AND created_at >= ?')
        .get(companyId, userId, now, since) as { n: number }).n
    },
    nameTaken(userId, name, now, since, except) {
      return conn.prepare('SELECT 1 FROM browser_skill_drafts WHERE company_id = ? AND user_id = ? AND name = ? AND delete_at > ? AND created_at >= ? AND id IS NOT ?')
        .get(companyId, userId, name, now, since, except) !== undefined
    },
    change(userId, id, expectedVersion, to) {
      return conn.prepare(`UPDATE browser_skill_drafts SET name = ?, declaration = ?, steps = ?, version = ?, updated_at = ?, delete_at = ?
        WHERE company_id = ? AND user_id = ? AND id = ? AND version = ?`)
        .run(to.name, to.declaration, to.steps, to.version, to.updatedAt, to.deleteAt, companyId, userId, id, expectedVersion).changes === 1
    },
    delete(userId, id) {
      return conn.prepare('DELETE FROM browser_skill_drafts WHERE company_id = ? AND user_id = ? AND id = ?').run(companyId, userId, id).changes === 1
    },
    deleteExpired(now) {
      return conn.prepare('DELETE FROM browser_skill_drafts WHERE company_id = ? AND delete_at <= ?').run(companyId, now).changes
    },
  }
}
