import type Database from 'better-sqlite3'

/**
 * Folder permissions (scopes, rules, department managers), push rejections and private folders (server.md, private-folders.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const permissionSchema = `
    -- Permission model (shared/core/permissions.ts): write rules are enforced on push
    -- (Phase 2), read rules on private folders' scope repositories (Phase 3).
    -- A scope is a node rules attach to: path '' = the whole company, otherwise
    -- a repo-relative folder ('コンテンツ', 'コンテンツ/受講生情報'), NFC, no
    -- leading/trailing slash. repo_id NULL = in the company's main repository.
    CREATE TABLE IF NOT EXISTS scopes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('company', 'department', 'folder')),
      department_id TEXT REFERENCES departments(id) ON DELETE CASCADE,
      repo_id TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      UNIQUE(company_id, path)
    );

    CREATE TABLE IF NOT EXISTS scope_rules (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('everyone', 'role', 'department', 'group', 'user')),
      subject_id TEXT,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_write INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

    -- 部署の管理役. Management rights only: grants no file access by itself.
    CREATE TABLE IF NOT EXISTS department_managers (
      department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (department_id, user_id)
    );

    -- 「Skill を直せる人」: who may change skill / agent / command files besides
    -- owners, admins and a department's managers (shared/core/skill-files.ts).
    -- department_id NULL: the whole company. Grants no folder access by itself.
    CREATE TABLE IF NOT EXISTS skill_editors (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      department_id TEXT REFERENCES departments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_editors_company ON skill_editors(company_id, user_id) WHERE department_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_editors_department ON skill_editors(company_id, department_id, user_id) WHERE department_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS skill_editors_company_insert BEFORE INSERT ON skill_editors
    WHEN NEW.department_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'skill_editors.company_id must be the company of its department'); END;

    -- 「全員が直せる」: one switch per company. No row, or everyone = 0: only the people above.
    -- Everyone with write access then may change skill files; auto-run parts stay owner/admin.
    CREATE TABLE IF NOT EXISTS skill_editing_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      everyone INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    -- Pushes the pre-receive hook rejected (lib/push-rejections.ts).
    -- paths: JSON array of strings, capped.
    CREATE TABLE IF NOT EXISTS push_rejections (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      marker TEXT NOT NULL,
      paths TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    -- Scopes with rules whose folder is missing on the shared branch (renamed
    -- or removed by a sync push, outside the admin panel), with when that was
    -- first noticed (adapters/orphaned-scopes.ts). Derived from git and rewritten
    -- on every check; only detected_at carries information of its own.
    CREATE TABLE IF NOT EXISTS orphaned_scopes (
      scope_id TEXT PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      detected_at TEXT NOT NULL,
      commit_id TEXT NOT NULL
    );

    -- Private folders (lib/private-folders.ts). A private folder is a scope
    -- whose repo_id points here: its own bare repository
    -- (<REPOS_DIR>/<company_id>.scopes/<id>.git), served only to members who
    -- may read the scope; its path is reserved in the company repository.
    -- No FOREIGN KEY to scopes: a scope row must never take its repository's
    -- record with it silently (deleting a department that contains one is
    -- refused; only make-public removes both).
    CREATE TABLE IF NOT EXISTS scope_repos (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      scope_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

    -- UNUSED since 2026-10-22: per-company salts for the reserved-path hashes
    -- GET /me/scopes used to hand out (salted hashes of short Japanese folder
    -- names can be brute-forced, so the server no longer sends them; the app
    -- asks POST /paths/check instead). Kept so existing databases need no
    -- destructive migration; nothing reads or writes it.
    CREATE TABLE IF NOT EXISTS company_path_salts (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Private folders archived (git bundle written by lib/private-folders.ts,
    -- recorded by adapters/private-folders.ts) before being deleted or made public: who, when,
    -- and the bundle's file name inside the archive directory (never served).
    CREATE TABLE IF NOT EXISTS private_folder_archives (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      path TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('delete', 'make-public')),
      file TEXT NOT NULL,
      head TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

    -- 見える人のまとまり (groups, server.md "Groups"): a named set of members of one
    -- company, kept by owners/admins. A rule may name one (subject 'group'); who
    -- is in it is read with the rules (memberIds), never stored on the rule. A
    -- group holds members only (no nesting) and exactly those put in it.
    CREATE TABLE IF NOT EXISTS member_groups (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      -- NFC + A–Z folded (shared/core/paths.ts nameKey): one name once per company.
      name_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      UNIQUE(company_id, name_key)
    );

    CREATE TABLE IF NOT EXISTS member_group_members (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      added_by TEXT,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_member_group_members_company_user ON member_group_members(company_id, user_id);

    CREATE TRIGGER IF NOT EXISTS member_group_members_company_insert BEFORE INSERT ON member_group_members
    WHEN NEW.company_id IS NOT (SELECT company_id FROM member_groups WHERE id = NEW.group_id)
    BEGIN SELECT RAISE(ABORT, 'member_group_members.company_id must be the company of its group'); END;

    CREATE TRIGGER IF NOT EXISTS member_group_members_company_update BEFORE UPDATE OF company_id, group_id ON member_group_members
    WHEN NEW.company_id IS NOT (SELECT company_id FROM member_groups WHERE id = NEW.group_id)
    BEGIN SELECT RAISE(ABORT, 'member_group_members.company_id must be the company of its group'); END;

    -- Who changed groups and permission rules, when, and what (append-only;
    -- services/groups.ts, services/permission-editor.ts). detail: JSON — the
    -- group's name / member ids, or a place's path with its rules before and
    -- after. Never served by an endpoint yet: the record is for the owner and
    -- the operator (a page to read it is later work).
    CREATE TABLE IF NOT EXISTS permission_history (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_permission_history_company ON permission_history(company_id, seq);
    CREATE TRIGGER IF NOT EXISTS permission_history_no_update BEFORE UPDATE ON permission_history
    BEGIN SELECT RAISE(ABORT, 'permission_history is append-only'); END;

    CREATE INDEX IF NOT EXISTS idx_scope_repos_company_id ON scope_repos(company_id);
    CREATE INDEX IF NOT EXISTS idx_scopes_department_id ON scopes(department_id);
    CREATE INDEX IF NOT EXISTS idx_scope_rules_scope_id ON scope_rules(scope_id);
    CREATE INDEX IF NOT EXISTS idx_department_managers_user_id ON department_managers(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_rejections_company_created ON push_rejections(company_id, created_at);
`

/**
 * company_id on scope_rules and department_managers (multi-tenant foundation
 * 案 A, `.claude/rules/server.md` "Company handle"). Before, these two tables
 * reached their company only through the parent row (scope / department).
 *
 * Additive, so an older server build keeps working on a database this one has
 * initialized (it inserts rows without the column):
 * - the column is added nullable (ALTER TABLE cannot add NOT NULL without a
 *   default) with an index;
 * - backfill from the parent row, every startup, for rows still without it;
 *   rows whose parent is gone belong to no company and no query can reach
 *   them (every read joins or filters by the parent): they are removed;
 * - triggers make the column non-null and correct for every new row: an
 *   INSERT that names a company other than the parent's is refused, one
 *   that leaves it out gets the parent's company (older builds), and no
 *   UPDATE may clear it or move a row under another company's parent.
 * Idempotent. Returns what the backfill did (tests; the startup log).
 */
