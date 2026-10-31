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

    -- The Google connection (milestone 4 G3, .claude/rules/google-connector.md).
    -- Behind the company handle (ports/connectors.ts). Secrets are only ever
    -- stored sealed by the key broker's vault (envelope encryption, each bound
    -- to its company and row): *_sealed holds the JSON envelope, never a value.
    -- One OAuth client (Google Cloud "internal" web app) per company.
    CREATE TABLE IF NOT EXISTS google_oauth_clients (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      secret_last4 TEXT NOT NULL,
      client_secret_sealed TEXT NOT NULL,
      domain TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );

    -- A member's permission at an outside provider (today only google): the
    -- refresh token sealed; NULL once revoked or stopped (it is never used again).
    CREATE TABLE IF NOT EXISTS connector_grants (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google')),
      grant_id TEXT NOT NULL,
      account_email TEXT NOT NULL,
      scopes TEXT NOT NULL,
      refresh_token_sealed TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'stopped')),
      status_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      PRIMARY KEY (company_id, user_id, provider),
      CHECK (status = 'active' OR refresh_token_sealed IS NULL)
    );

    -- A started 「Google で許可」: only the sha256 of the state, the PKCE
    -- verifier sealed; single use, 10 minutes.
    CREATE TABLE IF NOT EXISTS oauth_pending (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      state_hash TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google')),
      user_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      verifier_sealed TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (company_id, state_hash)
    );

    -- Every change of the client, the switch and the grants (JSON without any secret).
    CREATE TABLE IF NOT EXISTS connector_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      action TEXT NOT NULL,
      user_id TEXT,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL,
      change TEXT NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_connector_history_company ON connector_history(company_id, at);
    CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires ON oauth_pending(company_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_plugin_operations_record ON plugin_operations(company_id, record_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_plugin_history_company ON plugin_history(company_id, plugin_id, at);
    CREATE INDEX IF NOT EXISTS idx_records_company_type ON records(company_id, type);
    CREATE INDEX IF NOT EXISTS idx_records_company_path ON records(company_id, path);
    CREATE INDEX IF NOT EXISTS idx_record_links_target ON record_links(company_id, target_id);
    CREATE INDEX IF NOT EXISTS idx_record_ledger_company_at ON record_ledger(company_id, at);
    CREATE INDEX IF NOT EXISTS idx_record_ai_tokens_member ON record_ai_tokens(company_id, user_id, expires_at);
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
  migrateRecordLedgerProvenance(conn)
  migrateAgentEventSandbox(conn)
  migrateBrokerSettings(conn)
  migratePluginInstallKeyReference(conn)
  migratePluginOperationCreates(conn)
  migratePluginTables(conn)
  migrateRecordTypeSources(conn)
  // Before the seeding below: it deletes stale manager rows per company.
  migrateRuleAndManagerCompanies(conn)

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

/** The relay's internal-host exception (K4), generic services (K9) and the read-only switch, added after the broker's tables shipped. */
function migrateBrokerSettings(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(broker_settings)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('internal_hosts')) conn.exec(`ALTER TABLE broker_settings ADD COLUMN internal_hosts TEXT NOT NULL DEFAULT '[]'`)
  // A generic relay service's definition (K9): JSON { label, host, basePath, header, format }, null otherwise.
  const serviceCols = new Set((conn.prepare(`PRAGMA table_info(broker_services)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!serviceCols.has('relay')) conn.exec(`ALTER TABLE broker_services ADD COLUMN relay TEXT`)
  // The relay only reads for this service (milestone 3: HubSpot once its plugin is on): 1 / 0.
  if (!serviceCols.has('read_only')) conn.exec(`ALTER TABLE broker_services ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`)
}

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

// Helper functions for common operations
/** Add the invitation claim columns to an existing invitations table (idempotent). */
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
}

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
