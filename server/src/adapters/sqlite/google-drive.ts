/**
 * SQLite storage of Google Drive picks and puts (ports/google-drive.ts),
 * limited to one company: every statement binds `company_id = ?`.
 */
import type Database from 'better-sqlite3'
import { parseSkillUses } from '../../../shared/core/skill-uses'
import type { DrivePickRow, DrivePickTicketRow, DrivePutRow, GoogleDriveRepository, PickTicketDirectory } from '../../ports/google-drive'
import { skillUsesJson } from './skill-uses'

type PickRow = { user_id: string; file_id: string; kind: string; name: string; mime_type: string; picked_at: string; expires_at: string }
type PutRow = {
  id: string; user_id: string; request_key: string; actor_kind: string; conversation_id: string | null; run_id: string | null
  folder_id: string; folder_name: string; name: string; mime_type: string; bytes: number; sha256: string; state: string
  file_id: string | null; revision_id: string | null; link: string | null; reason: string | null; created_at: string; finished_at: string | null
  skills: string | null
  updated_file_id: string | null
  doc_fingerprint: string | null
  doc_revision: string | null
  doc_revision_at: string | null
  doc_baseline_at: string | null
}

type TicketRow = {
  id: string; user_id: string; ticket_hash: string; mode: string; purpose: string; max_items: number; file_ids: string; state: string
  config_handed_at: string | null; result: string | null; created_at: string; expires_at: string; finished_at: string | null
}
const TICKET_COLUMNS = 'id, user_id, ticket_hash, mode, purpose, max_items, file_ids, state, config_handed_at, result, created_at, expires_at, finished_at'
const toTicket = (r: TicketRow): DrivePickTicketRow => {
  let fileIds: string[] = []
  try {
    const parsed = JSON.parse(r.file_ids) as unknown
    if (Array.isArray(parsed)) fileIds = parsed.filter((v): v is string => typeof v === 'string')
  } catch { /* stored by this module only */ }
  return {
    id: r.id, userId: r.user_id, ticketHash: r.ticket_hash, mode: r.mode as DrivePickTicketRow['mode'], purpose: r.purpose === 'link' ? 'link' : 'read', maxItems: r.max_items, fileIds,
    state: r.state as DrivePickTicketRow['state'], configHandedAt: r.config_handed_at, result: r.result, createdAt: r.created_at, expiresAt: r.expires_at,
    finishedAt: r.finished_at,
  }
}

const PICK_COLUMNS = 'user_id, file_id, kind, name, mime_type, picked_at, expires_at'
const PUT_COLUMNS = 'id, user_id, request_key, actor_kind, conversation_id, run_id, folder_id, folder_name, name, mime_type, bytes, sha256, state, file_id, revision_id, link, reason, created_at, finished_at, skills, updated_file_id, doc_fingerprint, doc_revision, doc_revision_at, doc_baseline_at'

const toPick = (r: PickRow): DrivePickRow => ({
  userId: r.user_id, fileId: r.file_id, kind: r.kind as DrivePickRow['kind'], name: r.name, mimeType: r.mime_type, pickedAt: r.picked_at, expiresAt: r.expires_at,
})
const toPut = (r: PutRow): DrivePutRow => ({
  id: r.id, userId: r.user_id, requestKey: r.request_key, actorKind: r.actor_kind as DrivePutRow['actorKind'], conversationId: r.conversation_id, runId: r.run_id,
  folderId: r.folder_id, folderName: r.folder_name, name: r.name, mimeType: r.mime_type, bytes: r.bytes, sha256: r.sha256, state: r.state as DrivePutRow['state'],
  fileId: r.file_id, revisionId: r.revision_id, link: r.link, reason: r.reason, createdAt: r.created_at, finishedAt: r.finished_at,
  skills: parseSkillUses(r.skills), updatedFileId: r.updated_file_id,
  // All three or none: a baseline is only ever written whole.
  docBaseline: r.doc_fingerprint && r.doc_revision && r.doc_revision_at && r.doc_baseline_at
    ? { fingerprint: r.doc_fingerprint, revision: r.doc_revision, revisionAt: r.doc_revision_at, at: r.doc_baseline_at }
    : null,
})

