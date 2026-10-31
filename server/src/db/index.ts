import Database from 'better-sqlite3'
import fs from 'fs'
import { seedPermissionScopes } from '../adapters/sqlite/permission-store'
import { APP_DB_PATH, DATA_DIR } from '../lib/config'

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const dbPath = APP_DB_PATH
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

    -- The AI action log (monitoring M1, services/agent-events.ts): one row per
    -- tool call an agent made in a member's app — metadata only, never content
    -- (shared/types/agent-events.ts). id comes from the app (re-sends are
    -- ignored), user_id from the session. at = the app's time, or received_at
    -- when that was implausible (at_adjusted = 1; client_at keeps what it said).
    -- target: the target as JSON; target_text: its searchable parts, one per
    -- line; target_roots / department_key: first path segments (NFC, A–Z
    -- folded) between newlines, for a manager's department scope.
    CREATE TABLE IF NOT EXISTS agent_events (
      seq INTEGER PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      at TEXT NOT NULL,
      client_at TEXT NOT NULL,
      at_adjusted INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL,
      call_id TEXT NOT NULL,
      duration_ms INTEGER,
      conversation_id TEXT,
      turn_id TEXT,
      department TEXT,
      department_key TEXT,
      agent TEXT NOT NULL,
      model TEXT,
      subagent_type TEXT,
      tool TEXT NOT NULL,
      category TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target TEXT NOT NULL,
      target_text TEXT NOT NULL DEFAULT '',
      target_roots TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      guard_reason TEXT,
      outcome TEXT,
      client_version TEXT,
      UNIQUE (company_id, id)
    );

    -- The log's settings per company (defaults apply while no row exists).
    CREATE TABLE IF NOT EXISTS agent_event_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      retention_days INTEGER NOT NULL DEFAULT 180,
      viewers TEXT NOT NULL DEFAULT 'admins' CHECK (viewers IN ('admins', 'admins-and-managers')),
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    -- Every change of those settings: who, when, before → after (JSON).
    CREATE TABLE IF NOT EXISTS agent_event_settings_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      before TEXT NOT NULL,
      after TEXT NOT NULL
    );

    -- The AI sandbox setting per company (「AI の囲い」; defaults apply while no row exists).
    CREATE TABLE IF NOT EXISTS agent_sandbox_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    -- A member whose sandbox mode differs from the company's (staged rollout).
    CREATE TABLE IF NOT EXISTS agent_sandbox_overrides (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('off', 'observe', 'enforce')),
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id)
    );

    -- Every change of the setting or an override: who, when, what (JSON).
    CREATE TABLE IF NOT EXISTS agent_sandbox_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      change TEXT NOT NULL
    );

    -- The emergency stop (monitoring M2, .claude/rules/agent-stop.md): one row per
    -- stop an owner/admin made. user_id NULL = everyone; tool NULL = the whole AI
    -- (else command / write / web / mcp-external). released_at NULL = in force.
    -- Rows are never deleted: released ones are the history.
    CREATE TABLE IF NOT EXISTS agent_stops (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT,
      tool TEXT CHECK (tool IS NULL OR tool IN ('command', 'write', 'web', 'mcp-external')),
      reason TEXT NOT NULL DEFAULT '',
      stopped_at TEXT NOT NULL,
      stopped_by TEXT NOT NULL,
      released_at TEXT,
      released_by TEXT
    );

    -- The last time a member's app said it follows the stop (X-ACB-Agent-Stop on
    -- GET /me/agent-policy or /me/events), with its build: older apps never do,
    -- which the admin's 「停止に対応していないアプリ」 count is built from.
    CREATE TABLE IF NOT EXISTS agent_stop_clients (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      client_version TEXT,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id)
    );

    -- The API key broker (.claude/rules/key-broker.md). A key's value is only
    -- ever stored sealed: AES-256-GCM under its own data key, the data key
    -- wrapped by the key-encryption key named in kek_id (envelope encryption).
    CREATE TABLE IF NOT EXISTS broker_keys (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('company', 'user')),
      owner_user_id TEXT,
      service TEXT NOT NULL,
      display_name TEXT NOT NULL,
      last4 TEXT NOT NULL,
      cipher_scheme TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      tag TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      kek_id TEXT NOT NULL,
      destinations TEXT NOT NULL,
      audience TEXT NOT NULL,
      caps TEXT NOT NULL,
      allow_private_content INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      secret_updated_at TEXT NOT NULL,
      CHECK ((scope = 'company') = (owner_user_id IS NULL))
    );

    -- Per service: which key a request uses and where members' own keys may go
    -- (defaults apply while no row exists).
    CREATE TABLE IF NOT EXISTS broker_services (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      service TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('person', 'tool', 'system')),
      rule TEXT NOT NULL CHECK (rule IN ('company-only', 'user-only', 'company-first')),
      own_key_hosts TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, service)
    );

    -- Whether members may register their own keys (default on while no row exists).
    -- The relay's daily use per key and member (K5 caps): requests counted
    -- when forwarded, tokens when the answer ends. day = YYYY-MM-DD in the
    -- broker's day (BROKER_DAY_UTC_OFFSET_MINUTES, default Japan).
    CREATE TABLE IF NOT EXISTS broker_usage (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, key_id, user_id, day)
    );

    CREATE TABLE IF NOT EXISTS broker_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      member_keys_allowed INTEGER NOT NULL,
      -- JSON array of hosts the relay may reach although they resolve to a
      -- private / internal address (the admin's explicit exception, K4).
      internal_hosts TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );

    -- Every change of a key, a service rule or the setting: who, when, what
    -- (JSON without any secret; a replaced key shows its last 4 characters).
    CREATE TABLE IF NOT EXISTS broker_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      key_id TEXT,
      action TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      change TEXT NOT NULL
    );

    -- Short-lived tokens the app hands the chat's child processes: only the
    -- sha256 of the value is stored.
    CREATE TABLE IF NOT EXISTS broker_tokens (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      services TEXT NOT NULL,
      department TEXT,
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_agent_events_company_at ON agent_events(company_id, at);
    CREATE INDEX IF NOT EXISTS idx_agent_events_company_user_at ON agent_events(company_id, user_id, at);
    CREATE INDEX IF NOT EXISTS idx_agent_events_company_conversation_at ON agent_events(company_id, conversation_id, at);
    CREATE INDEX IF NOT EXISTS idx_agent_event_settings_history_company ON agent_event_settings_history(company_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_agent_sandbox_history_company ON agent_sandbox_history(company_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_agent_stops_company ON agent_stops(company_id, released_at, stopped_at);
    CREATE INDEX IF NOT EXISTS idx_broker_keys_company ON broker_keys(company_id, service);
    CREATE INDEX IF NOT EXISTS idx_broker_history_company ON broker_history(company_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_broker_tokens_member ON broker_tokens(company_id, user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_broker_tokens_expires ON broker_tokens(expires_at);
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

  // Single-use invitation links (services/invitations.ts signUp).
  migrateInvitationClaims(conn)
  migrateAgentEventSandbox(conn)
  migrateBrokerSettings(conn)

  // Company scope + default `everyone: read + write` rule, one scope per
  // department. Idempotent; repairs drift left by older server builds.
  seedPermissionScopes(conn)

  if (conn === sqlite) console.log('Application database initialized at:', dbPath)
}

/** The AI sandbox's marks on logged events (「AI の囲い」, added after the log shipped). */
function migrateAgentEventSandbox(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(agent_events)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('sandbox')) conn.exec(`ALTER TABLE agent_events ADD COLUMN sandbox TEXT`)
  if (!cols.has('skill')) conn.exec(`ALTER TABLE agent_events ADD COLUMN skill TEXT`)
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_agent_events_company_sandbox ON agent_events(company_id, at) WHERE sandbox IS NOT NULL OR guard_reason IN ('denied-read', 'sandbox')`)
}

/** The relay's internal-host exception (K4) and generic services (K9), added after the broker's tables shipped. */
function migrateBrokerSettings(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(broker_settings)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('internal_hosts')) conn.exec(`ALTER TABLE broker_settings ADD COLUMN internal_hosts TEXT NOT NULL DEFAULT '[]'`)
  // A generic relay service's definition (K9): JSON { label, host, basePath, header, format }, null otherwise.
  const serviceCols = new Set((conn.prepare(`PRAGMA table_info(broker_services)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!serviceCols.has('relay')) conn.exec(`ALTER TABLE broker_services ADD COLUMN relay TEXT`)
}

// Helper functions for common operations
/** Add the invitation claim columns to an existing invitations table (idempotent). */
export function migrateInvitationClaims(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(invitations)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('signup_claimed_at')) conn.exec(`ALTER TABLE invitations ADD COLUMN signup_claimed_at TEXT`)
  if (!cols.has('signup_user_id')) conn.exec(`ALTER TABLE invitations ADD COLUMN signup_user_id TEXT`)
}

export function generateId(): string {
  return crypto.randomUUID()
}

export function now(): string {
  return new Date().toISOString()
}
