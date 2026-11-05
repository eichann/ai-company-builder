import type Database from 'better-sqlite3'

/**
 * Connector plugins: installs, mappings, history, outside links, read scopes, acknowledgements, operations (plugins.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const pluginSchema = `
    -- Connector plugins (milestone 3, .claude/rules/plugins.md): which package
    -- of the shelf a company uses, its mapping versions and their history.
    -- Behind the company handle (ports/plugins.ts); triggers in
    -- migratePluginTables keep every row in its company.
    CREATE TABLE IF NOT EXISTS plugin_installs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      -- The key broker's service the plugin talks to (kept even if the package leaves the shelf).
      service TEXT NOT NULL,
      -- The connection (review §5.7): a new id when the outside account changes; a key
      -- rotation keeps it. account_id = the outside account (HubSpot portal id), set by
      -- the connector on its first call; null until then.
      connection_id TEXT NOT NULL,
      account_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      -- First turned on: from then on the relay never writes to the service for this
      -- company (turning the plugin off does not undo it; plugins.md).
      managed_since TEXT,
      -- A deleted key leaves the plugin without one (problem no-key), never blocks the delete.
      key_id TEXT REFERENCES broker_keys(id) ON DELETE SET NULL,
      mapping_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id)
    );

    -- Every read of a contract-3 call (plugins.md "Contract 3"): who, which ids, how it went; never an
    -- answer. Append-only (the triggers); a row goes only when a year old (retention), or with its company
    -- (the cascade removes the company first, so the row's company is gone by then).
    CREATE TABLE IF NOT EXISTS plugin_access_log (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      call TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      conversation_id TEXT,
      run_id TEXT,
      refs TEXT NOT NULL,
      status TEXT NOT NULL,
      dropped INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_access_log ON plugin_access_log(company_id, plugin_id, at);
    CREATE TRIGGER IF NOT EXISTS plugin_access_log_no_update BEFORE UPDATE ON plugin_access_log
    BEGIN SELECT RAISE(ABORT, 'plugin_access_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS plugin_access_log_no_delete BEFORE DELETE ON plugin_access_log
    WHEN OLD.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') AND EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN SELECT RAISE(ABORT, 'plugin_access_log is append-only'); END;

    -- Reads refused for a member's share of a call's pace (plugins.md "Contract 3"): a count per member and
    -- hour, nothing else, so a looping AI shows without a log row per refusal. Gone after a year.
    CREATE TABLE IF NOT EXISTS plugin_call_paced (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      hour TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (company_id, plugin_id, user_id, hour)
    );

    -- The company's mapping (読み替え表), every version kept (restorable).
    CREATE TABLE IF NOT EXISTS plugin_mappings (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, version),
      FOREIGN KEY (company_id, plugin_id) REFERENCES plugin_installs(company_id, plugin_id)
    );

    -- Installed, version / key changed, turned on / off, mapping saved or restored.
    CREATE TABLE IF NOT EXISTS plugin_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL,
      change TEXT NOT NULL
    );

    -- Outside object ↔ ACB record (P5): one row per object of one connection and
    -- outside account (review §5.7: the same outside id in the fake, the real system
    -- or another account is another object). The record lives on the server only.
    CREATE TABLE IF NOT EXISTS plugin_external_links (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      object TEXT NOT NULL,
      external_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      external_updated_at TEXT,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (company_id, connection_id, account_id, object, external_id),
      UNIQUE (company_id, record_id),
      FOREIGN KEY (company_id, record_id) REFERENCES records(company_id, id)
    );

    -- Who may READ the outside system through the key broker's relay, per connection
    -- (owner, 2026-10-31): departments (members who can read its folder) and members,
    -- set by an owner / admin. No row = closed to relay reads; the plugin cannot be
    -- turned on without one. Writes never go through the relay.
    CREATE TABLE IF NOT EXISTS plugin_read_scopes (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('department', 'user')),
      subject_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, connection_id, subject_type, subject_id),
      FOREIGN KEY (company_id, plugin_id) REFERENCES plugin_installs(company_id, plugin_id)
    );

    -- A field set to write automatically needs an owner's / admin's recorded
    -- acknowledgement that no HubSpot workflow is triggered by it (owner, 2026-10-31):
    -- per field and the outside property it writes (another property needs a new one).
    CREATE TABLE IF NOT EXISTS plugin_policy_acks (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      field TEXT NOT NULL,
      property TEXT NOT NULL,
      acknowledged_by TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, field)
    );

    -- 操作の控え (P6): one row per write a plugin's typed operation makes, written
    -- BEFORE it is sent. state: pending → sent-unknown | failed | external-ok → applied,
    -- or observed (the intended values were seen, but whether ACB's write made them is
    -- not known: never undoable). Milestone 4 creates (log_meeting, create_deal): external_id is
    -- the created object's id, set once it is known (null before); record_id is null for a
    -- create of a record until the record exists (then set once); replaced_by = the operation
    -- that made it again after a lost answer (「もう一度作る」); approved_by = the person who
    -- approved it (executeApproved). Everything needed to undo is fixed at operation time:
    -- the package version / fingerprint, mapping version, connection and account, the
    -- outside properties written and their raw previous values (review §6.1).
    CREATE TABLE IF NOT EXISTS plugin_operations (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      mapping_version INTEGER NOT NULL,
      connection_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      object TEXT NOT NULL,
      external_id TEXT,
      record_id TEXT,
      actor_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'ai')),
      actor_source TEXT,
      conversation_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sent-unknown', 'external-ok', 'applied', 'observed', 'failed')),
      fields TEXT NOT NULL,
      written TEXT NOT NULL,
      previous TEXT NOT NULL,
      reason TEXT,
      undo_of TEXT,
      undone_by TEXT,
      record_version INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      replaced_by TEXT,
      approved_by TEXT,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, record_id) REFERENCES records(company_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_operations_record ON plugin_operations(company_id, record_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_plugin_history_company ON plugin_history(company_id, plugin_id, at);
`

/**
 * plugin_installs.key_id: ON DELETE SET NULL (a deleted key must not block the
 * delete — better-sqlite3 enforces foreign keys). A table made by the first
 * build of P4 is rebuilt once with its rows; the triggers are recreated by
 * migratePluginTables right after. Idempotent.
 */
