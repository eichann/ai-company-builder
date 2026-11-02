import type Database from 'better-sqlite3'

/**
 * The company map: types, records, links, server values, the ledger, AI tokens, the index (records.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const recordSchema = `
    -- The company map of the light ontology (stage 4-2, .claude/rules/records.md).
    -- Every table is behind the company handle (ports/company-data.ts records).
    -- The feature is off per company until an owner/admin turns it on.
    CREATE TABLE IF NOT EXISTS record_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    -- Type definitions in force, every version kept (records remember the
    -- version they were made under). source: file (.acb/types/<name>.md), core,
    -- or plugin (a connector plugin's package, plugins.md).
    CREATE TABLE IF NOT EXISTS record_types (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('file', 'core', 'plugin')),
      commit_sha TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, name, version)
    );

    -- The record index: rebuildable from the files (path NULL = a record that
    -- lives on the server only; folder = the place its readers are taken from).
    -- scope_id: the private folder holding the file (NULL = company repository).
    CREATE TABLE IF NOT EXISTS records (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      type_version INTEGER,
      scope_id TEXT,
      path TEXT,
      folder TEXT,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      removed_at TEXT,
      PRIMARY KEY (company_id, id)
    );

    -- Links written in record files (rebuildable). target_id for a record,
    -- target_path for a file of the company folder.
    CREATE TABLE IF NOT EXISTS record_links (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      target_id TEXT,
      target_path TEXT,
      PRIMARY KEY (company_id, source_id, name, position)
    );

    -- Server-sourced values (state, assignee, due…): NOT rebuildable from files
    -- (backups). Written only by the state engine; version +1 per change.
    CREATE TABLE IF NOT EXISTS record_state (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      state TEXT,
      fields TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, record_id)
    );

    -- The ledger of the state engine (4-3): one row per change, never updated
    -- or deleted; an undo is a new row (reverses_version). version = the
    -- record's version after this change (1, 2, …), so "record X at version N"
    -- is the fold of rows 1..N. changes: [{ field, before, after }] for the
    -- state and every server field changed. actor_kind: human / ai / external.
    CREATE TABLE IF NOT EXISTS record_ledger (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      actor_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'ai', 'external')),
      actor_source TEXT,
      at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      changes TEXT NOT NULL DEFAULT '[]',
      attachments TEXT NOT NULL DEFAULT '[]',
      decision TEXT,
      is_decision INTEGER NOT NULL DEFAULT 0,
      type_version INTEGER,
      reverses_version INTEGER,
      PRIMARY KEY (company_id, record_id, version)
    );

    -- 「番の人が最初に開いた」 (records.md "Whose turn it was", owner decision
    -- 2026-11-01): one row per record and turn — turn_version = the ledger version
    -- that began the turn (shared/core/record-turns.ts) — written the first time
    -- the turn-holder (or the delegate covering them) opens the record in the app.
    -- A single timestamp, never a view log; insert-or-ignore, never updated.
    -- holder_id: whose turn it was; opened_by: who opened it (the delegate when
    -- they covered). Not in any API answer.
    CREATE TABLE IF NOT EXISTS record_turn_opens (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      turn_version INTEGER NOT NULL,
      holder_id TEXT NOT NULL,
      opened_by TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      PRIMARY KEY (company_id, record_id, turn_version)
    );

    -- The AI's credential for the company map (records.md "Who is acting"): issued
    -- per chat turn by the member's app, sent by the AI's record tools instead of
    -- the member's session (which the AI process never gets). Only the sha256 of
    -- the value is stored. The server records actions made with one as actor_kind
    -- 'ai'. scope: read (look up only) or act (also run actions).
    CREATE TABLE IF NOT EXISTS record_ai_tokens (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL CHECK (scope IN ('read', 'act')),
      agent TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    -- The last commit indexed per repository (repo: 'company' or a private
    -- folder's scope id), so a push is indexed from its diff.
    CREATE TABLE IF NOT EXISTS record_index_heads (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (company_id, repo)
    );

    -- What the index could not take (duplicate ids, invalid definitions,
    -- blocked links…), for owners/admins; replaced each time the file is read.
    CREATE TABLE IF NOT EXISTS record_index_problems (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      found_at TEXT NOT NULL,
      PRIMARY KEY (company_id, repo, path, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_records_company_type ON records(company_id, type);
    CREATE INDEX IF NOT EXISTS idx_records_company_path ON records(company_id, path);
    CREATE INDEX IF NOT EXISTS idx_record_links_target ON record_links(company_id, target_id);
    CREATE INDEX IF NOT EXISTS idx_record_links_path ON record_links(company_id, target_path);
    CREATE INDEX IF NOT EXISTS idx_record_ledger_company_at ON record_ledger(company_id, at);
    CREATE INDEX IF NOT EXISTS idx_record_ai_tokens_member ON record_ai_tokens(company_id, user_id, expires_at);
`

/**
 * Where a ledger entry came from (records.md "Provenance"), added after the
 * ledger shipped: nullable, so an older build keeps inserting without them.
 * proposed_by: 'ai' when a person confirmed what their AI suggested;
 * conversation_id: the consultation it came from. Informational only.
 */
