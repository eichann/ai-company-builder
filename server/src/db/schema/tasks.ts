import type Database from 'better-sqlite3'

/**
 * Task settings and department membership (tasks.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const taskSchema = `
    -- The company's task settings (stage 2 S6, .claude/rules/tasks.md), behind the
    -- company handle (ports/task-settings.ts): one JSON document per company
    -- (shared/core/task-settings.ts parseTaskSettings, re-validated on read).
    CREATE TABLE IF NOT EXISTS task_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    -- Department membership (所属する部署, stage 2 S6): who belongs to a
    -- department. Separate from folder permissions (changes nobody's access).
    -- A row's company is its department's (trigger below).
    CREATE TABLE IF NOT EXISTS department_members (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (department_id, user_id)
    );

    CREATE TRIGGER IF NOT EXISTS department_members_company_insert BEFORE INSERT ON department_members
    WHEN NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'department_members.company_id must be the company of its department'); END;

    CREATE TRIGGER IF NOT EXISTS department_members_company_update BEFORE UPDATE OF company_id, department_id ON department_members
    WHEN NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'department_members.company_id must be the company of its department'); END;

    CREATE INDEX IF NOT EXISTS idx_department_members_company_user ON department_members(company_id, user_id);

    -- Absence and the delegate (代わりの人, stage 2 S4, records.md "Absence and the
    -- delegate"): whole days from..until (company time, inclusive) with one
    -- delegate. Behind the company handle (ports/task-settings.ts).
    CREATE TABLE IF NOT EXISTS member_absences (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      from_day TEXT NOT NULL,
      until_day TEXT NOT NULL,
      delegate_id TEXT NOT NULL,
      set_by TEXT NOT NULL,
      set_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_member_absences_company_until ON member_absences(company_id, until_day);
`

/**
 * Each member's own switches (自分の設定: 受信を読む, AI が自動で進める; shared/core/work-switches.ts),
 * behind the company handle (ports/task-settings.ts): one JSON object per member, a switch left out
 * = never chosen (the company's 初めの値 applies).
 *
 * Made once. When it is first made, a member who reads incoming messages today — Google's 受信を読む
 * granted and not turned off, or Slack's reading granted and not turned off — gets 受信を読む chosen
 * on, so turning the company's 初めの値 to "off" changes nothing for them (and Google's per-grant
 * `inbox` switch, now replaced by this one, is carried over: turned off → chosen off).
 */
/** Google's 受信を読む (`shared/core/google.ts` `GOOGLE_SCOPE.gmailReadonly`), Slack's reading (`slack-client.ts`: identity + `read`). */
const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'
const SLACK_READ_SCOPES = ['users:read', 'users:read.email', 'im:history', 'mpim:history', 'channels:history', 'groups:history']

export function migrateMemberWorkSwitches(conn: Database.Database): void {
  const exists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'member_work_switches'").get()
  if (exists) return
  conn.exec(`
    CREATE TABLE IF NOT EXISTS member_work_switches (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      choices TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id)
    );
  `)
  const hasGrants = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connector_grants'").get()
  if (!hasGrants) return
  const grants = conn.prepare(`
    SELECT company_id, user_id, provider, scopes, features_off FROM connector_grants WHERE status = 'active' AND provider IN ('google', 'slack')
  `).all() as Array<{ company_id: string; user_id: string; provider: string; scopes: string; features_off: string }>
  const list = (raw: string): string[] => { try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] } }
  const choice = new Map<string, { companyId: string; userId: string; on: boolean }>()
  for (const g of grants) {
    const scopes = list(g.scopes)
    const off = list(g.features_off)
    // Google 受信を読む = gmail.readonly (feature `inbox`); Slack reading = its `read` feature.
    const reads = g.provider === 'google'
      ? scopes.includes(GMAIL_READONLY) ? !off.includes('inbox') : null
      : SLACK_READ_SCOPES.every(x => scopes.includes(x)) ? !off.includes('read') : null
    if (reads === null) continue
    const key = `${g.company_id}\u0000${g.user_id}`
    const before = choice.get(key)
    // Reading through either one counts as on.
    choice.set(key, { companyId: g.company_id, userId: g.user_id, on: (before?.on ?? false) || reads })
  }
  const insert = conn.prepare('INSERT OR IGNORE INTO member_work_switches (company_id, user_id, choices, updated_at) VALUES (?, ?, ?, ?)')
  const at = new Date().toISOString()
  for (const c of choice.values()) insert.run(c.companyId, c.userId, JSON.stringify({ readIncoming: c.on }), at)
}

/**
 * Absences are history (records.md "Absence and the delegate", "Whose turn it was"): a removed
 * period is marked (`removed_at`, `removed_by`), never deleted, so whose turn a record was at any
 * past moment can be recomputed from the ledger plus the periods known at that moment
 * (shared/core/absences.ts `delegationAsOf`). Additive and nullable (an older build keeps working);
 * the trigger lets a row change only once, from live to removed, and nothing else of it.
 */
export function migrateMemberAbsenceHistory(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(member_absences)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('removed_at')) conn.exec('ALTER TABLE member_absences ADD COLUMN removed_at TEXT')
  if (!cols.has('removed_by')) conn.exec('ALTER TABLE member_absences ADD COLUMN removed_by TEXT')
  conn.exec(`
    CREATE TRIGGER IF NOT EXISTS member_absences_append_only BEFORE UPDATE ON member_absences
    WHEN OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
      OR NEW.company_id IS NOT OLD.company_id OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
      OR NEW.from_day IS NOT OLD.from_day OR NEW.until_day IS NOT OLD.until_day OR NEW.delegate_id IS NOT OLD.delegate_id
      OR NEW.set_by IS NOT OLD.set_by OR NEW.set_at IS NOT OLD.set_at
    BEGIN SELECT RAISE(ABORT, 'member_absences rows are history: only marking a live row removed is allowed'); END;
  `)
}
