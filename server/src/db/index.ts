import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { seedPermissionScopes } from '../lib/permission-store'
import { migrateInvitationClaims } from '../lib/invitation-signup'

// Ensure data directory exists
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const dbPath = path.join(dataDir, 'app.sqlite')
const sqlite = new Database(dbPath)

// Enable WAL mode for better concurrent access
sqlite.pragma('journal_mode = WAL')

// Export the raw SQLite connection for direct queries
export const db = sqlite

// Initialize application tables (separate from Better Auth tables).
// Takes the connection so tests can run it against a copy of an older database.
// Every change here must stay additive: an older server build must keep
// working on a database this version has initialized.
export function initDatabase(conn: Database.Database = sqlite) {
  conn.exec(`
    -- Application tables
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      repo_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, company_id)
    );

    CREATE TABLE IF NOT EXISTS ssh_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      device_name TEXT,
      is_active INTEGER DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',
      created_by TEXT NOT NULL,
      used_by TEXT,
      used_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES departments(id) ON DELETE CASCADE,

      name TEXT NOT NULL,
      name_en TEXT,
      folder TEXT NOT NULL,

      icon TEXT NOT NULL DEFAULT 'Folder',
      color TEXT NOT NULL DEFAULT '#6366f1',
      description TEXT,

      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,

      UNIQUE(company_id, folder),
      UNIQUE(company_id, parent_id, name)
    );

    -- Which desktop-app build each member last used, and when they last
    -- talked to / fetched from / pushed to the company (lib/client-activity.ts).
    -- client_version / client_platform are NULL when the client did not
    -- identify itself (builds older than the X-ACB-Client-Version header).
    CREATE TABLE IF NOT EXISTS client_activity (
      user_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      client_version TEXT,
      client_platform TEXT,
      last_seen_at TEXT,
      last_fetch_at TEXT,
      last_push_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, company_id)
    );

    -- Permission model (lib/permissions.ts): write rules are enforced on push
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

    -- 部署の責任者. Management rights only: grants no file access by itself.
    CREATE TABLE IF NOT EXISTS department_managers (
      department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (department_id, user_id)
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
    -- first noticed (lib/orphaned-scopes.ts). Derived from git and rewritten
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

    -- Private folders archived (git bundle, lib/private-folders.ts
    -- archivePrivateFolder) before being deleted or made public: who, when,
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

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_scope_repos_company_id ON scope_repos(company_id);
    CREATE INDEX IF NOT EXISTS idx_scopes_department_id ON scopes(department_id);
    CREATE INDEX IF NOT EXISTS idx_scope_rules_scope_id ON scope_rules(scope_id);
    CREATE INDEX IF NOT EXISTS idx_department_managers_user_id ON department_managers(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_rejections_company_created ON push_rejections(company_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_client_activity_company_id ON client_activity(company_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_company_id ON memberships(company_id);
    CREATE INDEX IF NOT EXISTS idx_ssh_keys_user_id ON ssh_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_ssh_keys_fingerprint ON ssh_keys(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
    CREATE INDEX IF NOT EXISTS idx_invitations_company_id ON invitations(company_id);
    CREATE INDEX IF NOT EXISTS idx_departments_company_id ON departments(company_id);
    CREATE INDEX IF NOT EXISTS idx_departments_parent_id ON departments(parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_company_folder ON departments(company_id, folder);
  `)

  // Single-use invitation links (lib/invitation-signup.ts).
  migrateInvitationClaims(conn)

  // Company scope + default `everyone: read + write` rule, one scope per
  // department. Idempotent; repairs drift left by older server builds.
  seedPermissionScopes(conn)

  if (conn === sqlite) console.log('Application database initialized at:', dbPath)
}

// Helper functions for common operations
export function generateId(): string {
  return crypto.randomUUID()
}

export function now(): string {
  return new Date().toISOString()
}
