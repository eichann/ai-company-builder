/**
 * Absence and the delegate (代わりの人, stage 2 S4; `.claude/rules/records.md`
 * "Absence and the delegate"; contract shared/types/absences.ts, rules
 * shared/core/absences.ts).
 *
 * This service is the server's ONE resolution point: `actsFor(companyId,
 * userId)` (whom this member covers today) and `coverOf(companyId, userId)`
 * (who covers an absentee today, or that nobody does). 「あなたの番」 and
 * 「AI の番」 (services/records.ts), the engine's `who` (record-engine/act.ts),
 * approvals' `qualifies` (services/approvals.ts) and the notices
 * (services/notifications.ts) get these two functions injected in
 * composition.ts and nothing else decides it.
 *
 * Only "whose list it appears in" changes: every reader check stays the
 * delegate's own (`recordReader` with the delegate as the member). An
 * owner-only record of the absentee is never readable by anyone else, so it
 * never reaches the delegate.
 *
 * Who sets a member's absences: the member, owners / admins, and managers of
 * a department the member belongs to (所属, tasks.md).
 */
import { absencesOverlap, ABSENCE_MAX_OPEN, delegation, delegationAsOf, parseAbsenceInput, type AbsenceCover, type Delegation } from '../../shared/core/absences'
import type { AbsenceCreated, AbsenceView, MemberAbsencesView } from '../../shared/types/absences'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import type { StoredAbsence } from '../ports/task-settings'
import { hasFullAccess, type Member } from './access'
import { companyNow } from './notifications'
import { ok, refuse, type Outcome } from './outcome'

export const ABSENCES_FORBIDDEN = 'Only the member, owners, admins and the managers of their department can change their absences'
export const ABSENCE_NOT_FOUND = { error: '不在の設定が見つかりません', code: 'ABSENCE_NOT_FOUND' }

export interface AbsenceServiceDeps {
  companyData: CompanyDataSource
  memberships: Pick<MembershipRepository, 'roleOf'>
  accounts: Pick<AccountDirectory, 'byIds'>
  clock: Clock
  ids: IdGenerator
  /** The company's time zone (absences are whole days in company time). */
  timeZoneOf: (companyId: string) => string
  /**
   * After an absence was added: the absentee's waiting items the delegate
   * cannot read now, counting only those `setterId` may read (a count of what
   * one cannot read is never given). The stop notices are the notices' job.
   * Bound in composition.ts to the notices service; 0 without it.
   */
  delegateCannotRead?: (companyId: string, absenteeId: string, delegateId: string, setterId: string) => number
}

