import type Database from 'better-sqlite3'

/**
 * Companies, members, invitations, departments and the desktop-app activity (server.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const companySchema = `
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      repo_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- The shared company folder (shared/core/company-folder.ts): git = repository + sync, none = no folder.
      folder_kind TEXT NOT NULL DEFAULT 'git' CHECK (folder_kind IN ('git', 'none'))
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
`

/** Add the invitation claim and 所属 columns to an existing invitations table (idempotent). */
export function migrateInvitationClaims(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(invitations)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('signup_claimed_at')) conn.exec(`ALTER TABLE invitations ADD COLUMN signup_claimed_at TEXT`)
  if (!cols.has('signup_user_id')) conn.exec(`ALTER TABLE invitations ADD COLUMN signup_user_id TEXT`)
  // The departments the invitee will belong to (所属), chosen by who invited them: JSON list of
  // department ids of this company, added to department_members when the link is accepted.
  if (!cols.has('department_ids')) conn.exec(`ALTER TABLE invitations ADD COLUMN department_ids TEXT NOT NULL DEFAULT '[]'`)
}

/**
 * The company folder's kind (owner decision 2026-11-07, shared/core/company-folder.ts): every
 * company made before it has the company repository, so the column's default `git` is theirs
 * (and what an older build gets when it inserts without the column). Idempotent.
 */
export function migrateCompanyFolderKind(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(companies)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('folder_kind')) {
    conn.exec(`ALTER TABLE companies ADD COLUMN folder_kind TEXT NOT NULL DEFAULT 'git' CHECK (folder_kind IN ('git', 'none'))`)
  }
}
