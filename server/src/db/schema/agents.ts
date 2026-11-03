import type Database from 'better-sqlite3'

/**
 * The AI action log, the AI sandbox setting and the emergency stop (agent-events.md, agent-sandbox.md, agent-stop.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const agentSchema = `
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

    CREATE INDEX IF NOT EXISTS idx_agent_events_company_at ON agent_events(company_id, at);
    CREATE INDEX IF NOT EXISTS idx_agent_events_company_user_at ON agent_events(company_id, user_id, at);
    CREATE INDEX IF NOT EXISTS idx_agent_events_company_conversation_at ON agent_events(company_id, conversation_id, at);
    CREATE INDEX IF NOT EXISTS idx_agent_event_settings_history_company ON agent_event_settings_history(company_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_agent_sandbox_history_company ON agent_sandbox_history(company_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_agent_stops_company ON agent_stops(company_id, released_at, stopped_at);
`

/** The AI sandbox's marks on logged events (「AI の囲い」, added after the log shipped). */
export function migrateAgentEventSandbox(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(agent_events)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('sandbox')) conn.exec(`ALTER TABLE agent_events ADD COLUMN sandbox TEXT`)
  if (!cols.has('skill')) conn.exec(`ALTER TABLE agent_events ADD COLUMN skill TEXT`)
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_agent_events_company_sandbox ON agent_events(company_id, at) WHERE sandbox IS NOT NULL OR guard_reason IN ('denied-read', 'sandbox')`)
}

/**
 * 「もう一方の AI に聞く」 per company (chat-and-agents.md "Asking the other AI", owner decision
 * 2026-11-02): whether a consultation may ask the other AI vendor at all. No row = not allowed
 * (a company contracted with one vendor must not send its content to the other).
 *
 * Made once. When it is first made, every company that exists then gets a row `allowed = 1`, so
 * the companies that used the feature before the setting existed keep it; a company created
 * afterwards has no row until an owner/admin turns it on. Not in `agentSchema` on purpose: the
 * table's absence is what tells this migration it has not run yet.
 */
export function migrateSecondOpinionSetting(conn: Database.Database): void {
  const exists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'second_opinion_settings'").get()
  if (exists) return
  conn.transaction(() => {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS second_opinion_settings (
        company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
    `)
    conn.prepare('INSERT INTO second_opinion_settings (company_id, allowed, updated_at, updated_by) SELECT id, 1, ?, NULL FROM companies')
      .run(new Date().toISOString())
  })()
}
