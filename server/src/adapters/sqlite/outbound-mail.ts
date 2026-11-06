/**
 * SQLite storage of outbound mail (ports/outbound-mail.ts), limited to one
 * company: every statement binds `company_id = ?` with the handle's id.
 */
import type Database from 'better-sqlite3'
import { SHA256_HEX_RE, type MailAttachment, type RecipientSource } from '../../../shared/core/mail'
import type {
  OutboundAttachmentRow, OutboundMailRepository, OutboundMailRow, OutboundRecipientRow, OutboundSendOutcome, OutboundSendRow,
} from '../../ports/outbound-mail'

type MailRow = {
  message_id: string; author_id: string; from_email: string; minutes_id: string | null; deal_id: string | null
  created_at: string; finished_at: string | null; body_deleted_at: string | null
}
type VersionRow = { message_id: string; version: number; to_json: string; cc_json: string; attachments_json: string | null; actor_kind: string; created_at: string }
type AttachmentRow = { message_id: string; sha256: string; name: string; size: number; bytes: Buffer | null; added_by: string; added_at: string; bytes_deleted_at: string | null }
type SendRow = {
  id: string; message_id: string; version: number; hash: string; by_user: string; started_at: string; outcome: string
  reason: string | null; provider_message_id: string | null; finished_at: string | null
}
type TypedRow = { ref: string; email: string; name: string | null }

const MAIL_COLUMNS = 'message_id, author_id, from_email, minutes_id, deal_id, created_at, finished_at, body_deleted_at'
const SEND_COLUMNS = 'id, message_id, version, hash, by_user, started_at, outcome, reason, provider_message_id, finished_at'

const toMail = (r: MailRow): OutboundMailRow => ({
  messageId: r.message_id, authorId: r.author_id, fromEmail: r.from_email, meetingId: r.minutes_id, bundleId: r.deal_id,
  createdAt: r.created_at, finishedAt: r.finished_at, bodyDeletedAt: r.body_deleted_at,
})
const SOURCES: readonly string[] = ['calendar', 'hubspot', 'member', 'typed']
function recipientsOf(text: string): OutboundRecipientRow[] {
  try {
    const v = JSON.parse(text) as unknown
    if (!Array.isArray(v)) return []
    return v.flatMap((x: unknown) => {
      const o = x as Record<string, unknown>
      return o && typeof o.ref === 'string' && typeof o.email === 'string' && SOURCES.includes(o.source as string)
        ? [{ ref: o.ref, email: o.email, name: typeof o.name === 'string' ? o.name : null, source: o.source as RecipientSource }]
        : []
    })
  } catch {
    return []
  }
}
function attachmentsOf(text: string | null): MailAttachment[] {
  if (!text) return []
  try {
    const v = JSON.parse(text) as unknown
    if (!Array.isArray(v)) return []
    return v.flatMap((x: unknown) => {
      const o = x as Record<string, unknown>
      return o && typeof o.name === 'string' && typeof o.size === 'number' && typeof o.sha256 === 'string' && SHA256_HEX_RE.test(o.sha256)
        ? [{ name: o.name, size: o.size, sha256: o.sha256 }]
        : []
    })
  } catch {
    return []
  }
}
const toSend = (r: SendRow): OutboundSendRow => ({
  id: r.id, messageId: r.message_id, version: r.version, hash: r.hash, by: r.by_user, startedAt: r.started_at,
  outcome: r.outcome as OutboundSendOutcome, reason: r.reason, providerMessageId: r.provider_message_id, finishedAt: r.finished_at,
})