export function migratePluginInstallKeyReference(conn: Database.Database): void {
  const row = conn.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plugin_installs'`).get() as { sql: string } | undefined
  if (!row || row.sql.includes('ON DELETE SET NULL')) return
  // SQLite's way to rebuild a parent table: foreign keys off (outside the
  // transaction), rebuild, check, on again.
  const fk = conn.pragma('foreign_keys', { simple: true }) as number
  conn.pragma('foreign_keys = OFF')
  try {
    conn.transaction(() => {
    conn.exec(`
      CREATE TABLE plugin_installs_rebuilt (
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        service TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        managed_since TEXT,
        key_id TEXT REFERENCES broker_keys(id) ON DELETE SET NULL,
        mapping_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (company_id, plugin_id)
      );
      DROP TRIGGER IF EXISTS plugin_mappings_company_insert;
      INSERT INTO plugin_installs_rebuilt (company_id, plugin_id, version, fingerprint, service, connection_id, account_id, enabled, managed_since,
        key_id, mapping_version, updated_at, updated_by)
        SELECT company_id, plugin_id, version, fingerprint, service, connection_id, account_id, enabled, managed_since,
          key_id, mapping_version, updated_at, updated_by FROM plugin_installs;
      DROP TABLE plugin_installs;
      ALTER TABLE plugin_installs_rebuilt RENAME TO plugin_installs;
    `)
    for (const t of ['plugin_installs', 'plugin_mappings']) {
      if ((conn.pragma(`foreign_key_check(${t})`) as unknown[]).length > 0) throw new Error('plugin_installs rebuild left a dangling reference')
    }
    })()
  } finally {
    if (fk) conn.pragma('foreign_keys = ON')
  }
}

