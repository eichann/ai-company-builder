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
  /** When the period was removed (taken back early, or the member left); absent / null while it stands. Never deleted: history. */
  removedAt?: string | null
  removedBy?: string | null
}

export interface TaskSettingsRepository {
  /** null while the company never changed the defaults. */
  get(): StoredTaskSettings | null
  save(stored: StoredTaskSettings): void

  /** The 「使う機能」 as last saved (JSON, shared/core/features.ts `featuresFrom`), null while never changed. */
  features(): { features: string; updatedAt: string; updatedBy: string | null } | null
  saveFeatures(features: string, updatedBy: string, at: string): void

  /** Who belongs to the department, oldest first; empty for a department of another company. */
  departmentMemberIds(departmentId: string): string[]
  /** Replace who belongs to the department (kept rows keep created_at/by); a department of another company is left alone. */
  replaceDepartmentMembers(departmentId: string, userIds: string[], createdBy: string, at: string): void
  /**
   * Add the user to these departments (an accepted invitation's 所属), keeping everyone else;
   * an id that is not a department of this company is skipped.
   */
  addDepartmentMember(userId: string, departmentIds: string[], createdBy: string, at: string): void
  /** The departments the user belongs to (the member left the company → removeMember). */
  departmentIdsOf(userId: string): string[]
  /**
   * The user left the company: they belong to no department of it any more, their own switches
   * are forgotten, and their absences (and those they cover) stop — marked removed at `at` by `by`, kept as history.
   */
  removeMember(userId: string, by: string, at: string): void

  /** A member's own switches as stored (JSON, shared/core/work-switches.ts), null when they never chose. */
  workSwitches(userId: string): string | null
  /** Keep a member's own switches (the whole object). */
  saveWorkSwitches(userId: string, choices: string, at: string): void

  /** Every standing (not removed) absence of the company that has not ended before `day` (`until >= day`), soonest first. */
  absencesFrom(day: string): StoredAbsence[]
  /**
   * Every absence that covers `day`, removed ones included (with `removedAt`): what the
   * company knew at any moment about that day — records.md "Whose turn it was".
   */
  absencesOn(day: string): StoredAbsence[]
  addAbsence(absence: StoredAbsence): void
  /** Mark one standing absence removed (never deleted); false when there is none with that id here. */
  removeAbsence(id: string, by: string, at: string): boolean

  /** A mark of the admin console's home (server.md "Admin home"), null while never set. */
  setupMark(mark: string): { at: string; by: string } | null
  /** Set a home mark (the first time counts: setting it again keeps the first). */
  saveSetupMark(mark: string, by: string, at: string): void
}
