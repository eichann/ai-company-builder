/**
 * The PCs used for 「ブラウザ操作」 (agent-browser.md "This PC's registration"; design memo 「ブラウザ操作を担当者の PC で使う」 v2
 * §5): registrations (company × member × PC), their history, and which registration made each plan. Behind the company
 * handle (ports/browser-devices.ts). **New tables only**: no column of the plan tables changes, and an older build never
 * reads these.
 *
 * - `browser_devices`: the PC's key is never stored, only its sha256 (`key_hash`). One registration not stopped per
 *   company × member × key (partial unique index); a stopped one stays (the history), and registering again makes a new
 *   row with a new id. The trigger keeps the fixed columns and allows only pending → enabled → revoked (revoked final).
 * - `browser_device_history`: append-only (who, when, which registration, what). No key, no hash.
 * - `browser_plan_devices`: a plan (old path `type`, new path `line`) and the registration that made it; written once
 *   when the plan is made, never changed or removed while its company exists. A plan without a row was made under the
 *   owner's transition exception (or before this build).
 */
export const browserDeviceSchema = `
    CREATE TABLE IF NOT EXISTS browser_devices (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'enabled', 'revoked')),
      revoke_reason TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('admin', 'self', 'left')),
      requested_at TEXT NOT NULL,
      enabled_at TEXT,
      enabled_by TEXT,
      revoked_at TEXT,
      revoked_by TEXT,
      last_used_at TEXT,
      PRIMARY KEY (company_id, id),
      CHECK ((state = 'revoked') = (revoke_reason IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_devices_live ON browser_devices(company_id, user_id, key_hash) WHERE state <> 'revoked';
    CREATE INDEX IF NOT EXISTS idx_browser_devices_key ON browser_devices(company_id, user_id, key_hash, requested_at);
    CREATE INDEX IF NOT EXISTS idx_browser_devices_requested ON browser_devices(company_id, requested_at);
    CREATE TRIGGER IF NOT EXISTS browser_devices_fixed BEFORE UPDATE ON browser_devices
      WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.user_id IS NOT OLD.user_id OR NEW.key_hash IS NOT OLD.key_hash
        OR NEW.label IS NOT OLD.label OR NEW.requested_at IS NOT OLD.requested_at
        OR OLD.state = 'revoked'
        OR (OLD.enabled_at IS NOT NULL AND (NEW.enabled_at IS NOT OLD.enabled_at OR NEW.enabled_by IS NOT OLD.enabled_by))
        OR (NEW.state IS NOT OLD.state AND NOT (
          (OLD.state = 'pending' AND NEW.state IN ('enabled', 'revoked'))
          OR (OLD.state = 'enabled' AND NEW.state = 'revoked')))
    BEGIN
      SELECT RAISE(ABORT, 'a browser PC registration only moves pending → enabled → revoked');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_devices_no_delete BEFORE DELETE ON browser_devices
      WHEN EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN
      SELECT RAISE(ABORT, 'a browser PC registration is kept (stop it instead)');
    END;

    CREATE TABLE IF NOT EXISTS browser_device_history (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('request', 'enable', 'revoke')),
      reason TEXT CHECK (reason IS NULL OR reason IN ('admin', 'self', 'left')),
      at TEXT NOT NULL,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, device_id) REFERENCES browser_devices(company_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_browser_device_history_at ON browser_device_history(company_id, at);
    CREATE TRIGGER IF NOT EXISTS browser_device_history_append_only BEFORE UPDATE ON browser_device_history
    BEGIN
      SELECT RAISE(ABORT, 'browser PC history is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_device_history_no_delete BEFORE DELETE ON browser_device_history
      WHEN EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN
      SELECT RAISE(ABORT, 'browser PC history is append-only');
    END;

    CREATE TABLE IF NOT EXISTS browser_plan_devices (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      path TEXT NOT NULL CHECK (path IN ('type', 'line')),
      plan_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, path, plan_id),
      FOREIGN KEY (company_id, device_id) REFERENCES browser_devices(company_id, id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS browser_plan_devices_fixed BEFORE UPDATE ON browser_plan_devices
    BEGIN
      SELECT RAISE(ABORT, 'a plan''s PC never changes');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_plan_devices_no_delete BEFORE DELETE ON browser_plan_devices
      WHEN EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN
      SELECT RAISE(ABORT, 'a plan''s PC never changes');
    END;
`
