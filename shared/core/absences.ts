/**
 * Absence and the delegate (代わりの人, stage 2 S4; owner decision 2026-11-01
 * 「ACB 現行の仕様」 §9-2, 棚卸し §3-③): a member has absence periods, each
 * with one delegate. During an absence, the absentee's turn, the approvals they
 * may approve and their notices also reach the delegate.
 *
 * The delegate acts with their own login and their own permissions: only
 * "whose list it appears in" changes. No chains: when the delegate is absent
 * too, nobody acts for the absentee (the department manager is told).
 *
 * `delegation(periods, day)` is the ONE resolution point (records.md
 * "Absence and the delegate"): the server builds it per company and day and
 * every place that asks "whose turn / who may approve / who is told / whose
 * AI turn runs here" goes through it. Pure: dates only, company time.
 */

/** One absence of a member: whole days `from`..`until` (inclusive, `YYYY-MM-DD`, company time). */
export interface AbsencePeriod {
  userId: string
  from: string
  until: string
  delegateId: string
}

/** Who covers an absentee today. */
export type AbsenceCover =
  | { kind: 'delegate'; delegateId: string }
  /** The delegate is absent too: nobody acts for them (no chains). */
  | { kind: 'stopped'; delegateId: string; reason: 'delegate-absent' }

export interface Delegation {
  /** The absentees `userId` acts for today (none when `userId` is absent themselves: their covers are all `stopped`). */
  actsFor(userId: string): string[]
  /** Who covers `userId` today, or null when they are not absent. */
  coverOf(userId: string): AbsenceCover | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar date `YYYY-MM-DD` (2000–2100). */
export function isAbsenceDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const y = Number(value.slice(0, 4))
  if (y < 2000 || y > 2100) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export const absenceCovers = (p: Pick<AbsencePeriod, 'from' | 'until'>, day: string): boolean => p.from <= day && day <= p.until

/** Two periods share at least one day. */
export const absencesOverlap = (a: Pick<AbsencePeriod, 'from' | 'until'>, b: Pick<AbsencePeriod, 'from' | 'until'>): boolean =>
  a.from <= b.until && b.from <= a.until

/**
 * Who acts for whom on `day`. A member is absent when one of their periods
 * covers the day; their delegate acts for them unless the delegate is absent
 * too (then nobody does: `stopped`). A member never acts for themselves.
 */
export function delegation(periods: readonly AbsencePeriod[], day: string): Delegation {
  const today = periods.filter(p => absenceCovers(p, day) && p.delegateId !== p.userId)
  const absent = new Set(today.map(p => p.userId))
  const covers = new Map<string, AbsenceCover>()
  // Several periods covering one day cannot be stored (refused as overlapping); the first wins if they ever were.
  for (const p of today) {
    if (covers.has(p.userId)) continue
    covers.set(p.userId, absent.has(p.delegateId)
      ? { kind: 'stopped', delegateId: p.delegateId, reason: 'delegate-absent' }
      : { kind: 'delegate', delegateId: p.delegateId })
  }
  return {
    actsFor(userId) {
      const out: string[] = []
      for (const [absentee, c] of covers) if (c.kind === 'delegate' && c.delegateId === userId) out.push(absentee)
      return out.sort()
    },
    coverOf(userId) {
      return covers.get(userId) ?? null
    },
  }
}

/** The longest absence one period may cover (days). */
export const ABSENCE_MAX_DAYS = 366
/** Absences a member may have that have not ended yet. */
export const ABSENCE_MAX_OPEN = 20

export interface AbsenceInput {
  from: string
  until: string
  delegateId: string
}

/**
 * The body of a new absence, checked: dates in order, not ended before
 * `today`, at most ABSENCE_MAX_DAYS, a delegate other than the absentee.
 * Whether the delegate is a member, and overlaps, are the server's checks.
 */
export function parseAbsenceInput(body: unknown, absenteeId: string, today: string): { value: AbsenceInput } | { error: string; code: string } {
  const b = body as Record<string, unknown> | null
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return { error: 'Send { from, until, delegateId }', code: 'BAD_REQUEST' }
  if (!isAbsenceDate(b.from) || !isAbsenceDate(b.until)) return { error: '日付は YYYY-MM-DD で入れてください', code: 'BAD_DATES' }
  if (b.until < b.from) return { error: '終わりの日は始まりの日と同じか、それより後にしてください', code: 'BAD_DATES' }
  if (b.until < today) return { error: 'もう過ぎた期間は設定できません', code: 'BAD_DATES' }
  const days = Math.round((Date.parse(`${b.until}T00:00:00Z`) - Date.parse(`${b.from}T00:00:00Z`)) / 86_400_000) + 1
  if (days > ABSENCE_MAX_DAYS) return { error: `一度に設定できるのは ${ABSENCE_MAX_DAYS} 日までです`, code: 'BAD_DATES' }
  if (typeof b.delegateId !== 'string' || b.delegateId.length === 0 || b.delegateId.length > 200) return { error: '代わりの人を選んでください', code: 'DELEGATE_REQUIRED' }
  if (b.delegateId === absenteeId) return { error: '自分を代わりの人にはできません', code: 'DELEGATE_SELF' }
  return { value: { from: b.from, until: b.until, delegateId: b.delegateId } }
}
