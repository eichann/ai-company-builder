import type Database from 'better-sqlite3'

/**
 * The Google connection and member-level OAuth grants (google-connector.md, member-oauth.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const connectorSchema = `
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

    -- A member's permission at an outside provider (member-oauth.md): the
    -- refresh token sealed; NULL once revoked or stopped (it is never used again).
    -- features_off: the provider's features the member turned off (JSON list).
    -- The provider list is repeated in migrateConnectorProviders and ports/connectors.ts.
    CREATE TABLE IF NOT EXISTS connector_grants (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'slack')),
      grant_id TEXT NOT NULL,
      account_email TEXT NOT NULL,
      scopes TEXT NOT NULL,
      features_off TEXT NOT NULL DEFAULT '[]',
      refresh_token_sealed TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'stopped')),
      status_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      PRIMARY KEY (company_id, user_id, provider),
      CHECK (status = 'active' OR refresh_token_sealed IS NULL)
    );

    -- A started 「… で許可」: only the sha256 of the state, the PKCE
    -- verifier sealed; single use, 10 minutes.
    CREATE TABLE IF NOT EXISTS oauth_pending (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      state_hash TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'slack')),
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

    -- Google Drive (google-drive.md): what a person picked with Google Picker
    -- (only these may be read or written into by ACB; drive.file holds Google to
    -- the same) — Google's ids, the name and type Google gave; expires.
    CREATE TABLE IF NOT EXISTS google_drive_picks (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      picked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, file_id)
    );

    -- Google Drive puts (操作の控え): written before the upload; one per member
    -- and request key (the same put is never sent twice). Never content or a
    -- local path. state: sending → done | unknown (a lost answer; found later
    -- by the put's id in appProperties, never re-sent). A refused put is removed.
    CREATE TABLE IF NOT EXISTS google_drive_puts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('ai', 'person')),
      conversation_id TEXT,
      run_id TEXT,
      folder_id TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('sending', 'done', 'unknown')),
      file_id TEXT,
      revision_id TEXT,
      link TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (company_id, user_id, request_key)
    );

    -- Which core connector serves a role when two could (connector-roles.md; the
    -- admin chooses once). The history is in connector_history (provider 'roles').
    CREATE TABLE IF NOT EXISTS connector_role_choices (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, role)
    );

    CREATE INDEX IF NOT EXISTS idx_connector_history_company ON connector_history(company_id, at);
    CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires ON oauth_pending(company_id, expires_at);
`

/**
 * Google Picker's registration on the company's Google client (google-drive.md),
 * added after the table shipped. The API key is the Picker's developer key: it
 * is sent to the Picker page by design (Google protects it with the key's
 * website restriction), so it is stored as is; answers show its last 4 only.
 */
export function migrateGooglePicker(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(google_oauth_clients)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('picker_api_key')) conn.exec('ALTER TABLE google_oauth_clients ADD COLUMN picker_api_key TEXT')
  if (!cols.has('picker_app_id')) conn.exec('ALTER TABLE google_oauth_clients ADD COLUMN picker_app_id TEXT')
}

/**
 * connector_grants / oauth_pending for every member-level OAuth provider
 * (member-oauth.md): the provider CHECK lists slack too, and a grant carries
 * features_off. SQLite cannot change a CHECK, so a table made before is
 * rebuilt once with its rows (nothing references either table). Idempotent.
 */
export function migrateConnectorProviders(conn: Database.Database): void {
  const sqlOf = (t: string) => (conn.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) as { sql: string } | undefined)?.sql
  const grants = sqlOf('connector_grants')
  if (grants && !grants.includes("'slack'")) {
    conn.transaction(() => {
      conn.exec(`
        CREATE TABLE connector_grants_rebuilt (
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('google', 'slack')),
          grant_id TEXT NOT NULL,
          account_email TEXT NOT NULL,
          scopes TEXT NOT NULL,
          features_off TEXT NOT NULL DEFAULT '[]',
          refresh_token_sealed TEXT,
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'stopped')),
          status_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT,
          PRIMARY KEY (company_id, user_id, provider),
          CHECK (status = 'active' OR refresh_token_sealed IS NULL)
        );
        INSERT INTO connector_grants_rebuilt (company_id, user_id, provider, grant_id, account_email, scopes, refresh_token_sealed, status, status_reason,
          created_at, updated_at, last_used_at)
          SELECT company_id, user_id, provider, grant_id, account_email, scopes, refresh_token_sealed, status, status_reason,
            created_at, updated_at, last_used_at FROM connector_grants;
        DROP TABLE connector_grants;
        ALTER TABLE connector_grants_rebuilt RENAME TO connector_grants;
      `)
    })()
  }
  const pending = sqlOf('oauth_pending')
  if (pending && !pending.includes("'slack'")) {
    conn.transaction(() => {
      conn.exec(`
        CREATE TABLE oauth_pending_rebuilt (
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          state_hash TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('google', 'slack')),
          user_id TEXT NOT NULL,
          scopes TEXT NOT NULL,
          verifier_sealed TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (company_id, state_hash)
        );
        INSERT INTO oauth_pending_rebuilt (company_id, state_hash, provider, user_id, scopes, verifier_sealed, created_at, expires_at)
          SELECT company_id, state_hash, provider, user_id, scopes, verifier_sealed, created_at, expires_at FROM oauth_pending;
        DROP TABLE oauth_pending;
        ALTER TABLE oauth_pending_rebuilt RENAME TO oauth_pending;
        CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires ON oauth_pending(company_id, expires_at);
      `)
    })()
  }
}
