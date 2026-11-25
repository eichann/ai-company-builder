/**
 * SQLite storage of 「Skill の承認」 (ports/browser-skills.ts), bound to one company — built only by the company handle
 * (adapters/sqlite/company-data.ts), every statement limited to `companyId`.
 */
import type Database from 'better-sqlite3'
import type { BrowserSkillApprovalRepository, BrowserSkillApprovalRow } from '../../ports/browser-skills'

type DbRow = {
  seq: number; skill_path: string; declaration_hash: string; mode: string; how: string; approved_by: string; approved_at: string
  files_seen: string | null; revoked_at: string | null; revoked_by: string | null
}
const COLUMNS = 'seq, skill_path, declaration_hash, mode, how, approved_by, approved_at, files_seen, revoked_at, revoked_by'
const toRow = (r: DbRow): BrowserSkillApprovalRow => ({
  seq: r.seq, skillPath: r.skill_path, declarationHash: r.declaration_hash, mode: r.mode as BrowserSkillApprovalRow['mode'],
  how: r.how as BrowserSkillApprovalRow['how'], approvedBy: r.approved_by, approvedAt: r.approved_at, filesSeen: r.files_seen,
  revokedAt: r.revoked_at, revokedBy: r.revoked_by,
})

export function sqliteBrowserSkillApprovalRepository(conn: Database.Database, companyId: string): BrowserSkillApprovalRepository {
  const latest = (skillPath: string): BrowserSkillApprovalRow | null => {
    const r = conn.prepare(`SELECT ${COLUMNS} FROM browser_skill_approvals WHERE company_id = ? AND skill_path = ? ORDER BY seq DESC LIMIT 1`)
      .get(companyId, skillPath) as DbRow | undefined
    return r ? toRow(r) : null
  }
  return {
    latest,
    insert(row) {
      const info = conn.prepare(`INSERT INTO browser_skill_approvals (company_id, skill_path, declaration_hash, mode, how, approved_by, approved_at, files_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(companyId, row.skillPath, row.declarationHash, row.mode, row.how, row.approvedBy, row.approvedAt, row.filesSeen)
      return { ...row, seq: Number(info.lastInsertRowid), revokedAt: null, revokedBy: null }
    },
    revoke(seq, at, by) {
      return conn.transaction(() => {
        const r = conn.prepare('SELECT skill_path FROM browser_skill_approvals WHERE company_id = ? AND seq = ?').get(companyId, seq) as { skill_path: string } | undefined
        if (!r || latest(r.skill_path)?.seq !== seq) return false
        return conn.prepare('UPDATE browser_skill_approvals SET revoked_at = ?, revoked_by = ? WHERE company_id = ? AND seq = ? AND revoked_at IS NULL')
          .run(at, by, companyId, seq).changes === 1
      })()
    },
    setFilesSeen(seq, files) {
      conn.prepare('UPDATE browser_skill_approvals SET files_seen = ? WHERE company_id = ? AND seq = ?').run(files, companyId, seq)
    },
  }
}
