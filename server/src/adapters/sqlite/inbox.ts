/**
 * SQLite storage of the inbox (ports/inbox.ts), limited to one company:
 * every statement binds `company_id = ?`.
 */
import type Database from 'better-sqlite3'
import type { InboxChannel, InboxConnectionRow, InboxGapRow, InboxMessageRow, InboxRepository } from '../../ports/inbox'

type MessageRow = { channel: string; message_id: string; interaction_id: string; direction: string; occurred_at: string; seen_at: string; source_ref: string | null; reporter_id: string | null }
type ConnectionRow = { user_id: string; channel: string; connected_at: string; checked_until: string; left_cursor: string | null }
type GapRow = { user_id: string; channel: string; gap_from: string; gap_to: string; noted_at: string }

const MESSAGE_COLS = 'channel, message_id, interaction_id, direction, occurred_at, seen_at, source_ref, reporter_id'
const CONNECTION_COLS = 'user_id, channel, connected_at, checked_until'
const CONNECTION_READ_COLS = `${CONNECTION_COLS}, left_cursor`
const message = (r: MessageRow): InboxMessageRow => ({
  channel: r.channel as InboxChannel, messageId: r.message_id, interactionId: r.interaction_id,
  direction: r.direction as 'in' | 'out', occurredAt: r.occurred_at, seenAt: r.seen_at, sourceRef: r.source_ref ?? null, reporterId: r.reporter_id ?? null,
})
const connection = (r: ConnectionRow): InboxConnectionRow => ({
  userId: r.user_id, channel: r.channel as InboxChannel, connectedAt: r.connected_at, checkedUntil: r.checked_until, leftCursor: r.left_cursor ?? null,
})
const gap = (r: GapRow): InboxGapRow => ({ userId: r.user_id, channel: r.channel as InboxChannel, from: r.gap_from, to: r.gap_to, notedAt: r.noted_at })

export function sqliteInboxRepository(conn: Database.Database, companyId: string): InboxRepository {
  return {
    settings() {
      const r = conn.prepare('SELECT settings, updated_at, updated_by FROM inbox_settings WHERE company_id = ?').get(companyId) as
        { settings: string; updated_at: string; updated_by: string | null } | undefined
      return r ? { settings: r.settings, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
    },
    saveSettings(settings, at, by) {
      conn.prepare(`INSERT INTO inbox_settings (company_id, settings, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(companyId, settings, at, by)
    },

    message(channel, messageId) {
      const r = conn.prepare(`SELECT ${MESSAGE_COLS} FROM inbox_messages WHERE company_id = ? AND channel = ? AND message_id = ?`)
        .get(companyId, channel, messageId) as MessageRow | undefined
      return r ? message(r) : null
    },
    interactionsOf(channel, messageIds) {
      if (messageIds.length === 0) return []
      const marks = messageIds.map(() => '?').join(', ')
      const rows = conn.prepare(`SELECT interaction_id FROM inbox_messages WHERE company_id = ? AND channel = ? AND message_id IN (${marks})
          ORDER BY occurred_at, message_id`).all(companyId, channel, ...messageIds) as Array<{ interaction_id: string }>
      return [...new Set(rows.map(r => r.interaction_id))]
    },
    messagesOf(interactionId) {
      return (conn.prepare(`SELECT ${MESSAGE_COLS} FROM inbox_messages WHERE company_id = ? AND interaction_id = ? ORDER BY occurred_at, message_id`)
        .all(companyId, interactionId) as MessageRow[]).map(message)
    },
    latestIncoming(channel, prefix, since, before) {
      const r = conn.prepare(`SELECT ${MESSAGE_COLS} FROM inbox_messages WHERE company_id = ? AND channel = ? AND direction = 'in'
          AND substr(message_id, 1, ?) = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC, message_id DESC LIMIT 1`)
        .get(companyId, channel, prefix.length, prefix, since, before) as MessageRow | undefined
      return r ? message(r) : null
    },
    insertMessage(row) {
      const r = conn.prepare(`INSERT OR IGNORE INTO inbox_messages (company_id, ${MESSAGE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.channel, row.messageId, row.interactionId, row.direction, row.occurredAt, row.seenAt, row.sourceRef, row.reporterId ?? null)
      return r.changes === 1
    },

    connection(userId, channel) {
      const r = conn.prepare(`SELECT ${CONNECTION_READ_COLS} FROM inbox_connections WHERE company_id = ? AND user_id = ? AND channel = ?`)
        .get(companyId, userId, channel) as ConnectionRow | undefined
      return r ? connection(r) : null
    },
    connections(userId) {
      return (conn.prepare(`SELECT ${CONNECTION_READ_COLS} FROM inbox_connections WHERE company_id = ? AND user_id = ? ORDER BY channel`)
        .all(companyId, userId) as ConnectionRow[]).map(connection)
    },
    connected(channel) {
      return (conn.prepare(`SELECT ${CONNECTION_READ_COLS} FROM inbox_connections WHERE company_id = ? AND channel = ? ORDER BY user_id`)
        .all(companyId, channel) as ConnectionRow[]).map(connection)
    },
    putConnection(row) {
      conn.prepare(`INSERT INTO inbox_connections (company_id, ${CONNECTION_COLS}) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(company_id, user_id, channel) DO UPDATE SET connected_at = excluded.connected_at, checked_until = excluded.checked_until`)
        .run(companyId, row.userId, row.channel, row.connectedAt, row.checkedUntil)
    },
    setCheckedUntil(userId, channel, at) {
      conn.prepare('UPDATE inbox_connections SET checked_until = ? WHERE company_id = ? AND user_id = ? AND channel = ?').run(at, companyId, userId, channel)
    },
    setLeftCursor(userId, channel, cursor) {
      conn.prepare('UPDATE inbox_connections SET left_cursor = ? WHERE company_id = ? AND user_id = ? AND channel = ?').run(cursor, companyId, userId, channel)
    },
    addGap(row) {
      conn.prepare('INSERT INTO inbox_gaps (company_id, user_id, channel, gap_from, gap_to, noted_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(companyId, row.userId, row.channel, row.from, row.to, row.notedAt)
    },
    gaps(userId) {
      return (conn.prepare('SELECT user_id, channel, gap_from, gap_to, noted_at FROM inbox_gaps WHERE company_id = ? AND user_id = ? ORDER BY seq')
        .all(companyId, userId) as GapRow[]).map(gap)
    },
  }
}
