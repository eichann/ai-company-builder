/**
 * Plans of 「ブラウザ操作」 (PR 6a; agent-browser.md "Plans, executions, permits and locks"):
 * plans, their one execution each, the target locks, the reports, and the per-member × operation
 * type grants. Behind the company handle (ports/browser-plans.ts). New tables only: an older build
 * never reads them.
 */
export const browserPlanSchema = `
    -- A plan (design memo §30.3): its fixed content (canonical JSON) and hash, and every column
    -- authorisation or the lock key reads, never changed (trigger below); state draft → approved → claimed → done, or closed. Times are the server's.
    CREATE TABLE IF NOT EXISTS browser_plans (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      connector_version TEXT NOT NULL,
      operation TEXT NOT NULL,
      declaration_hash TEXT NOT NULL,
      checker_hash TEXT NOT NULL,
      facts_version INTEGER NOT NULL,
      account TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft', 'approved', 'claimed', 'closed', 'done')),
      close_reason TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      closed_at TEXT,
      PRIMARY KEY (company_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_browser_plans_user ON browser_plans(company_id, user_id, state);
    CREATE TRIGGER IF NOT EXISTS browser_plans_fixed BEFORE UPDATE ON browser_plans
      WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.user_id IS NOT OLD.user_id
        OR NEW.connector_id IS NOT OLD.connector_id OR NEW.connector_version IS NOT OLD.connector_version OR NEW.operation IS NOT OLD.operation
        OR NEW.declaration_hash IS NOT OLD.declaration_hash OR NEW.checker_hash IS NOT OLD.checker_hash OR NEW.facts_version IS NOT OLD.facts_version
        OR NEW.account IS NOT OLD.account OR NEW.content IS NOT OLD.content OR NEW.content_hash IS NOT OLD.content_hash
        OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    BEGIN
      SELECT RAISE(ABORT, 'a browser plan''s fixed content never changes');
    END;

    -- A plan's one execution (design memo §30.4): made by the claim, which consumes the plan.
    -- secret_hash: sha256 of the execution's secret (the app holds the secret in memory only).
    CREATE TABLE IF NOT EXISTS browser_executions (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      lock_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('claimed', 'permitted', 'unknown', 'succeeded', 'failed', 'confirmed_done', 'confirmed_not_done', 'void')),
      void_reason TEXT,
      claimed_at TEXT NOT NULL,
      permitted_at TEXT,
      settled_at TEXT,
      confirmed_by TEXT,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, plan_id) REFERENCES browser_plans(company_id, id) ON DELETE CASCADE
    );
    -- One execution per plan: a second claim cannot make another.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_executions_plan ON browser_executions(company_id, plan_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_executions_secret ON browser_executions(secret_hash);
    CREATE INDEX IF NOT EXISTS idx_browser_executions_state ON browser_executions(company_id, state);

    -- Every report the app sent (design memo §29.1: a late or conflicting one is kept, marked).
    -- result / reason are fixed words; nothing of the site.
    CREATE TABLE IF NOT EXISTS browser_execution_reports (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('succeeded', 'failed', 'unknown')),
      reason TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'same', 'recorded', 'conflict')),
      state_before TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, execution_id) REFERENCES browser_executions(company_id, id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS browser_execution_reports_append_only BEFORE UPDATE ON browser_execution_reports
    BEGIN
      SELECT RAISE(ABORT, 'browser execution reports are append-only');
    END;
    -- No row goes while its company exists (deleting the company still cascades).
    CREATE TRIGGER IF NOT EXISTS browser_execution_reports_no_delete BEFORE DELETE ON browser_execution_reports
      WHEN EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN
      SELECT RAISE(ABORT, 'browser execution reports are append-only');
    END;

    -- The target lock (design memo §30.5): one execution per target at a time; the key is the
    -- server's canonical JSON (shared/core/browser-plans.ts browserLockKey).
    CREATE TABLE IF NOT EXISTS browser_target_locks (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      lock_key TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, lock_key),
      FOREIGN KEY (company_id, execution_id) REFERENCES browser_executions(company_id, id) ON DELETE CASCADE
    );

    -- Who may use which operation type (design memo §27.4, §28.C): bound to the declaration's
    -- hash, so a changed declaration needs a new grant. Removed when the member leaves.
    CREATE TABLE IF NOT EXISTS browser_type_grants (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      declaration_hash TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, connector_id, operation, declaration_hash)
    );
`