export function migrateRuleAndManagerCompanies(conn: Database.Database): {
  rulesBackfilled: number; rulesRemoved: number; managersBackfilled: number; managersRemoved: number
} {
  const columns = (table: string) => new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  return conn.transaction(() => {
    if (!columns('scope_rules').has('company_id')) {
      conn.exec(`ALTER TABLE scope_rules ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE`)
    }
    if (!columns('department_managers').has('company_id')) {
      conn.exec(`ALTER TABLE department_managers ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE`)
    }
    conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_scope_rules_company ON scope_rules(company_id, scope_id);
      CREATE INDEX IF NOT EXISTS idx_department_managers_company ON department_managers(company_id, user_id);
    `)

    const rulesRemoved = conn.prepare(`
      DELETE FROM scope_rules WHERE company_id IS NULL AND scope_id NOT IN (SELECT id FROM scopes)
    `).run().changes
    const rulesBackfilled = conn.prepare(`
      UPDATE scope_rules SET company_id = (SELECT s.company_id FROM scopes s WHERE s.id = scope_rules.scope_id)
      WHERE company_id IS NULL
    `).run().changes
    const managersRemoved = conn.prepare(`
      DELETE FROM department_managers WHERE company_id IS NULL AND department_id NOT IN (SELECT id FROM departments)
    `).run().changes
    const managersBackfilled = conn.prepare(`
      UPDATE department_managers SET company_id = (SELECT d.company_id FROM departments d WHERE d.id = department_managers.department_id)
      WHERE company_id IS NULL
    `).run().changes

    conn.exec(`
      CREATE TRIGGER IF NOT EXISTS scope_rules_company_insert BEFORE INSERT ON scope_rules
      WHEN NEW.company_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM scopes WHERE id = NEW.scope_id)
      BEGIN SELECT RAISE(ABORT, 'scope_rules.company_id must be the company of its scope'); END;

      CREATE TRIGGER IF NOT EXISTS scope_rules_company_fill AFTER INSERT ON scope_rules
      WHEN NEW.company_id IS NULL
      BEGIN UPDATE scope_rules SET company_id = (SELECT company_id FROM scopes WHERE id = NEW.scope_id) WHERE rowid = NEW.rowid; END;

      CREATE TRIGGER IF NOT EXISTS scope_rules_company_update BEFORE UPDATE OF company_id, scope_id ON scope_rules
      WHEN NEW.company_id IS NULL OR NEW.company_id IS NOT (SELECT company_id FROM scopes WHERE id = NEW.scope_id)
      BEGIN SELECT RAISE(ABORT, 'scope_rules.company_id must be the company of its scope'); END;

      CREATE TRIGGER IF NOT EXISTS department_managers_company_insert BEFORE INSERT ON department_managers
      WHEN NEW.company_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
      BEGIN SELECT RAISE(ABORT, 'department_managers.company_id must be the company of its department'); END;

      CREATE TRIGGER IF NOT EXISTS department_managers_company_fill AFTER INSERT ON department_managers
      WHEN NEW.company_id IS NULL
      BEGIN UPDATE department_managers SET company_id = (SELECT company_id FROM departments WHERE id = NEW.department_id) WHERE rowid = NEW.rowid; END;

      CREATE TRIGGER IF NOT EXISTS department_managers_company_update BEFORE UPDATE OF company_id, department_id ON department_managers
      WHEN NEW.company_id IS NULL OR NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
      BEGIN SELECT RAISE(ABORT, 'department_managers.company_id must be the company of its department'); END;
    `)

    const done = { rulesBackfilled, rulesRemoved, managersBackfilled, managersRemoved }
    if (Object.values(done).some(n => n > 0)) {
      // Counts only: no company, folder or user is named.
      console.log(`[db] company_id on rules/managers: ${rulesBackfilled} rules and ${managersBackfilled} managers backfilled, ${rulesRemoved} rules and ${managersRemoved} managers without a parent removed`)
    }
    return done
  })()
}

/**
 * The rule subject 'department' (the people who belong to a department, 所属;
 * shared/core/permissions.ts). Two parts, both idempotent:
 *
 * - A database created before it has `CHECK (subject_type IN ('everyone',
 *   'role', 'user'))` on scope_rules, which SQLite cannot alter: the table is
 *   rebuilt once with the wider CHECK (rows, ids, created_at/by and company_id
 *   kept; rowid order kept, so rules stay oldest first), then its indexes and
 *   the company triggers are created again (migrateRuleAndManagerCompanies).
 *   Only the CHECK is widened, so an older server build keeps working on the
 *   database; it never inserts a department rule, and one it reads matches no
 *   one there (its push checker refuses an unknown subject: [HOOK_ERROR],
 *   never a wrong allow).
 * - Triggers: a department rule names a department of the rule's own company
 *   (never another company's, never none), and keeps naming one.
 *
 * Runs after migrateRuleAndManagerCompanies (needs company_id).
 */
/** scope_rules' table SQL ('' before the table exists). */
function scopeRulesSql(conn: Database.Database): string {
  return (conn.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scope_rules'`).get() as { sql: string } | undefined)?.sql ?? ''
}

