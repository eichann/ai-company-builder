/**
 * Wire shapes of the company's task settings and of department membership
 * (所属する部署), stage 2 S6. The rules (validation, defaults, replyTarget)
 * are in shared/core/task-settings.ts and shared/core/business-days.ts.
 */
import type { TaskSettings } from '../core/task-settings'

/** GET|PUT /api/companies/:id/task-settings (every member reads; owner/admin change). */
export interface TaskSettingsView {
  settings: TaskSettings
  /** The caller may change them (owner/admin). */
  canEdit: boolean
  /** null while the company never changed the defaults. */
  updatedAt: string | null
  updatedBy: string | null
  updatedByName: string | null
}

/** A person who belongs to a department. */
export interface DepartmentMember {
  userId: string
  name: string | null
  email: string | null
}

/**
 * GET|PUT /api/companies/:id/departments/:departmentId/members (every member
 * reads; owner/admin and that department's managers change). Belonging to a
 * department changes nobody's folder access.
 */
export interface DepartmentMembersView {
  members: DepartmentMember[]
  /** The caller may change who belongs (owner/admin, or a manager of this department). */
  canEdit: boolean
}
