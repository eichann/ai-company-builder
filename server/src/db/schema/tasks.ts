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
`
