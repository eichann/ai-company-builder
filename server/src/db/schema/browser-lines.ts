/**
 * 「ブラウザ操作」's opened lines on the server (generalization PR 4; agent-browser.md "Plans of opened lines on the
 * server"): plans of shape 2 (an inspection or a plan of writes), their executions, one row per write
 * (`browser_execution_steps`, the state table of "Executions with several writes"), reports, locks, the per-line grants
 * and the strict read's notices. Behind the company handle (ports/browser-lines.ts). **New tables only**: an older build
 * never reads them, and no column of the old path's tables changes (design memo §8). Provisional until a second site
 * fits them (§18).
 */
export const browserLineSchema = `
    -- A plan of an opened line (shape 2). Its fixed content (canonical JSON: the line's identity, the values with their
    -- sources, the writes and their lock keys) and hash never change (trigger); only the state, its times and the
    -- inspection's result (once) move.
    CREATE TABLE IF NOT EXISTS browser_line_plans (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      shape INTEGER NOT NULL,
      site TEXT NOT NULL,
      line_name TEXT NOT NULL,
      line_version TEXT NOT NULL,
      map_version TEXT NOT NULL,
      meaning_hash TEXT NOT NULL,
      mechanics_hash TEXT NOT NULL,
      writes INTEGER NOT NULL CHECK (writes >= 0),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'draft', 'approved', 'claimed', 'done', 'closed')),
      close_reason TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      closed_at TEXT,
      conversation_id TEXT,
      result TEXT,
      reported_at TEXT,
      PRIMARY KEY (company_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_browser_line_plans_user ON browser_line_plans(company_id, user_id, state);
    CREATE TRIGGER IF NOT EXISTS browser_line_plans_fixed BEFORE UPDATE ON browser_line_plans
      WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.user_id IS NOT OLD.user_id OR NEW.shape IS NOT OLD.shape
        OR NEW.site IS NOT OLD.site OR NEW.line_name IS NOT OLD.line_name OR NEW.line_version IS NOT OLD.line_version
        OR NEW.map_version IS NOT OLD.map_version OR NEW.meaning_hash IS NOT OLD.meaning_hash OR NEW.mechanics_hash IS NOT OLD.mechanics_hash
        OR NEW.writes IS NOT OLD.writes OR NEW.content IS NOT OLD.content OR NEW.content_hash IS NOT OLD.content_hash
        OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.conversation_id IS NOT OLD.conversation_id
        OR (OLD.result IS NOT NULL AND (NEW.result IS NOT OLD.result OR NEW.reported_at IS NOT OLD.reported_at))
    BEGIN
      SELECT RAISE(ABORT, 'a browser line plan''s fixed content never changes');
    END;

    -- A write plan's one execution (made by the claim). secret_hash: sha256 of the secret the app holds in memory.
    CREATE TABLE IF NOT EXISTS browser_line_executions (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'unknown', 'succeeded', 'partial', 'failed', 'void', 'confirmed_done', 'confirmed_not_done')),
      void_reason TEXT,
      claimed_at TEXT NOT NULL,
      first_permitted_at TEXT,
      settled_at TEXT,
      confirmed_by TEXT,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, plan_id) REFERENCES browser_line_plans(company_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_line_executions_plan ON browser_line_executions(company_id, plan_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_line_executions_secret ON browser_line_executions(secret_hash);
    CREATE INDEX IF NOT EXISTS idx_browser_line_executions_state ON browser_line_executions(company_id, state);
    CREATE TRIGGER IF NOT EXISTS browser_line_executions_fixed BEFORE UPDATE ON browser_line_executions
      WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.user_id IS NOT OLD.user_id
        OR NEW.secret_hash IS NOT OLD.secret_hash OR NEW.claimed_at IS NOT OLD.claimed_at
    BEGIN
      SELECT RAISE(ABORT, 'a browser line execution''s fixed columns never change');
    END;

    -- One row per write of an execution (the state table, agent-browser.md "Executions with several writes"). A write's
    -- state never moves backwards: the trigger allows exactly the table's moves.
    CREATE TABLE IF NOT EXISTS browser_execution_steps (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      execution_id TEXT NOT NULL,
      idx INTEGER NOT NULL CHECK (idx >= 1),
      write_kind TEXT NOT NULL CHECK (write_kind IN ('create', 'change')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'permitted', 'done', 'not_sent', 'unknown', 'skipped', 'confirmed_done', 'confirmed_not_done')),
      permitted_at TEXT,
      permitted_mono_ms INTEGER,
      permitted_boot TEXT,
      settled_at TEXT,
      created_id TEXT,
      created_lock_key TEXT,
      confirmed_by TEXT,
      PRIMARY KEY (company_id, execution_id, idx),
      FOREIGN KEY (company_id, execution_id) REFERENCES browser_line_executions(company_id, id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS browser_execution_steps_fixed BEFORE UPDATE ON browser_execution_steps
      WHEN NEW.company_id IS NOT OLD.company_id OR NEW.execution_id IS NOT OLD.execution_id OR NEW.idx IS NOT OLD.idx
        OR NEW.write_kind IS NOT OLD.write_kind
        OR (OLD.created_id IS NOT NULL AND NEW.created_id IS NOT OLD.created_id)
        OR (OLD.permitted_at IS NOT NULL AND NEW.permitted_at IS NOT OLD.permitted_at)
        OR (NEW.state IS NOT OLD.state AND NOT (
          (OLD.state = 'pending' AND NEW.state IN ('permitted', 'skipped'))
          OR (OLD.state = 'permitted' AND NEW.state IN ('done', 'not_sent', 'unknown'))
          OR (OLD.state = 'unknown' AND NEW.state IN ('done', 'confirmed_done', 'confirmed_not_done'))))
    BEGIN
      SELECT RAISE(ABORT, 'a browser write''s state never moves backwards');
    END;

    -- Every report for a write (append-only; deleting the company still cascades). Fixed words; nothing of the site but
    -- the created object's id the app identified.
    CREATE TABLE IF NOT EXISTS browser_line_reports (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      write_index INTEGER NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('done', 'not_sent', 'unknown')),
      reason TEXT,
      created_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'same', 'recorded', 'conflict')),
      state_before TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, execution_id) REFERENCES browser_line_executions(company_id, id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS browser_line_reports_append_only BEFORE UPDATE ON browser_line_reports
    BEGIN
      SELECT RAISE(ABORT, 'browser line reports are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_line_reports_no_delete BEFORE DELETE ON browser_line_reports
      WHEN EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN
      SELECT RAISE(ABORT, 'browser line reports are append-only');
    END;

    -- The new path's object locks. The key is the same canonical JSON as the old path's (browserLockKey): both paths
    -- check both tables before taking one (C11). Held until the execution is final.
    CREATE TABLE IF NOT EXISTS browser_line_locks (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      lock_key TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, lock_key),
      FOREIGN KEY (company_id, execution_id) REFERENCES browser_line_executions(company_id, id) ON DELETE CASCADE
    );

    -- Who could use which opened line (§16-5, Q15) — no longer consulted since browser_site_grants (step ①); kept for
    -- released builds and self-hosters' rows: keyed by the line's meaning hash and the mechanics hash it was granted
    -- on; a later approved row carries it only when its reviewed grantsFrom names that mechanics hash.
    CREATE TABLE IF NOT EXISTS browser_line_grants (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      site TEXT NOT NULL,
      line_name TEXT NOT NULL,
      meaning_hash TEXT NOT NULL,
      mechanics_hash TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, site, line_name, meaning_hash, mechanics_hash)
    );

    -- Who may use which registered site, and how (step ① of the redesign; agent-browser.md "Who may use a site"):
    -- member × the host as the company registered it × none / read / write. No row = 見るだけ (read) once the company
    -- registered the host (owner decision D4); the company's level is the ceiling. A row counts only when written while
    -- the person is a member this time (updated_at ≥ the membership's created_at). Replaces browser_line_grants (kept,
    -- no longer consulted). Additive only.
    CREATE TABLE IF NOT EXISTS browser_site_grants (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      host TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('none', 'read', 'write')),
      granted_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, host)
    );

    -- The strict read's notice to owners / admins (§16-1): one row per company × site × map version × thing, the latest
    -- count of each kind — never a key name, a value or page text.
    CREATE TABLE IF NOT EXISTS browser_shape_notices (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      site TEXT NOT NULL,
      map_version TEXT NOT NULL,
      thing TEXT NOT NULL,
      unknown_keys INTEGER NOT NULL DEFAULT 0,
      missing_keys INTEGER NOT NULL DEFAULT 0,
      unreadable INTEGER NOT NULL DEFAULT 0,
      reports INTEGER NOT NULL DEFAULT 0,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (company_id, site, map_version, thing)
    );
    -- How many notices a member sent for a site on a day (the limits: an unchecked diagnosis must not flood anything).
    CREATE TABLE IF NOT EXISTS browser_shape_report_counts (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      site TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (company_id, user_id, site, day)
    );
`
