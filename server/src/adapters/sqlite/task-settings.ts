/**
 * SQLite storage of the task settings and department membership
 * (ports/task-settings.ts), bound to one company — built only by the company
 * handle (adapters/sqlite/company-data.ts), every statement limited to
 * `companyId`. A department_members row's company must be its department's
 * (trigger in db/index.ts), and a department's rows go with it (ON DELETE CASCADE).
 */
import type Database from 'better-sqlite3'
import type { StoredAbsence, TaskSettingsRepository } from '../../ports/task-settings'

const ABSENCE_COLUMNS = 'id, user_id, from_day, until_day, delegate_id, set_by, set_at, removed_at, removed_by'
interface AbsenceRow {
  id: string; user_id: string; from_day: string; until_day: string; delegate_id: string; set_by: string; set_at: string
  removed_at: string | null; removed_by: string | null
}
const toAbsence = (r: AbsenceRow): StoredAbsence => ({
  id: r.id, userId: r.user_id, from: r.from_day, until: r.until_day, delegateId: r.delegate_id, setBy: r.set_by, setAt: r.set_at,
  removedAt: r.removed_at, removedBy: r.removed_by,
})

export function sqliteTaskSettingsRepository(conn: Database.Database, companyId: string): TaskSettingsRepository {
  return {
    get() {
      const r = conn.prepare('SELECT settings, updated_at, updated_by FROM task_settings WHERE company_id = ?')
        .get(companyId) as { settings: string; updated_at: string; updated_by: string | null } | undefined
      return r ? { settings: r.settings, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
    },
    save(stored) {
      conn.prepare(`
        INSERT INTO task_settings (company_id, settings, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(companyId, stored.settings, stored.updatedAt, stored.updatedBy)
    },
    departmentMemberIds(departmentId) {
      return (conn.prepare(`
        SELECT user_id FROM department_members WHERE company_id = ? AND department_id = ? ORDER BY created_at, user_id
      `).all(companyId, departmentId) as Array<{ user_id: string }>).map(r => r.user_id)
    },
    replaceDepartmentMembers(departmentId, userIds, createdBy, at) {
      conn.transaction(() => {
        const owned = conn.prepare('SELECT 1 FROM departments WHERE company_id = ? AND id = ?').get(companyId, departmentId)
        if (!owned) return
        const keep = JSON.stringify(userIds)
        conn.prepare(`
          DELETE FROM department_members WHERE company_id = ? AND department_id = ? AND user_id NOT IN (SELECT value FROM json_each(?))
        `).run(companyId, departmentId, keep)
        const insert = conn.prepare(`
          INSERT OR IGNORE INTO department_members (company_id, department_id, user_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)
        `)
        for (const userId of userIds) insert.run(companyId, departmentId, userId, at, createdBy)
      })()
    },
    departmentIdsOf(userId) {
      return (conn.prepare(`
        SELECT department_id FROM department_members WHERE company_id = ? AND user_id = ? ORDER BY created_at, department_id
      `).all(companyId, userId) as Array<{ department_id: string }>).map(r => r.department_id)
    },
    removeMember(userId, by, at) {
      conn.prepare('DELETE FROM department_members WHERE company_id = ? AND user_id = ?').run(companyId, userId)
      conn.prepare('DELETE FROM member_work_switches WHERE company_id = ? AND user_id = ?').run(companyId, userId)
      // History (records.md "Whose turn it was"): marked, never deleted.
      conn.prepare(`
        UPDATE member_absences SET removed_at = ?, removed_by = ? WHERE company_id = ? AND (user_id = ? OR delegate_id = ?) AND removed_at IS NULL
      `).run(at, by, companyId, userId, userId)
    },
    workSwitches(userId) {
      const r = conn.prepare('SELECT choices FROM member_work_switches WHERE company_id = ? AND user_id = ?')
        .get(companyId, userId) as { choices: string } | undefined
      return r?.choices ?? null
    },
    saveWorkSwitches(userId, choices, at) {
      conn.prepare(`
        INSERT INTO member_work_switches (company_id, user_id, choices, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id, user_id) DO UPDATE SET choices = excluded.choices, updated_at = excluded.updated_at
      `).run(companyId, userId, choices, at)
    },
    absencesFrom(day) {
      return (conn.prepare(`
        SELECT ${ABSENCE_COLUMNS} FROM member_absences
        WHERE company_id = ? AND until_day >= ? AND removed_at IS NULL ORDER BY from_day, until_day, id
      `).all(companyId, day) as AbsenceRow[]).map(toAbsence)
    },
    absencesOn(day) {
      return (conn.prepare(`
        SELECT ${ABSENCE_COLUMNS} FROM member_absences
        WHERE company_id = ? AND from_day <= ? AND until_day >= ? ORDER BY set_at, id
      `).all(companyId, day, day) as AbsenceRow[]).map(toAbsence)
    },
    addAbsence(a) {
      conn.prepare(`
        INSERT INTO member_absences (company_id, id, user_id, from_day, until_day, delegate_id, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(companyId, a.id, a.userId, a.from, a.until, a.delegateId, a.setBy, a.setAt)
    },
    removeAbsence(id, by, at) {
      return conn.prepare('UPDATE member_absences SET removed_at = ?, removed_by = ? WHERE company_id = ? AND id = ? AND removed_at IS NULL')
        .run(at, by, companyId, id).changes > 0
    },
  }
}