export function sqliteOutboundMailRepository(conn: Database.Database, companyId: string): OutboundMailRepository {
  return {
    insertMail(row) {
      conn.prepare(`INSERT INTO outbound_mails (company_id, ${MAIL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.messageId, row.authorId, row.fromEmail, row.meetingId, row.bundleId, row.createdAt, row.finishedAt, row.bodyDeletedAt)
    },
    mail(messageId) {
      const r = conn.prepare(`SELECT ${MAIL_COLUMNS} FROM outbound_mails WHERE company_id = ? AND message_id = ?`).get(companyId, messageId) as MailRow | undefined
      return r ? toMail(r) : null
    },
    setFinished(messageId, at) {
      conn.prepare('UPDATE outbound_mails SET finished_at = ? WHERE company_id = ? AND message_id = ?').run(at, companyId, messageId)
    },
    finishedBefore(before, limit) {
      return (conn.prepare(`SELECT ${MAIL_COLUMNS} FROM outbound_mails
        WHERE company_id = ? AND finished_at IS NOT NULL AND finished_at < ? AND body_deleted_at IS NULL
        ORDER BY finished_at, message_id LIMIT ?`).all(companyId, before, limit) as MailRow[]).map(toMail)
    },
    markBodyDeleted(messageId, at) {
      conn.prepare('UPDATE outbound_mails SET body_deleted_at = ? WHERE company_id = ? AND message_id = ? AND body_deleted_at IS NULL').run(at, companyId, messageId)
    },

    insertVersion(row) {
      // A version without files keeps the column null (as every version made before attachments).
      const files = row.attachments && row.attachments.length > 0 ? JSON.stringify(row.attachments.map(a => ({ name: a.name, size: a.size, sha256: a.sha256 }))) : null
      conn.prepare('INSERT INTO outbound_mail_versions (company_id, message_id, version, to_json, cc_json, attachments_json, actor_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, row.messageId, row.version, JSON.stringify(row.to), JSON.stringify(row.cc), files, row.actorKind, row.createdAt)
    },
    version(messageId, version) {
      const r = conn.prepare('SELECT message_id, version, to_json, cc_json, attachments_json, actor_kind, created_at FROM outbound_mail_versions WHERE company_id = ? AND message_id = ? AND version = ?')
        .get(companyId, messageId, version) as VersionRow | undefined
      return r ? {
        messageId: r.message_id, version: r.version, to: recipientsOf(r.to_json), cc: recipientsOf(r.cc_json), attachments: attachmentsOf(r.attachments_json),
        actorKind: r.actor_kind === 'ai' ? 'ai' : 'human', createdAt: r.created_at,
      } : null
    },

    putAttachment(row) {
      conn.prepare(`INSERT INTO outbound_mail_attachments (company_id, message_id, sha256, name, size, content_type, bytes, added_by, added_at, bytes_deleted_at)
        VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?, NULL)
        ON CONFLICT (company_id, message_id, sha256) DO UPDATE SET bytes = excluded.bytes, bytes_deleted_at = NULL WHERE outbound_mail_attachments.bytes IS NULL`)
        .run(companyId, row.messageId, row.sha256, row.name, row.size, Buffer.from(row.bytes), row.addedBy, row.addedAt)
    },
    attachment(messageId, sha256) {
      const r = conn.prepare('SELECT message_id, sha256, name, size, bytes, added_by, added_at, bytes_deleted_at FROM outbound_mail_attachments WHERE company_id = ? AND message_id = ? AND sha256 = ?')
        .get(companyId, messageId, sha256) as AttachmentRow | undefined
      return r ? {
        messageId: r.message_id, sha256: r.sha256, name: r.name, size: r.size, bytes: r.bytes ? new Uint8Array(r.bytes) : null,
        addedBy: r.added_by, addedAt: r.added_at, bytesDeletedAt: r.bytes_deleted_at,
      } satisfies OutboundAttachmentRow : null
    },
    deletedAttachmentBytes(messageId) {
      return (conn.prepare('SELECT sha256 FROM outbound_mail_attachments WHERE company_id = ? AND message_id = ? AND bytes IS NULL ORDER BY sha256')
        .all(companyId, messageId) as Array<{ sha256: string }>).map(r => r.sha256)
    },
    deleteAttachmentBytes(messageId, at, keep = []) {
      return conn.prepare(`UPDATE outbound_mail_attachments SET bytes = NULL, bytes_deleted_at = ?
        WHERE company_id = ? AND message_id = ? AND bytes IS NOT NULL AND sha256 NOT IN (SELECT value FROM json_each(?))`)
        .run(at, companyId, messageId, JSON.stringify(keep)).changes
    },

    typedRecipients(messageId) {
      return (conn.prepare('SELECT ref, email, name FROM outbound_typed_recipients WHERE company_id = ? AND message_id = ? ORDER BY added_at, ref')
        .all(companyId, messageId) as TypedRow[]).map(r => ({ ref: r.ref, email: r.email, name: r.name, source: 'typed' as const }))
    },
    addTypedRecipient(messageId, row, by, at) {
      conn.prepare('INSERT OR IGNORE INTO outbound_typed_recipients (company_id, message_id, ref, email, name, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, messageId, row.ref, row.email, row.name, by, at)
    },

    startSend(row) {
      return conn.transaction(() => {
        const busy = conn.prepare("SELECT 1 FROM outbound_sends WHERE company_id = ? AND message_id = ? AND outcome IN ('sending', 'unknown', 'sent') LIMIT 1")
          .get(companyId, row.messageId)
        if (busy) return false
        conn.prepare(`INSERT INTO outbound_sends (company_id, ${SEND_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', NULL, NULL, NULL)`)
          .run(companyId, row.id, row.messageId, row.version, row.hash, row.by, row.startedAt)
        return true
      })()
    },
    finishSend(id, outcome, reason, providerMessageId, at) {
      conn.prepare("UPDATE outbound_sends SET outcome = ?, reason = ?, provider_message_id = ?, finished_at = ? WHERE company_id = ? AND id = ? AND outcome = 'sending'")
        .run(outcome, reason, providerMessageId, at, companyId, id)
    },
    lastSend(messageId) {
      const r = conn.prepare(`SELECT ${SEND_COLUMNS} FROM outbound_sends WHERE company_id = ? AND message_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`)
        .get(companyId, messageId) as SendRow | undefined
      return r ? toSend(r) : null
    },
    resolveSend(id, outcome, at) {
      conn.prepare("UPDATE outbound_sends SET outcome = ?, reason = 'resolved-by-person', finished_at = ? WHERE company_id = ? AND id = ? AND outcome = 'unknown'")
        .run(outcome, at, companyId, id)
    },
    sentDomains() {
      const rows = conn.prepare(`SELECT v.to_json, v.cc_json FROM outbound_sends s
        JOIN outbound_mail_versions v ON v.company_id = s.company_id AND v.message_id = s.message_id AND v.version = s.version
        WHERE s.company_id = ? AND s.outcome = 'sent'`).all(companyId) as Array<{ to_json: string; cc_json: string }>
      const out = new Set<string>()
      for (const r of rows) for (const x of [...recipientsOf(r.to_json), ...recipientsOf(r.cc_json)]) out.add(x.email.slice(x.email.lastIndexOf('@') + 1).toLowerCase())
      return [...out]
    },
  }
}