/** The control plane's lookup of a Google Picker pick ticket by its sha256 (google-drive.md): its company only. */
export function sqlitePickTicketDirectory(conn: Database.Database): PickTicketDirectory {
  return {
    companyOf(ticketHash) {
      const r = conn.prepare('SELECT company_id FROM google_drive_pick_tickets WHERE ticket_hash = ?').get(ticketHash) as { company_id: string } | undefined
      return r ? r.company_id : null
    },
  }
}

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
            bytes, sha256, state, file_id, revision_id, link, reason, created_at, finished_at, skills, updated_file_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.id, companyId, row.userId, row.requestKey, row.actorKind, row.conversationId, row.runId, row.folderId, row.folderName, row.name, row.mimeType,
            row.bytes, row.sha256, row.state, row.fileId, row.revisionId, row.link, row.reason, row.createdAt, row.finishedAt, skills, row.updatedFileId)
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
    donePutFiles(userId, opts) {
      // The latest done receipt of each Drive file (ties broken by id, as putOfFile does), then the page.
      return (conn.prepare(`SELECT ${PUT_COLUMNS} FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, id) AS nth FROM google_drive_puts
          WHERE company_id = ? AND user_id = ? AND state = 'done' AND file_id IS NOT NULL
        ) WHERE nth = 1 AND (? IS NULL OR folder_id = ?) AND (? IS NULL OR created_at < ? OR (created_at = ? AND id > ?))
        ORDER BY created_at DESC, id LIMIT ?`)
        .all(companyId, userId, opts.folderId ?? null, opts.folderId ?? null, opts.before?.createdAt ?? null, opts.before?.createdAt ?? null, opts.before?.createdAt ?? null,
          opts.before?.id ?? null, opts.limit) as PutRow[]).map(toPut)
    },
    runPuts(userId, runId, limit) {
      return (conn.prepare(`SELECT ${PUT_COLUMNS} FROM google_drive_puts WHERE company_id = ? AND user_id = ? AND run_id = ? AND state = 'done' AND file_id IS NOT NULL
        ORDER BY created_at, id LIMIT ?`).all(companyId, userId, runId, limit) as PutRow[]).map(toPut)
    },
    settlePut(id, f) {
      return conn.prepare(`UPDATE google_drive_puts SET state = ?, file_id = ?, revision_id = ?, link = ?, reason = ?, finished_at = ?
        WHERE company_id = ? AND id = ? AND state IN ('sending', 'unknown')`)
        .run(f.state, f.fileId, f.revisionId, f.link, f.reason, f.finishedAt, companyId, id).changes > 0
    },
    setDocBaseline(id, b) {
      conn.prepare("UPDATE google_drive_puts SET doc_fingerprint = ?, doc_revision = ?, doc_revision_at = ?, doc_baseline_at = ? WHERE company_id = ? AND id = ? AND state = 'done'")
        .run(b.fingerprint, b.revision, b.revisionAt, b.at, companyId, id)
    },
    dropPut(id) {
      conn.prepare(`DELETE FROM google_drive_puts WHERE company_id = ? AND id = ? AND state = 'sending'`).run(companyId, id)
    },

    createPickTicket(t) {
      conn.prepare(`INSERT INTO google_drive_pick_tickets (id, company_id, user_id, ticket_hash, mode, purpose, max_items, file_ids, state, config_handed_at, result, created_at, expires_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(t.id, companyId, t.userId, t.ticketHash, t.mode, t.purpose, t.maxItems, JSON.stringify(t.fileIds), t.state, t.configHandedAt, t.result, t.createdAt, t.expiresAt, t.finishedAt)
    },
    pickTicketByHash(ticketHash) {
      const r = conn.prepare(`SELECT ${TICKET_COLUMNS} FROM google_drive_pick_tickets WHERE company_id = ? AND ticket_hash = ?`).get(companyId, ticketHash) as TicketRow | undefined
      return r ? toTicket(r) : null
    },
    pickTicket(userId, id) {
      const r = conn.prepare(`SELECT ${TICKET_COLUMNS} FROM google_drive_pick_tickets WHERE company_id = ? AND user_id = ? AND id = ?`).get(companyId, userId, id) as TicketRow | undefined
      return r ? toTicket(r) : null
    },
    claimPickTicketConfig(id, now) {
      return conn.prepare(`UPDATE google_drive_pick_tickets SET config_handed_at = ?
        WHERE company_id = ? AND id = ? AND state = 'open' AND config_handed_at IS NULL AND expires_at > ?`).run(now, companyId, id, now).changes === 1
    },
    movePickTicket(id, from, to, fields) {
      if (from.length === 0) return false
      return conn.prepare(`UPDATE google_drive_pick_tickets SET state = ?, result = COALESCE(?, result), finished_at = COALESCE(?, finished_at)
        WHERE company_id = ? AND id = ? AND state IN (${from.map(() => '?').join(', ')})`)
        .run(to, fields.result ?? null, fields.finishedAt ?? null, companyId, id, ...from).changes === 1
    },
    dropPickTicket(userId, id) {
      conn.prepare('DELETE FROM google_drive_pick_tickets WHERE company_id = ? AND user_id = ? AND id = ?').run(companyId, userId, id)
    },
    openPickTickets(userId, now) {
      return (conn.prepare(`SELECT COUNT(*) AS n FROM google_drive_pick_tickets WHERE company_id = ? AND user_id = ? AND state IN ('open', 'saving') AND expires_at > ?`)
        .get(companyId, userId, now) as { n: number }).n
    },
    prunePickTickets(before) {
      conn.prepare('DELETE FROM google_drive_pick_tickets WHERE company_id = ? AND expires_at <= ?').run(companyId, before)
    },
  }
}
