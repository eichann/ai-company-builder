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
    CREATE TRIGGER IF NOT EXISTS browser_runs_fixed BEFORE UPDATE ON browser_runs
      WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.user_id IS NOT OLD.user_id OR NEW.host IS NOT OLD.host
        OR NEW.device_id IS NOT OLD.device_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.started_at IS NOT OLD.started_at
        OR (OLD.state <> 'running' AND (NEW.state IS NOT OLD.state OR NEW.reason IS NOT OLD.reason OR NEW.ended_at IS NOT OLD.ended_at OR NEW.lease_until IS NOT OLD.lease_until))
        OR (OLD.log_written = 1 AND NEW.log_written <> 1)
    BEGIN
      SELECT RAISE(ABORT, 'a browser run only moves from running, once');
    END;

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
