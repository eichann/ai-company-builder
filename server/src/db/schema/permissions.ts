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
      subject_type TEXT NOT NULL CHECK (subject_type IN ('everyone', 'role', 'user')),
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
