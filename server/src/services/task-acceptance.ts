/**
 * Acceptance (引き受け, `.claude/rules/records.md` "Acceptance"; owner decision
 * 2026-11-01): is a request someone else was asked to do accepted by itself,
 * or does it wait in 「引き受け待ち」 for the assignee's 「引き受ける」?
 *
 * The company's task settings decide (`acceptance`, shared/core/task-settings.ts;
 * defaults: all on, so only asking someone in another department waits):
 *
 * - `sameDepartment`: the asker and the assignee belong to a common department
 *   (所属, tasks.md — membership, not folder permissions);
 * - `managerToMember`: the asker manages a department the assignee belongs to;
 * - `meetingHomework`: the AI made it as homework of a meeting the assignee
 *   attended (the engine reads the task's `meeting` link and its attendees).
 *
 * The engine asks only when the asker is not the assignee, a person is not
 * accepting by acting as the assignee, and the record is not owner-only
 * (services/record-engine/acceptance.ts). Everything is read through the
 * company's handle: another company's departments are never consulted.
 */
import type { TaskSettings } from '../../shared/core/task-settings'
import type { CompanyDataSource } from '../ports/company-data'

export interface AcceptanceQuestion {
  /** Who asked: the actor when the assignee was changed, else the requester. */
  asker: string
  assignee: string
  /** The asker's AI made the change (a record token), not the person themselves. */
  byAi: boolean
  /** The record links a meeting whose attendees include the assignee. */
  assigneeAttendedOrigin: boolean
}

export interface TaskAcceptanceDeps {
  companyData: CompanyDataSource
  settingsOf: (companyId: string) => TaskSettings
}

export function createTaskAcceptance(deps: TaskAcceptanceDeps) {
  return {
    /** true = accepted by itself; false = waits for the assignee's 「引き受ける」. */
    autoAccepts(companyId: string, q: AcceptanceQuestion): boolean {
      if (q.asker === q.assignee) return true
      const rules = deps.settingsOf(companyId).acceptance
      const h = deps.companyData.forCompany(companyId)
      if (rules.meetingHomework && q.byAi && q.assigneeAttendedOrigin) return true
      const theirs = new Set(h.tasks.departmentIdsOf(q.assignee))
      if (theirs.size === 0) return false
      if (rules.sameDepartment && h.tasks.departmentIdsOf(q.asker).some(d => theirs.has(d))) return true
      if (rules.managerToMember && h.scopes.managedDepartmentIds(q.asker).some(d => theirs.has(d))) return true
      return false
    },
  }
}

export type TaskAcceptance = ReturnType<typeof createTaskAcceptance>
