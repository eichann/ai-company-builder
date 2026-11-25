import type Database from 'better-sqlite3'

/**
 * The trigger that keeps a run's fixed columns (since "Room for a Skill run" also its budget, the frames run it named and
 * its end, and its step count only growing by one while it runs). One text for a new database and the migration, so both
 * end the same.
 */
const BROWSER_RUNS_FIXED_TRIGGER = `CREATE TRIGGER IF NOT EXISTS browser_runs_fixed BEFORE UPDATE ON browser_runs
      WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.user_id IS NOT OLD.user_id OR NEW.host IS NOT OLD.host
        OR NEW.device_id IS NOT OLD.device_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.started_at IS NOT OLD.started_at
        OR NEW.budget IS NOT OLD.budget OR NEW.frame_run_id IS NOT OLD.frame_run_id OR NEW.ends_at IS NOT OLD.ends_at
        OR NEW.steps < OLD.steps OR NEW.steps > OLD.steps + 1
        OR (OLD.state <> 'running' AND (NEW.state IS NOT OLD.state OR NEW.reason IS NOT OLD.reason OR NEW.ended_at IS NOT OLD.ended_at OR NEW.lease_until IS NOT OLD.lease_until OR NEW.steps IS NOT OLD.steps))
        OR (OLD.log_written = 1 AND NEW.log_written <> 1)
    BEGIN
      SELECT RAISE(ABORT, 'a browser run only moves from running, once');
    END`
/** The trigger as SQLite keeps it in `sqlite_master` (it drops `IF NOT EXISTS`): what the migration compares with. */
const BROWSER_RUNS_FIXED_TRIGGER_STORED = BROWSER_RUNS_FIXED_TRIGGER.replace('CREATE TRIGGER IF NOT EXISTS ', 'CREATE TRIGGER ')

/**
 * The operator's runs of 「ブラウザ操作」 (redesign step ④; agent-browser.md "The operator's window tools"): one row per run
 * and its log. Behind the company handle (ports/browser-runs.ts). **New tables only**: nothing of the plan tables changes,
 * and an older build never reads these.
 *
 * - `browser_runs`: who, which registered domain, from which PC, when, the state and the lock's lease. **At most one
 *   `running` row per company × domain** (partial unique index: the lock, design memo D10); a run not heard from by its
 *   `lease_until` is over (the service ends it on the next touch). The trigger keeps the fixed columns and lets a state
 *   move only from `running` (every other state is final); `log_written` goes 0 → 1 once (the log is written once).
 * - `browser_run_log`: per step the page as a pattern, what was done, the label of what was pressed — never a value
 *   (shared/core/browser-run-log.ts). Append-only while its company exists.
 * - `browser_run_writes` (step ⑤b, additive): a write run's page writes — after which step, the frame, the method, the
 *   path as a pattern, the outcome. Never a value. Append-only like the log.
 */
export const browserRunSchema = `
    CREATE TABLE IF NOT EXISTS browser_runs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      host TEXT NOT NULL,
      device_id TEXT,
      conversation_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('running', 'done', 'stopped', 'failed', 'timed_out', 'refused', 'left')),
      reason TEXT,
      started_at TEXT NOT NULL,
      lease_until TEXT NOT NULL,
      ended_at TEXT,
      log_written INTEGER NOT NULL DEFAULT 0 CHECK (log_written IN (0, 1)),
      PRIMARY KEY (company_id, id),
      CHECK ((state = 'running') = (ended_at IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_runs_lock ON browser_runs(company_id, host) WHERE state = 'running';
    CREATE INDEX IF NOT EXISTS idx_browser_runs_started ON browser_runs(company_id, started_at);
    ${BROWSER_RUNS_FIXED_TRIGGER};

    CREATE TABLE IF NOT EXISTS browser_run_log (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      page TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('click', 'type', 'select', 'go', 'back', 'wait')),
      label TEXT,
      PRIMARY KEY (company_id, run_id, idx)
    );
    CREATE TRIGGER IF NOT EXISTS browser_run_log_no_update BEFORE UPDATE ON browser_run_log
    BEGIN
      SELECT RAISE(ABORT, 'a browser run log is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_run_log_no_delete BEFORE DELETE ON browser_run_log
      WHEN EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN
      SELECT RAISE(ABORT, 'a browser run log is append-only');
    END;

    CREATE TABLE IF NOT EXISTS browser_run_writes (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      after_step INTEGER NOT NULL CHECK (after_step >= 0),
      frame INTEGER,
      method TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE', 'OTHER')),
      page TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('done', 'not-sent', 'unknown', 'refused')),
      PRIMARY KEY (company_id, run_id, idx)
    );
    CREATE TRIGGER IF NOT EXISTS browser_run_writes_no_update BEFORE UPDATE ON browser_run_writes
    BEGIN
      SELECT RAISE(ABORT, 'a browser run log is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_run_writes_no_delete BEFORE DELETE ON browser_run_writes
      WHEN EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN
      SELECT RAISE(ABORT, 'a browser run log is append-only');
    END;
`

/**
 * A run's budget ("Room for a Skill run", shared/core/browser-run-budget.ts): `budget` (the name the server chose at the
 * start), `frame_run_id` (the frames run it named, or null), `ends_at` (the lock's hard end: the budget's `runMs` from the
 * start, never past the named frames run's own end; null for an older build's row = its start + the standard 6 minutes)
 * — all fixed — and `steps` (the operator's answers so far: each `continue` adds one, never past the budget). **At most
 * one `skill` run per frames run** (partial unique index, behind the service's own check). Added with defaults: an older
 * build inserts without them and its rows read as before. The fixed-columns trigger is replaced when the stored one
 * differs (once; a second start finds it equal and leaves it). Idempotent.
 */
export function migrateBrowserRunBudget(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(browser_runs)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('budget')) conn.exec("ALTER TABLE browser_runs ADD COLUMN budget TEXT NOT NULL DEFAULT 'standard' CHECK (budget IN ('standard', 'skill'))")
  if (!cols.has('steps')) conn.exec('ALTER TABLE browser_runs ADD COLUMN steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0)')
  if (!cols.has('frame_run_id')) conn.exec('ALTER TABLE browser_runs ADD COLUMN frame_run_id TEXT')
  if (!cols.has('ends_at')) conn.exec('ALTER TABLE browser_runs ADD COLUMN ends_at TEXT')
  conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_runs_skill_once ON browser_runs(company_id, frame_run_id) WHERE budget = 'skill'")
  const trigger = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'browser_runs_fixed'").get() as { sql: string } | undefined
  if (trigger?.sql !== BROWSER_RUNS_FIXED_TRIGGER_STORED) {
    conn.exec('DROP TRIGGER IF EXISTS browser_runs_fixed')
    conn.exec(BROWSER_RUNS_FIXED_TRIGGER)
  }
}