export function migrateRecordLedgerProvenance(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(record_ledger)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('proposed_by')) conn.exec(`ALTER TABLE record_ledger ADD COLUMN proposed_by TEXT`)
  if (!cols.has('conversation_id')) conn.exec(`ALTER TABLE record_ledger ADD COLUMN conversation_id TEXT`)
  // 「外の受領書」 of a connector plugin's entry (JSON of shared/core ExternalReceipt), null otherwise.
  if (!cols.has('receipt')) conn.exec(`ALTER TABLE record_ledger ADD COLUMN receipt TEXT`)
  // A delegate acting for an absent member (records.md "Absence and the delegate"): that member's id.
  if (!cols.has('on_behalf_of')) conn.exec(`ALTER TABLE record_ledger ADD COLUMN on_behalf_of TEXT`)
  // The company's minutes folder (milestone 4, minutes.md): additive, null = not chosen.
  const settings = new Set((conn.prepare(`PRAGMA table_info(record_settings)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!settings.has('minutes_folder')) conn.exec(`ALTER TABLE record_settings ADD COLUMN minutes_folder TEXT`)
  // The content store (records.md): 1 once the company's older rows were moved into it.
  if (!settings.has('content_store')) conn.exec(`ALTER TABLE record_settings ADD COLUMN content_store INTEGER`)
  // Which meetings the intake reads (minutes.md "Which meetings"): null = the default, 'external'.
  if (!settings.has('meeting_intake')) conn.exec(`ALTER TABLE record_settings ADD COLUMN meeting_intake TEXT`)
  // How long 「どのまとまりの会議ですか？」 stays in あなたの番 (minutes.md): null = the default.
  if (!settings.has('meeting_bundle_days')) conn.exec(`ALTER TABLE record_settings ADD COLUMN meeting_bundle_days INTEGER`)
}

/**
 * Owner-only records (records.md "Owner-only records", owner decision 2026-11-01): the one
 * member who may see a record, nobody else (owners and admins included). Additive and
 * nullable: every existing row stays null, so what each member sees today does not change.
 */
export function migrateRecordPersonalOwner(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(records)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('personal_owner')) conn.exec(`ALTER TABLE records ADD COLUMN personal_owner TEXT`)
}

/**
 * record_types.source may be 'plugin' (milestone 3: a connector plugin's
 * types). SQLite cannot change a CHECK, so a table created before is rebuilt
 * once with the same rows (inside one transaction). Idempotent.
 */
export function migrateRecordTypeSources(conn: Database.Database): void {
  const row = conn.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record_types'`).get() as { sql: string } | undefined
  if (!row || row.sql.includes("'plugin'")) return
  conn.transaction(() => {
    conn.pragma('defer_foreign_keys = ON')
    conn.exec(`
      CREATE TABLE record_types_rebuilt (
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('file', 'core', 'plugin')),
        commit_sha TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (company_id, name, version)
      );
      INSERT INTO record_types_rebuilt (company_id, name, version, definition, source, commit_sha, created_at)
        SELECT company_id, name, version, definition, source, commit_sha, created_at FROM record_types;
      DROP TABLE record_types;
      ALTER TABLE record_types_rebuilt RENAME TO record_types;
    `)
  })()
}
