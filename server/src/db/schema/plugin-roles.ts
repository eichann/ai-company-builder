/**
 * Business roles (役割, plan C3, `.claude/rules/plugin-roles.md`): who holds a
 * business plugin's role in the company, a まとまり's override, and the
 * history of both. Part of the one schema run by db/index.ts initDatabase.
 * Behind the company handle (ports/plugin-roles.ts). Member ids only.
 */
export const pluginRoleSchema = `
    -- The company's default assignment of a declared role (the FDE's admin screen).
    CREATE TABLE IF NOT EXISTS plugin_role_assignments (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      role TEXT NOT NULL,
      -- JSON array of member ids (at most 20).
      user_ids TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, role)
    );

    -- A まとまり's own holders of a role (a 案件's 責任者): wins over the company's for its work.
    CREATE TABLE IF NOT EXISTS plugin_role_overrides (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      role TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      user_ids TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, role, bundle_id)
    );

    -- Append-only: every assignment and override change, with who and when (never changed).
    CREATE TABLE IF NOT EXISTS plugin_role_history (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      role TEXT NOT NULL,
      -- NULL: the company's assignment; else the まとまり whose override changed.
      bundle_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('assign', 'override', 'clear-override')),
      user_ids TEXT NOT NULL,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_role_history ON plugin_role_history(company_id, plugin_id, role);
    CREATE TRIGGER IF NOT EXISTS plugin_role_history_no_update BEFORE UPDATE ON plugin_role_history
    BEGIN SELECT RAISE(ABORT, 'plugin_role_history is append-only'); END;
`