export function createAbsenceService(deps: AbsenceServiceDeps) {
  const { companyData, memberships, accounts, clock } = deps
  const handle = (companyId: string) => companyData.forCompany(companyId)
  const todayOf = (companyId: string) => companyNow(clock.nowMs(), deps.timeZoneOf(companyId)).slice(0, 10)

  /** Today's delegation of the company (the one resolution, shared/core `delegation`). */
  function delegationOf(companyId: string): Delegation {
    const today = todayOf(companyId)
    return delegation(handle(companyId).tasks.absencesFrom(today), today)
  }

  /** The member, owners / admins, and managers of a department the member belongs to. */
  function mayEdit(member: Member, userId: string): boolean {
    if (member.userId === userId || hasFullAccess(member.role)) return true
    const tasks = handle(member.companyId).tasks
    const managed = new Set(handle(member.companyId).scopes.managedDepartmentIds(member.userId))
    return tasks.departmentIdsOf(userId).some(d => managed.has(d))
  }

  function viewOf(a: StoredAbsence, today: string, names: Map<string, { name: string | null; email: string }>): AbsenceView {
    return {
      id: a.id, userId: a.userId, from: a.from, until: a.until, delegateId: a.delegateId,
      delegateName: names.get(a.delegateId)?.name ?? null, active: a.from <= today && today <= a.until, setBy: a.setBy, setAt: a.setAt,
    }
  }

  return {
    /** The absentees `userId` acts for today (empty when they are absent themselves). */
    actsFor(companyId: string, userId: string): string[] {
      return delegationOf(companyId).actsFor(userId)
    },

    /** Who covers `userId` today, or null when they are not absent. */
    coverOf(companyId: string, userId: string): AbsenceCover | null {
      return delegationOf(companyId).coverOf(userId)
    },

    /**
     * Who covered `userId` at a past moment `at` (ISO), or null when they were
     * not absent then — from the periods the company knew at `at` (removed ones
     * included: they are history, records.md "Whose turn it was"). With the
     * ledger's `next_actor` / `assignee` at that moment, this is whose turn a
     * record was, for any past time.
     */
    coverAt(companyId: string, userId: string, at: string): AbsenceCover | null {
      const day = companyNow(Date.parse(at), deps.timeZoneOf(companyId)).slice(0, 10)
      return delegationAsOf(handle(companyId).tasks.absencesOn(day), day, at).coverOf(userId)
    },

    /** Whom the stops of an absentee are told to: managers of the departments they belong to (not themselves). */
    managersOf(companyId: string, userId: string): string[] {
      const h = handle(companyId)
      const ids = new Set(h.tasks.departmentIdsOf(userId).flatMap(d => h.scopes.departmentManagerIds(d)))
      ids.delete(userId)
      return [...ids].sort()
    },

    /** Every absence active today, by company (the server clock's stop check). */
    activeToday(companyId: string): StoredAbsence[] {
      const today = todayOf(companyId)
      return handle(companyId).tasks.absencesFrom(today).filter(a => a.from <= today)
    },

    /** `GET …/absences?userId=` (default: the caller). */
    view(member: Member, userId?: string): Outcome<MemberAbsencesView> {
      const who = userId ?? member.userId
      if (!mayEdit(member, who)) return refuse('forbidden', ABSENCES_FORBIDDEN)
      if (memberships.roleOf(member.companyId, who) === null) return refuse('not-found', 'Member not found')
      const today = todayOf(member.companyId)
      const all = handle(member.companyId).tasks.absencesFrom(today)
      const mine = all.filter(a => a.userId === who)
      const covering = who === member.userId ? delegation(all, today).actsFor(member.userId) : []
      const names = accounts.byIds([...new Set([...mine.map(a => a.delegateId), ...covering])])
      return ok({
        userId: who,
        absences: mine.map(a => viewOf(a, today, names)),
        canEdit: true,
        covering: covering.map(id => ({
          userId: id, name: names.get(id)?.name ?? null,
          until: all.find(a => a.userId === id && a.from <= today && today <= a.until)?.until ?? today,
        })),
        today,
      })
    },

    /**
     * `POST …/absences` { userId?, from, until, delegateId }. Check order:
     * who → body → rules. The delegate must be a member; periods of one member
     * never overlap; a delegate absent on any of those days is refused (no
     * chains — and if they become absent later, nobody covers: `coverOf`).
     */
    create(member: Member, body: unknown): Outcome<AbsenceCreated> {
      const b = body as Record<string, unknown> | null
      const raw = typeof b === 'object' && b !== null ? b.userId : undefined
      if (raw !== undefined && (typeof raw !== 'string' || raw.length === 0)) return refuse('bad-request', 'userId must be a member id')
      const who = (raw as string | undefined) ?? member.userId
      if (!mayEdit(member, who)) return refuse('forbidden', ABSENCES_FORBIDDEN)
      if (memberships.roleOf(member.companyId, who) === null) return refuse('not-found', 'Member not found')
      const today = todayOf(member.companyId)
      const parsed = parseAbsenceInput(body, who, today)
      if ('error' in parsed) return refuse('bad-request', parsed.error, { code: parsed.code })
      const input = parsed.value
      // Another company's member and nobody at all get the same answer.
      if (memberships.roleOf(member.companyId, input.delegateId) === null) {
        return refuse('bad-request', '代わりの人は、この会社のメンバーから選んでください', { code: 'DELEGATE_NOT_MEMBER' })
      }
      const tasks = handle(member.companyId).tasks
      const all = tasks.absencesFrom(today)
      const own = all.filter(a => a.userId === who)
      if (own.some(a => absencesOverlap(a, input))) return refuse('conflict', 'この期間には、もう不在が設定されています', { code: 'ABSENCE_OVERLAP' })
      if (own.length >= ABSENCE_MAX_OPEN) return refuse('bad-request', `不在は ${ABSENCE_MAX_OPEN} 件まで設定できます`, { code: 'TOO_MANY_ABSENCES' })
      if (all.some(a => a.userId === input.delegateId && absencesOverlap(a, input))) {
        return refuse('conflict', '代わりの人もこの期間に不在です。別の人を選んでください', { code: 'DELEGATE_ABSENT' })
      }
      const stored: StoredAbsence = { id: deps.ids.newId(), userId: who, ...input, setBy: member.userId, setAt: clock.now() }
      tasks.addAbsence(stored)
      const names = accounts.byIds([input.delegateId])
      let cannot = 0
      try { cannot = deps.delegateCannotRead?.(member.companyId, who, input.delegateId, member.userId) ?? 0 } catch { cannot = 0 }
      return ok({ absence: viewOf(stored, today, names), delegateCannotRead: cannot })
    },

    /** `DELETE …/absences/:absenceId`: the same people who may set it. Another company's id: not found. */
    remove(member: Member, absenceId: string): Outcome<{ removed: true }> {
      const tasks = handle(member.companyId).tasks
      // Past absences are kept out of every answer; one that has ended cannot be removed (nothing to undo).
      const found = tasks.absencesFrom(todayOf(member.companyId)).find(a => a.id === absenceId)
      if (!found) return refuse('not-found', ABSENCE_NOT_FOUND.error, { code: ABSENCE_NOT_FOUND.code })
      if (!mayEdit(member, found.userId)) return refuse('forbidden', ABSENCES_FORBIDDEN)
      // Marked removed, never deleted: whose turn it was before stays answerable.
      tasks.removeAbsence(found.id, member.userId, clock.now())
      return ok({ removed: true })
    },
  }
}

export type AbsenceService = ReturnType<typeof createAbsenceService>
