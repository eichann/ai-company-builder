/**
 * Outbound mail: drafts, recipients per version, typed recipients, send attempts (outbound-mail.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const outboundMailSchema = `
    -- Outbound mail (milestone 4 G8, .claude/rules/outbound-mail.md), behind the
    -- company handle (ports/outbound-mail.ts). The content per version (canonical
    -- text + hash) is in fixed_payloads; the state in the company map.
    -- One draft = one outbound_message record.
    CREATE TABLE IF NOT EXISTS outbound_mails (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      from_email TEXT NOT NULL,
      minutes_id TEXT,
      deal_id TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      body_deleted_at TEXT,
      PRIMARY KEY (company_id, message_id)
    );

    -- The verified recipients (ref, address, name, source) of each content version.
    CREATE TABLE IF NOT EXISTS outbound_mail_versions (
      company_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      to_json TEXT NOT NULL,
      cc_json TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'ai')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, message_id, version),
      FOREIGN KEY (company_id, message_id) REFERENCES outbound_mails(company_id, message_id) ON DELETE CASCADE
    );

    -- Addresses a person typed on the screen for one draft (「あなたが入力」).
    CREATE TABLE IF NOT EXISTS outbound_typed_recipients (
      company_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (company_id, message_id, ref),
      FOREIGN KEY (company_id, message_id) REFERENCES outbound_mails(company_id, message_id) ON DELETE CASCADE
    );

    -- Every send attempt, written before Gmail is called; never re-sent.
    CREATE TABLE IF NOT EXISTS outbound_sends (
      company_id TEXT NOT NULL,
      id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      by_user TEXT NOT NULL,
      started_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('sending', 'sent', 'unknown', 'not-sent', 'refused')),
      reason TEXT,
      provider_message_id TEXT,
      finished_at TEXT,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, message_id) REFERENCES outbound_mails(company_id, message_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_outbound_sends_message ON outbound_sends(company_id, message_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_outbound_mails_finished ON outbound_mails(company_id, finished_at);
`
