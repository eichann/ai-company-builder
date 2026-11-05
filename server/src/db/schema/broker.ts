import type Database from 'better-sqlite3'

/**
 * The API key broker: sealed keys, service rules, usage, settings, history, tokens (key-broker.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const brokerSchema = `
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

    CREATE INDEX IF NOT EXISTS idx_broker_keys_company ON broker_keys(company_id, service);
    CREATE INDEX IF NOT EXISTS idx_broker_history_company ON broker_history(company_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_broker_tokens_member ON broker_tokens(company_id, user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_broker_tokens_expires ON broker_tokens(expires_at);
`

/** The relay's internal-host exception (K4), generic services (K9), the read-only switch and the chosen key, added after the broker's tables shipped. */
export function migrateBrokerSettings(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(broker_settings)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('internal_hosts')) conn.exec(`ALTER TABLE broker_settings ADD COLUMN internal_hosts TEXT NOT NULL DEFAULT '[]'`)
  // A generic relay service's definition (K9): JSON { label, host, basePath, header, format }, null otherwise.
  const serviceCols = new Set((conn.prepare(`PRAGMA table_info(broker_services)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!serviceCols.has('relay')) conn.exec(`ALTER TABLE broker_services ADD COLUMN relay TEXT`)
  // The relay only reads for this service (milestone 3: HubSpot once its plugin is on): 1 / 0.
  if (!serviceCols.has('read_only')) conn.exec(`ALTER TABLE broker_services ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`)
  // Whether `read_only` is the company's choice (1) or never chosen (0: `brokerRelayReadOnlyByDefault`,
  // audit B-M6: read-only but for an AI model's API). What a company already uses keeps working as it
  // does (owner: harden without hurting today's work — e.g. a skill that writes HubSpot through the
  // relay before its plugin is on): a row that was read-only, a generic service, or a service with a
  // key already registered stays as it is, as the company's choice (the admin sees the switch); a key
  // registered from now on reads only until an admin allows writes.
  if (!serviceCols.has('read_only_set')) {
    conn.transaction(() => {
      conn.exec(`ALTER TABLE broker_services ADD COLUMN read_only_set INTEGER NOT NULL DEFAULT 0`)
      conn.exec(`UPDATE broker_services SET read_only_set = 1 WHERE relay IS NOT NULL OR read_only = 1
        OR EXISTS (SELECT 1 FROM broker_keys k WHERE k.company_id = broker_services.company_id AND k.service = broker_services.service)`)
      // A built-in service with keys and no row yet (its settings were the defaults): writes kept.
      conn.exec(`INSERT OR IGNORE INTO broker_services (company_id, service, category, rule, own_key_hosts, read_only, read_only_set, updated_at, updated_by)
        SELECT DISTINCT company_id, service, CASE service WHEN 'hubspot' THEN 'system' ELSE 'tool' END, 'company-only', '[]', 0, 1,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'acb:migration'
        FROM broker_keys WHERE service NOT IN ('gemini', 'openai', 'anthropic')`)
    })()
  }
  // The company key the admin chose for the service when several exist (key-broker.md "Which company key"); null = none chosen.
  if (!serviceCols.has('default_key_id')) conn.exec(`ALTER TABLE broker_services ADD COLUMN default_key_id TEXT`)
}
