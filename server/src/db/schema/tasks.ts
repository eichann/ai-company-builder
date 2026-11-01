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
