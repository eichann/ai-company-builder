/**
 * SQLite storage of Google Drive picks and puts (ports/google-drive.ts),
 * limited to one company: every statement binds `company_id = ?`.
 */
import type Database from 'better-sqlite3'
import { parseSkillUses } from '../../../shared/core/skill-uses'
import type { DriveConfirmAudience, DriveDocRead, DriveFolderTrust, DriveOverwriteConfirmationRow, DrivePickRow, DrivePickTicketRow, DrivePutRow, GoogleDriveRepository, PickTicketDirectory } from '../../ports/google-drive'
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

type ConfirmRow = {
  id: string; user_id: string; conversation_id: string; request_key: string; folder_id: string; file_id: string | null; name: string; kind: string
  as_form: string; sha256: string; content: Buffer | null; record_id: string | null; fingerprint: string | null; revision: string | null
  revision_at: string | null; comments_seen: string | null; editors: string; commented: number; audience: string | null; audience_sig: string | null
  private_source: number; trust_offered: number; state: string; created_at: string; expires_at: string
}
const CONFIRM_COLUMNS = 'id, user_id, conversation_id, request_key, folder_id, file_id, name, kind, as_form, sha256, content, record_id, fingerprint, revision, revision_at, comments_seen, editors, commented, audience, audience_sig, private_source, trust_offered, state, created_at, expires_at'
const stringsOf = (json: string | null): string[] => {
  try {
    const parsed = JSON.parse(json ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch { return [] /* stored by this module only */ }
}
const audienceOf = (r: ConfirmRow): DriveConfirmAudience | null => {
  if (r.audience === null) return null
  try {
    const a = JSON.parse(r.audience) as { anyone?: unknown; outsideDomains?: unknown; insideOthers?: unknown }
    const inside = a.insideOthers === 'domain' ? 'domain' : typeof a.insideOthers === 'number' && Number.isInteger(a.insideOthers) && a.insideOthers >= 0 ? a.insideOthers : 'domain'
    return { anyone: a.anyone === true, outsideDomains: stringsOf(JSON.stringify(a.outsideDomains ?? [])), insideOthers: inside, privateSource: r.private_source === 1 }
  } catch { return null }
}
const toConfirm = (r: ConfirmRow): DriveOverwriteConfirmationRow => ({
  id: r.id, userId: r.user_id, conversationId: r.conversation_id, requestKey: r.request_key, folderId: r.folder_id, fileId: r.file_id, name: r.name,
  kind: r.kind as DriveOverwriteConfirmationRow['kind'], as: r.as_form === 'file' ? 'file' : 'google_doc', sha256: r.sha256,
  content: r.content ? new Uint8Array(r.content) : null, recordId: r.record_id,
  fingerprint: r.fingerprint, revision: r.revision, revisionAt: r.revision_at, commentsSeen: r.comments_seen, editors: stringsOf(r.editors), commented: r.commented === 1,
  audience: audienceOf(r), audienceSig: r.audience_sig, trustOffered: r.trust_offered === 1,
  state: r.state as DriveOverwriteConfirmationRow['state'], createdAt: r.created_at, expiresAt: r.expires_at,
})
type TrustRow = { user_id: string; folder_id: string; folder_name: string; audience_sig: string; outside_domains: string; created_at: string }
const toTrust = (r: TrustRow): DriveFolderTrust => ({
  userId: r.user_id, folderId: r.folder_id, folderName: r.folder_name, audienceSig: r.audience_sig, outsideDomains: stringsOf(r.outside_domains), createdAt: r.created_at,
})

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
    renewPick(userId, fileId, kind, expiresAt, now) {
      conn.prepare(`UPDATE google_drive_picks SET expires_at = ? WHERE company_id = ? AND user_id = ? AND file_id = ? AND kind = ? AND expires_at > ? AND expires_at < ?`)
        .run(expiresAt, companyId, userId, fileId, kind, now, expiresAt)
    },
    anyPick(userId, fileId) {
      const r = conn.prepare(`SELECT ${PICK_COLUMNS} FROM google_drive_picks WHERE company_id = ? AND user_id = ? AND file_id = ?`).get(companyId, userId, fileId) as PickRow | undefined
      return r ? toPick(r) : null
    },

    keepDocRead(d: DriveDocRead) {
      conn.prepare(`INSERT INTO google_drive_doc_reads (company_id, user_id, conversation_id, file_id, fingerprint, revision, revision_at, comments_seen, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (company_id, user_id, conversation_id, file_id) DO UPDATE SET fingerprint = excluded.fingerprint, revision = excluded.revision,
          revision_at = excluded.revision_at, comments_seen = excluded.comments_seen, read_at = excluded.read_at`)
        .run(companyId, d.userId, d.conversationId, d.fileId, d.fingerprint, d.revision, d.revisionAt, d.commentsSeen, d.readAt)
    },
    docRead(userId, conversationId, fileId) {
      const r = conn.prepare(`SELECT user_id, conversation_id, file_id, fingerprint, revision, revision_at, comments_seen, read_at FROM google_drive_doc_reads
        WHERE company_id = ? AND user_id = ? AND conversation_id = ? AND file_id = ?`).get(companyId, userId, conversationId, fileId) as
        { user_id: string; conversation_id: string; file_id: string; fingerprint: string; revision: string; revision_at: string; comments_seen: string; read_at: string } | undefined
      return r ? {
        userId: r.user_id, conversationId: r.conversation_id, fileId: r.file_id, fingerprint: r.fingerprint, revision: r.revision, revisionAt: r.revision_at,
        commentsSeen: r.comments_seen, readAt: r.read_at,
      } : null
    },
    pruneDocReads(before) {
      conn.prepare('DELETE FROM google_drive_doc_reads WHERE company_id = ? AND read_at <= ?').run(companyId, before)
    },

    createOverwriteConfirmation(c) {
      const audience = c.audience ? JSON.stringify({ anyone: c.audience.anyone, outsideDomains: c.audience.outsideDomains, insideOthers: c.audience.insideOthers }) : null
      conn.prepare(`INSERT INTO google_drive_overwrite_confirmations (${CONFIRM_COLUMNS}, company_id) VALUES (${Array(26).fill('?').join(', ')})`)
        .run(c.id, c.userId, c.conversationId, c.requestKey, c.folderId, c.fileId, c.name, c.kind, c.as, c.sha256, c.content ? Buffer.from(c.content) : null, c.recordId,
          c.fingerprint, c.revision, c.revisionAt, c.commentsSeen, JSON.stringify(c.editors), c.commented ? 1 : 0, audience, c.audienceSig,
          c.audience?.privateSource ? 1 : 0, c.trustOffered ? 1 : 0, c.state, c.createdAt, c.expiresAt, companyId)
    },
    overwriteConfirmation(userId, id) {
      const r = conn.prepare(`SELECT ${CONFIRM_COLUMNS} FROM google_drive_overwrite_confirmations WHERE company_id = ? AND user_id = ? AND id = ?`).get(companyId, userId, id) as ConfirmRow | undefined
      return r ? toConfirm(r) : null
    },
    openOverwriteConfirmation(userId, target, now) {
      const where = 'fileId' in target ? 'file_id = ?' : 'file_id IS NULL AND request_key = ?'
      const r = conn.prepare(`SELECT ${CONFIRM_COLUMNS} FROM google_drive_overwrite_confirmations
        WHERE company_id = ? AND user_id = ? AND ${where} AND state = 'open' AND expires_at > ? ORDER BY created_at DESC, id LIMIT 1`)
        .get(companyId, userId, 'fileId' in target ? target.fileId : target.requestKey, now) as ConfirmRow | undefined
      return r ? toConfirm(r) : null
    },
    moveOverwriteConfirmation(id, from, to) {
      if (from.length === 0) return false
      const clear = to === 'written' || to === 'declined'
      return conn.prepare(`UPDATE google_drive_overwrite_confirmations SET state = ?${clear ? ', content = NULL' : ''}
        WHERE company_id = ? AND id = ? AND state IN (${from.map(() => '?').join(', ')})`)
        .run(to, companyId, id, ...from).changes === 1
    },
    declineOpenOverwriteConfirmations(fileId) {
      conn.prepare("UPDATE google_drive_overwrite_confirmations SET state = 'declined', content = NULL WHERE company_id = ? AND file_id = ? AND state = 'open'").run(companyId, fileId)
    },
    folderTrust(userId, folderId) {
      const r = conn.prepare('SELECT user_id, folder_id, folder_name, audience_sig, outside_domains, created_at FROM google_drive_folder_trust WHERE company_id = ? AND user_id = ? AND folder_id = ?')
        .get(companyId, userId, folderId) as TrustRow | undefined
      return r ? toTrust(r) : null
    },
    trustFolder(t) {
      conn.prepare(`INSERT INTO google_drive_folder_trust (company_id, user_id, folder_id, folder_name, audience_sig, outside_domains, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (company_id, user_id, folder_id) DO UPDATE SET folder_name = excluded.folder_name, audience_sig = excluded.audience_sig,
          outside_domains = excluded.outside_domains, created_at = excluded.created_at`)
        .run(companyId, t.userId, t.folderId, t.folderName, t.audienceSig, JSON.stringify(t.outsideDomains), t.createdAt)
    },
    untrustFolder(userId, folderId) {
      return conn.prepare('DELETE FROM google_drive_folder_trust WHERE company_id = ? AND user_id = ? AND folder_id = ?').run(companyId, userId, folderId).changes > 0
    },
    trustedFolders(userId) {
      return (conn.prepare('SELECT user_id, folder_id, folder_name, audience_sig, outside_domains, created_at FROM google_drive_folder_trust WHERE company_id = ? AND user_id = ? ORDER BY created_at DESC, folder_id LIMIT 200')
        .all(companyId, userId) as TrustRow[]).map(toTrust)
    },
    forgetMember(userId) {
      conn.prepare('DELETE FROM google_drive_overwrite_confirmations WHERE company_id = ? AND user_id = ?').run(companyId, userId)
      conn.prepare('DELETE FROM google_drive_folder_trust WHERE company_id = ? AND user_id = ?').run(companyId, userId)
      conn.prepare('DELETE FROM google_drive_doc_reads WHERE company_id = ? AND user_id = ?').run(companyId, userId)
    },
    pruneOverwriteConfirmations(now, deleteBefore) {
      conn.prepare('UPDATE google_drive_overwrite_confirmations SET content = NULL WHERE company_id = ? AND expires_at <= ? AND content IS NOT NULL').run(companyId, now)
      conn.prepare('DELETE FROM google_drive_overwrite_confirmations WHERE company_id = ? AND expires_at <= ?').run(companyId, deleteBefore)
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