/**
 * Rebuild scope_rules with the CHECK of today's subjects (rows, ids,
 * created_at/by, company_id and rowid order kept), then its index, the company
 * triggers and the subject triggers again (they went with the old table).
 */
function rebuildScopeRules(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE scope_rules_rebuilt (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('everyone', 'role', 'department', 'group', 'user')),
      subject_id TEXT,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_write INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT,
      company_id TEXT REFERENCES companies(id) ON DELETE CASCADE
    );
    INSERT INTO scope_rules_rebuilt (rowid, id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by, company_id)
      SELECT rowid, id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by, company_id FROM scope_rules;
    DROP TABLE scope_rules;
    ALTER TABLE scope_rules_rebuilt RENAME TO scope_rules;
    CREATE INDEX IF NOT EXISTS idx_scope_rules_scope_id ON scope_rules(scope_id);
  `)
  migrateRuleAndManagerCompanies(conn)
}

export function migrateDepartmentRuleSubject(conn: Database.Database): { rebuilt: boolean } {
  const sql = scopeRulesSql(conn)
  const rebuilt = sql !== '' && !sql.includes("'department'")
  conn.transaction(() => {
    // The rebuild takes today's CHECK (group included), so migrateGroupRuleSubject finds nothing to do.
    if (rebuilt) rebuildScopeRules(conn)
    conn.exec(`

      CREATE TRIGGER IF NOT EXISTS scope_rules_department_insert BEFORE INSERT ON scope_rules
      WHEN NEW.subject_type = 'department' AND NOT EXISTS (
        SELECT 1 FROM departments WHERE id = NEW.subject_id
          AND company_id = COALESCE(NEW.company_id, (SELECT company_id FROM scopes WHERE id = NEW.scope_id)))
      BEGIN SELECT RAISE(ABORT, 'a department rule names a department of the same company'); END;

      CREATE TRIGGER IF NOT EXISTS scope_rules_department_update BEFORE UPDATE OF subject_type, subject_id, company_id, scope_id ON scope_rules
      WHEN NEW.subject_type = 'department' AND NOT EXISTS (
        SELECT 1 FROM departments WHERE id = NEW.subject_id AND company_id = NEW.company_id)
      BEGIN SELECT RAISE(ABORT, 'a department rule names a department of the same company'); END;
    `)
  })()
  if (rebuilt) console.log('[db] scope_rules rebuilt for department rules')
  return { rebuilt }
}

/**
 * The rule subject 'group' (見える人のまとまり, member_groups; shared/core/permissions.ts).
 * Like migrateDepartmentRuleSubject, idempotent:
 *
 * - A database whose scope_rules CHECK does not know 'group' is rebuilt once
 *   (every row kept, in order), then the company and department triggers are
 *   made again. An older server build keeps working on the database: it never
 *   inserts a group rule, and one it reads matches no one (fails closed).
 * - Triggers: a group rule names a group of the rule's own company (never
 *   another company's, never none), and keeps naming one.
 *
 * Runs after migrateDepartmentRuleSubject.
 */
export function migrateGroupRuleSubject(conn: Database.Database): { rebuilt: boolean } {
  const sql = scopeRulesSql(conn)
  const rebuilt = sql !== '' && !sql.includes("'group'")
  conn.transaction(() => {
    if (rebuilt) {
      rebuildScopeRules(conn)
      // The department triggers went with the old table.
      migrateDepartmentRuleSubject(conn)
    }
    conn.exec(`
      CREATE TRIGGER IF NOT EXISTS scope_rules_group_insert BEFORE INSERT ON scope_rules
      WHEN NEW.subject_type = 'group' AND NOT EXISTS (
        SELECT 1 FROM member_groups WHERE id = NEW.subject_id
          AND company_id = COALESCE(NEW.company_id, (SELECT company_id FROM scopes WHERE id = NEW.scope_id)))
      BEGIN SELECT RAISE(ABORT, 'a group rule names a group of the same company'); END;

      CREATE TRIGGER IF NOT EXISTS scope_rules_group_update BEFORE UPDATE OF subject_type, subject_id, company_id, scope_id ON scope_rules
      WHEN NEW.subject_type = 'group' AND NOT EXISTS (
        SELECT 1 FROM member_groups WHERE id = NEW.subject_id AND company_id = NEW.company_id)
      BEGIN SELECT RAISE(ABORT, 'a group rule names a group of the same company'); END;
    `)
  })()
  if (rebuilt) console.log('[db] scope_rules rebuilt for group rules')
  return { rebuilt }
}
