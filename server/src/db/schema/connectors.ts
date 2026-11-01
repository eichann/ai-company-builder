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

    CREATE INDEX IF NOT EXISTS idx_connector_history_company ON connector_history(company_id, at);
    CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires ON oauth_pending(company_id, expires_at);
`

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
