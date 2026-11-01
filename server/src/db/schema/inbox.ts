/**
 * The inbox (来た連絡, `.claude/rules/inbox.md`, stage 3 B2). Part of the one
 * schema run by db/index.ts initDatabase (tables before every migration).
 * Behind the company handle (ports/inbox.ts). Pointers and times only — never
 * a body, a subject or an address (the few the owner may see live on the
 * owner-only `interaction` record).
 */
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