/**
 * plugin_operations for milestone 4's creates (plugins.md "Creates"): record_id
 * and external_id may be null until known, plus replaced_by / approved_by. A
 * table made before is rebuilt once with its rows (its triggers go with it and
 * are recreated, in their milestone 4 form, by migratePluginTables right
 * after). Idempotent.
 */
export function migratePluginOperationCreates(conn: Database.Database): void {
  const columns = conn.pragma('table_info(plugin_operations)') as Array<{ name: string }>
  if (columns.length === 0 || columns.some(c => c.name === 'replaced_by')) return
  conn.transaction(() => {
    conn.pragma('defer_foreign_keys = ON')
    conn.exec(`
      DROP TRIGGER IF EXISTS plugin_operations_record_insert;
      DROP TRIGGER IF EXISTS plugin_operations_company_update;
      CREATE TABLE plugin_operations_rebuilt (
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        mapping_version INTEGER NOT NULL,
        connection_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        object TEXT NOT NULL,
        external_id TEXT,
        record_id TEXT,
        actor_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'ai')),
        actor_source TEXT,
        conversation_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent-unknown', 'external-ok', 'applied', 'observed', 'failed')),
        fields TEXT NOT NULL,
        written TEXT NOT NULL,
        previous TEXT NOT NULL,
        reason TEXT,
        undo_of TEXT,
        undone_by TEXT,
        record_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        replaced_by TEXT,
        approved_by TEXT,
        PRIMARY KEY (company_id, id),
        FOREIGN KEY (company_id, record_id) REFERENCES records(company_id, id)
      );
      INSERT INTO plugin_operations_rebuilt (company_id, id, plugin_id, operation, plugin_version, fingerprint, mapping_version, connection_id, account_id,
        object, external_id, record_id, actor_id, actor_kind, actor_source, conversation_id, state, fields, written, previous, reason, undo_of, undone_by,
        record_version, created_at, updated_at)
        SELECT company_id, id, plugin_id, operation, plugin_version, fingerprint, mapping_version, connection_id, account_id,
          object, external_id, record_id, actor_id, actor_kind, actor_source, conversation_id, state, fields, written, previous, reason, undo_of, undone_by,
          record_version, created_at, updated_at FROM plugin_operations;
      DROP TABLE plugin_operations;
      ALTER TABLE plugin_operations_rebuilt RENAME TO plugin_operations;
      CREATE INDEX IF NOT EXISTS idx_plugin_operations_record ON plugin_operations(company_id, record_id, created_at);
    `)
  })()
}

/**
 * Triggers that keep the plugin tables inside their company (案 A, like
 * scope_rules / department_managers): a mapping only under its own company's
 * install, an install's key only a company key of the same company (a plugin
 * operation of company A can never use B's key), and no row ever moves to
 * another company. Idempotent.
 */
