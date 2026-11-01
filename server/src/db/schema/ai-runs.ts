/**
 * Execution runs of 「AI の番」 (stage 2 S10b, records.md "Execution runs").
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
import type Database from 'better-sqlite3'

export const aiRunSchema = `
    -- One run per AI step of a record (shared/core/ai-runs.ts). Behind the company
    -- handle (ports/ai-runs.ts). user_id: the member under whose authority the AI
    -- runs; device_id: the app instance holding the claim (until claim_expires_at);
    -- generation: raised by every claim — a write of an older generation is refused.
    -- failure_code is a short code, never free text.
    CREATE TABLE IF NOT EXISTS ai_runs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      step TEXT NOT NULL,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'open', 'retry_later', 'waiting_setup', 'waiting_person', 'waiting_reconcile', 'done')),
      generation INTEGER NOT NULL,
      device_id TEXT,
      conversation_id TEXT,
      claim_expires_at TEXT,
      failure_class TEXT,
      failure_code TEXT,
      retry_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      plugin_version TEXT,
      steps_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      PRIMARY KEY (company_id, id)
    );
    -- At most one open run per record and step: two app instances cannot both start one.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_runs_open ON ai_runs(company_id, record_id, step) WHERE closed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ai_runs_user ON ai_runs(company_id, user_id, closed_at);

    -- The outside operations of a run, by the caller's idempotency key (unique per run):
    -- in_progress (sent, no answer yet), done (ref = what it made), unknown (the effect may
    -- or may not have happened: a person reconciles), not_done (a person said it did not
    -- happen: the key may run again). fingerprint = sha256 of the request, so a key is never
    -- reused for another request. No request or answer body is kept.
    CREATE TABLE IF NOT EXISTS ai_run_operations (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('in_progress', 'done', 'unknown', 'not_done')),
      generation INTEGER NOT NULL,
      ref_kind TEXT,
      ref_id TEXT,
      status INTEGER,
      reconciled_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, run_id, key),
      FOREIGN KEY (company_id, run_id) REFERENCES ai_runs(company_id, id) ON DELETE CASCADE
    );
`

/**
 * Additive columns for runs (nullable: an older build keeps inserting without them):
 * record_ai_tokens.run_id / run_generation — a token bound to a run is refused once the
 * run was claimed again; record_ledger.run_id and plugin_operations.run_id — a change made
 * in a run (records.md "Who caused a change"). Runs after migratePluginTables (it may
 * rebuild plugin_operations).
 */
export function migrateAiRunColumns(conn: Database.Database): void {
  const cols = (table: string) => new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  const tokens = cols('record_ai_tokens')
  if (!tokens.has('run_id')) conn.exec('ALTER TABLE record_ai_tokens ADD COLUMN run_id TEXT')
  if (!tokens.has('run_generation')) conn.exec('ALTER TABLE record_ai_tokens ADD COLUMN run_generation INTEGER')
  if (!cols('record_ledger').has('run_id')) conn.exec('ALTER TABLE record_ledger ADD COLUMN run_id TEXT')
  if (!cols('plugin_operations').has('run_id')) conn.exec('ALTER TABLE plugin_operations ADD COLUMN run_id TEXT')
}
