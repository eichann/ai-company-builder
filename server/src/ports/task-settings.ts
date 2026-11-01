/**
 * One company's task settings and department membership (所属する部署), from
 * its handle (`CompanyData`, ports/company-data.ts). Every method is limited to
 * that company: another company's department id has no members here, and
 * setting members of it changes nothing. Rules: services/task-settings.ts;
 * shapes: shared/core/task-settings.ts, shared/types/task-settings.ts.
 */

export interface StoredTaskSettings {
  /** JSON of TaskSettings as last saved (re-validated on read). */
  settings: string
  updatedAt: string
  updatedBy: string | null
}

/** One stored absence (代わりの人, records.md "Absence and the delegate"). */
export interface StoredAbsence {
  id: string
  userId: string
  from: string
  until: string
  delegateId: string
  setBy: string
  setAt: string
}

export interface TaskSettingsRepository {
  /** null while the company never changed the defaults. */
  get(): StoredTaskSettings | null
  save(stored: StoredTaskSettings): void

  /** Who belongs to the department, oldest first; empty for a department of another company. */
  departmentMemberIds(departmentId: string): string[]
  /** Replace who belongs to the department (kept rows keep created_at/by); a department of another company is left alone. */
  replaceDepartmentMembers(departmentId: string, userIds: string[], createdBy: string, at: string): void
  /** The departments the user belongs to (the member left the company → removeMember). */
  departmentIdsOf(userId: string): string[]
  /** The user left the company: they belong to no department of it any more, and their absences (and those they cover) go. */
  removeMember(userId: string): void

  /** Every absence of the company that has not ended before `day` (`until >= day`), soonest first. */
  absencesFrom(day: string): StoredAbsence[]
  addAbsence(absence: StoredAbsence): void
  /** Remove one absence; false when there is none with that id here. */
  removeAbsence(id: string): boolean
}