export function migratePluginTables(conn: Database.Database): void {
  conn.exec(`
    CREATE TRIGGER IF NOT EXISTS plugin_installs_key_insert BEFORE INSERT ON plugin_installs
    WHEN NEW.key_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM broker_keys WHERE id = NEW.key_id AND company_id = NEW.company_id AND scope = 'company')
    BEGIN SELECT RAISE(ABORT, 'plugin_installs.key_id must be a company key of the same company'); END;

    CREATE TRIGGER IF NOT EXISTS plugin_installs_key_update BEFORE UPDATE OF key_id ON plugin_installs
    WHEN NEW.key_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM broker_keys WHERE id = NEW.key_id AND company_id = NEW.company_id AND scope = 'company')
    BEGIN SELECT RAISE(ABORT, 'plugin_installs.key_id must be a company key of the same company'); END;

    CREATE TRIGGER IF NOT EXISTS plugin_installs_company_update BEFORE UPDATE OF company_id ON plugin_installs
    WHEN NEW.company_id IS NOT OLD.company_id
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;

    CREATE TRIGGER IF NOT EXISTS plugin_mappings_company_insert BEFORE INSERT ON plugin_mappings
    WHEN NOT EXISTS (SELECT 1 FROM plugin_installs WHERE company_id = NEW.company_id AND plugin_id = NEW.plugin_id)
    BEGIN SELECT RAISE(ABORT, 'plugin_mappings needs the install of the same company'); END;

    CREATE TRIGGER IF NOT EXISTS plugin_mappings_company_update BEFORE UPDATE OF company_id, plugin_id ON plugin_mappings
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.plugin_id IS NOT OLD.plugin_id
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;

    -- A relay read scope names only this company's departments and members (案 A: never another company's).
    CREATE TRIGGER IF NOT EXISTS plugin_read_scopes_subject_insert BEFORE INSERT ON plugin_read_scopes
    WHEN (NEW.subject_type = 'department' AND NOT EXISTS (SELECT 1 FROM departments WHERE company_id = NEW.company_id AND id = NEW.subject_id))
      OR (NEW.subject_type = 'user' AND NOT EXISTS (SELECT 1 FROM memberships WHERE company_id = NEW.company_id AND user_id = NEW.subject_id))
    BEGIN SELECT RAISE(ABORT, 'plugin_read_scopes names a department or member of the same company'); END;

    CREATE TRIGGER IF NOT EXISTS plugin_read_scopes_company_update BEFORE UPDATE ON plugin_read_scopes
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;

    CREATE TRIGGER IF NOT EXISTS plugin_external_links_record_insert BEFORE INSERT ON plugin_external_links
    WHEN NOT EXISTS (SELECT 1 FROM records WHERE company_id = NEW.company_id AND id = NEW.record_id)
    BEGIN SELECT RAISE(ABORT, 'plugin_external_links needs a record of the same company'); END;

    CREATE TRIGGER IF NOT EXISTS plugin_external_links_company_update BEFORE UPDATE OF company_id, record_id, connection_id, account_id ON plugin_external_links
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.record_id IS NOT OLD.record_id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.account_id IS NOT OLD.account_id
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;

    -- A record (when named) of the same company; a create of a record names it once it exists.
    CREATE TRIGGER IF NOT EXISTS plugin_operations_record_insert BEFORE INSERT ON plugin_operations
    WHEN NEW.record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM records WHERE company_id = NEW.company_id AND id = NEW.record_id)
    BEGIN SELECT RAISE(ABORT, 'plugin_operations needs a record of the same company'); END;

    -- Record and outside object: set once (from null), never changed; the rest never changes.
    CREATE TRIGGER IF NOT EXISTS plugin_operations_company_update BEFORE UPDATE OF company_id, record_id, external_id, connection_id, account_id, written, previous ON plugin_operations
    WHEN NEW.company_id IS NOT OLD.company_id OR (OLD.record_id IS NOT NULL AND NEW.record_id IS NOT OLD.record_id)
      OR (OLD.external_id IS NOT NULL AND NEW.external_id IS NOT OLD.external_id) OR NEW.connection_id IS NOT OLD.connection_id
      OR NEW.account_id IS NOT OLD.account_id OR NEW.written IS NOT OLD.written OR NEW.previous IS NOT OLD.previous
      OR (NEW.record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM records WHERE company_id = NEW.company_id AND id = NEW.record_id))
    BEGIN SELECT RAISE(ABORT, 'an operation record keeps its company, record, outside object, connection and values'); END;

    CREATE TRIGGER IF NOT EXISTS plugin_history_company_update BEFORE UPDATE OF company_id ON plugin_history
    WHEN NEW.company_id IS NOT OLD.company_id
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;
  `)
}
