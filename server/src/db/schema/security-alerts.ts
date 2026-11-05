/**
 * 「気になる動き」 (security-alerts.md): the alerts owners / admins see, their one setting, and
 * the per-member hourly download counter the bulk-download rule reads. Behind the company handle
 * (ports/security-alerts.ts). Part of the one schema run by db/index.ts initDatabase.
 */
export const securityAlertSchema = `
    -- One row per alert. facts: JSON of counts and fixed words only (never a path, a file, a
    -- folder name or a secret); the text is built when read. dedupe_key makes a sweep that runs
    -- again (or after a restart) write nothing more. delivered_at: the Slack step looked at it.
    CREATE TABLE IF NOT EXISTS security_alerts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      user_id TEXT,
      facts TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (company_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_security_alerts_company ON security_alerts(company_id, created_at);

    -- Whether new alerts also go to owners / admins as a Slack DM (no row: off).
    CREATE TABLE IF NOT EXISTS security_alert_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      slack_dm INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    -- Bytes the server sent a member from the company's repositories (fetch / clone), per hour
    -- (YYYY-MM-DDTHH, UTC). Kept 30 days.
    CREATE TABLE IF NOT EXISTS member_download_hours (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      hour TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, user_id, hour)
    );
`
