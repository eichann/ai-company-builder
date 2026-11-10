/**
 * SQLite storage of Google Drive picks and puts (ports/google-drive.ts),
 * limited to one company: every statement binds `company_id = ?`.
 */
import type Database from 'better-sqlite3'
import { parseSkillUses } from '../../../shared/core/skill-uses'
import type { DrivePickRow, DrivePutRow, GoogleDriveRepository } from '../../ports/google-drive'
import { skillUsesJson } from './skill-uses'

type PickRow = { user_id: string; file_id: string; kind: string; name: string; mime_type: string; picked_at: string; expires_at: string }
type PutRow = {
  id: string; user_id: string; request_key: string; actor_kind: string; conversation_id: string | null; run_id: string | null
  folder_id: string; folder_name: string; name: string; mime_type: string; bytes: number; sha256: string; state: string
  file_id: string | null; revision_id: string | null; link: string | null; reason: string | null; created_at: string; finished_at: string | null
  skills: string | null
}

const PICK_COLUMNS = 'user_id, file_id, kind, name, mime_type, picked_at, expires_at'
const PUT_COLUMNS = 'id, user_id, request_key, actor_kind, conversation_id, run_id, folder_id, folder_name, name, mime_type, bytes, sha256, state, file_id, revision_id, link, reason, created_at, finished_at, skills'

const toPick = (r: PickRow): DrivePickRow => ({
  userId: r.user_id, fileId: r.file_id, kind: r.kind as DrivePickRow['kind'], name: r.name, mimeType: r.mime_type, pickedAt: r.picked_at, expiresAt: r.expires_at,
})
const toPut = (r: PutRow): DrivePutRow => ({
  id: r.id, userId: r.user_id, requestKey: r.request_key, actorKind: r.actor_kind as DrivePutRow['actorKind'], conversationId: r.conversation_id, runId: r.run_id,
  folderId: r.folder_id, folderName: r.folder_name, name: r.name, mimeType: r.mime_type, bytes: r.bytes, sha256: r.sha256, state: r.state as DrivePutRow['state'],
  fileId: r.file_id, revisionId: r.revision_id, link: r.link, reason: r.reason, createdAt: r.created_at, finishedAt: r.finished_at,
  skills: parseSkillUses(r.skills),
})

export function sqliteGoogleDriveRepository(conn: Database.Database, companyId: string): GoogleDriveRepository {
  return {
    savePicks(rows) {
      conn.transaction(() => {
        for (const p of rows) {
          conn.prepare(`INSERT INTO google_drive_picks (company_id, user_id, file_id, kind, name, mime_type, picked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (company_id, user_id, file_id) DO UPDATE SET kind = excluded.kind, name = excluded.name, mime_type = excluded.mime_type,
              picked_at = excluded.picked_at, expires_at = excluded.expires_at`)
            .run(companyId, p.userId, p.fileId, p.kind, p.name, p.mimeType, p.pickedAt, p.expiresAt)
        }
      })()
    },
    pick(userId, fileId, now) {
      const r = conn.prepare(`SELECT ${PICK_COLUMNS} FROM google_drive_picks WHERE company_id = ? AND user_id = ? AND file_id = ? AND expires_at > ?`)
        .get(companyId, userId, fileId, now) as PickRow | undefined
      return r ? toPick(r) : null
    },
    picks(userId, now, limit) {
      return (conn.prepare(`SELECT ${PICK_COLUMNS} FROM google_drive_picks WHERE company_id = ? AND user_id = ? AND expires_at > ? ORDER BY picked_at DESC, file_id LIMIT ?`)
        .all(companyId, userId, now, limit) as PickRow[]).map(toPick)
    },
    picksOfKind(userId, kind, now, limit) {
      return (conn.prepare(`SELECT ${PICK_COLUMNS} FROM google_drive_picks WHERE company_id = ? AND user_id = ? AND kind = ? AND expires_at > ? ORDER BY picked_at DESC, file_id LIMIT ?`)
        .all(companyId, userId, kind, now, limit) as PickRow[]).map(toPick)
    },
    prunePicks(now) {
      conn.prepare('DELETE FROM google_drive_picks WHERE company_id = ? AND expires_at <= ?').run(companyId, now)
    },

    claimPut(row) {
      return conn.transaction((): { claimed: true; skills: DrivePutRow['skills'] } | { claimed: false; existing: DrivePutRow } => {
        const existing = conn.prepare(`SELECT ${PUT_COLUMNS} FROM google_drive_puts WHERE company_id = ? AND user_id = ? AND request_key = ?`)
          .get(companyId, row.userId, row.requestKey) as PutRow | undefined
        if (existing) return { claimed: false, existing: toPut(existing) }
        // The AI's put copies the Skills its consultation had used by now (records.md "Which Skill").
        const skills = row.actorKind === 'ai' ? skillUsesJson(conn, companyId, row.userId, row.conversationId) : null
        conn.prepare(`INSERT INTO google_drive_puts (id, company_id, user_id, request_key, actor_kind, conversation_id, run_id, folder_id, folder_name, name, mime_type,
            bytes, sha256, state, file_id, revision_id, link, reason, created_at, finished_at, skills)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.id, companyId, row.userId, row.requestKey, row.actorKind, row.conversationId, row.runId, row.folderId, row.folderName, row.name, row.mimeType,
            row.bytes, row.sha256, row.state, row.fileId, row.revisionId, row.link, row.reason, row.createdAt, row.finishedAt, skills)
        return { claimed: true, skills: parseSkillUses(skills) }
      })()
    },
    put(userId, id) {
      const r = conn.prepare(`SELECT ${PUT_COLUMNS} FROM google_drive_puts WHERE company_id = ? AND user_id = ? AND id = ?`).get(companyId, userId, id) as PutRow | undefined
      return r ? toPut(r) : null
    },
    putOfFile(userId, fileId) {
      const r = conn.prepare(`SELECT ${PUT_COLUMNS} FROM google_drive_puts WHERE company_id = ? AND user_id = ? AND file_id = ? AND state = 'done'
        ORDER BY created_at DESC, id LIMIT 1`).get(companyId, userId, fileId) as PutRow | undefined
      return r ? toPut(r) : null
    },
    donePuts(userId, limit) {
      return (conn.prepare(`SELECT ${PUT_COLUMNS} FROM google_drive_puts WHERE company_id = ? AND user_id = ? AND state = 'done' AND file_id IS NOT NULL
        ORDER BY created_at DESC, id LIMIT ?`).all(companyId, userId, limit) as PutRow[]).map(toPut)
    },
    settlePut(id, f) {
      return conn.prepare(`UPDATE google_drive_puts SET state = ?, file_id = ?, revision_id = ?, link = ?, reason = ?, finished_at = ?
        WHERE company_id = ? AND id = ? AND state IN ('sending', 'unknown')`)
        .run(f.state, f.fileId, f.revisionId, f.link, f.reason, f.finishedAt, companyId, id).changes > 0
    },
    dropPut(id) {
      conn.prepare(`DELETE FROM google_drive_puts WHERE company_id = ? AND id = ? AND state = 'sending'`).run(companyId, id)
    },
  }
}
