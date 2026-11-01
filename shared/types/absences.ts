/**
 * Wire shapes of absence and the delegate (代わりの人, stage 2 S4,
 * `.claude/rules/records.md` "Absence and the delegate"). Rules:
 * shared/core/absences.ts.
 *
 *   GET    /api/companies/:id/absences?userId=   the member's absences (default: the caller)
 *   POST   /api/companies/:id/absences           { userId?, from, until, delegateId }
 *   DELETE /api/companies/:id/absences/:absenceId
 *
 * Who: the member themselves, owners / admins, and managers of a department
 * the member belongs to (所属, tasks.md). Anyone else: 403.
 */

/** One absence as shown. Dates are whole days in company time, `until` included. */
export interface AbsenceView {
  id: string
  userId: string
  from: string
  until: string
  delegateId: string
  delegateName: string | null
  /** Today is inside it. */
  active: boolean
  setBy: string
  setAt: string
}

/** Someone the caller covers today (only in the caller's own view). */
export interface CoveringView {
  userId: string
  name: string | null
  until: string
}

/** `GET …/absences?userId=`: absences that have not ended yet, soonest first. */
export interface MemberAbsencesView {
  userId: string
  absences: AbsenceView[]
  /** The caller may add or remove this member's absences. */
  canEdit: boolean
  /** Whom the caller covers today; empty unless `userId` is the caller. */
  covering: CoveringView[]
  /** Today in company time (`YYYY-MM-DD`). */
  today: string
}

/** `POST …/absences`. */
export interface AbsenceCreateRequest {
  /** Default: the caller. */
  userId?: string
  from: string
  until: string
  delegateId: string
}

/** `POST …/absences` → 201. */
export interface AbsenceCreated {
  absence: AbsenceView
  /**
   * Waiting items of the absentee (their turn) the delegate cannot read now:
   * those stop with 「権限が足りない」 and the department manager is told. Shown
   * to whoever set the absence (the absentee's own items, or a manager's).
   */
  delegateCannotRead: number
}
