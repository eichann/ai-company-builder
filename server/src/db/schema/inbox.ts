/**
 * The inbox (来た連絡, `.claude/rules/inbox.md`, stage 3 B2). Part of the one
 * schema run by db/index.ts initDatabase (tables before every migration).
 * Behind the company handle (ports/inbox.ts). Pointers and times only — never
 * a body, a subject or an address (the few the owner may see live on the
 * owner-only `interaction` record).
 */
import type Database from 'better-sqlite3'

export const inboxSchema = `
    -- The company's intake settings (shared/core/intake-settings.ts), one JSON document.
    CREATE TABLE IF NOT EXISTS inbox_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    -- Every message seen, by its id: one interaction per thread, a message never twice.
    CREATE TABLE IF NOT EXISTS inbox_messages (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'chat')),
      message_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      occurred_at TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      -- The connector's opaque pointer to this message (the AI reads it again on demand, B4).
      source_ref TEXT,
      -- Whose mailbox the pointer is in (the member who reported it; NULL before 2026-11-05).
      reporter_id TEXT,
      PRIMARY KEY (company_id, channel, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_messages_interaction ON inbox_messages(company_id, interaction_id);

    -- A member's connection per channel: from where the next poll reads.
    CREATE TABLE IF NOT EXISTS inbox_connections (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'chat')),
      connected_at TEXT NOT NULL,
      checked_until TEXT NOT NULL,
      -- Where the source's change log was last read (mail that left the inbox; NULL: not yet).
      left_cursor TEXT,
      PRIMARY KEY (company_id, user_id, channel)
    );

    -- Spans nobody checked (a connection broken for more than 7 days): shown to the member.
    CREATE TABLE IF NOT EXISTS inbox_gaps (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      gap_from TEXT NOT NULL,
      gap_to TEXT NOT NULL,
      noted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_gaps_user ON inbox_gaps(company_id, user_id);
`

/** B4: each message keeps its connector pointer (a database made before it gets the column). */
export function migrateInboxMessageSourceRef(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(inbox_messages)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('source_ref')) conn.exec('ALTER TABLE inbox_messages ADD COLUMN source_ref TEXT')
}

/** 2026-11-05 (inbox.md "Mail archived in the mailbox"): whose mailbox a pointer is in, and where its change log was read. */
export function migrateInboxArchiveColumns(conn: Database.Database): void {
  const has = (table: string) => new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  if (!has('inbox_messages').has('reporter_id')) conn.exec('ALTER TABLE inbox_messages ADD COLUMN reporter_id TEXT')
  if (!has('inbox_connections').has('left_cursor')) conn.exec('ALTER TABLE inbox_connections ADD COLUMN left_cursor TEXT')
}
