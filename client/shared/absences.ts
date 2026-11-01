import type { AbsenceCreated, MemberAbsencesView } from '../../shared/types/absences'

/**
 * Settings → 「不在と代わりの人」 (stage 2 S4, records.md "Absence and the
 * delegate"): the member's own absences and whom they cover today, read and
 * changed with the member's session in main (IPC `absences:*`).
 */

export const ABSENCES_OFFLINE_TEXT = 'サーバーに接続できないため、いまは不在の予定を読み込めません（オフラインの可能性があります）。'

/** A company member for the delegate picker (never shown as an id). */
export interface AbsenceMember {
  userId: string
  name: string
}

export type AbsenceFailure = { success: false; offline: boolean; code: string | null; error: string }

/** `absences:get`: the member's own view and the company's members for the picker. */
export type AbsencesResult = { success: true; view: MemberAbsencesView; members: AbsenceMember[] } | AbsenceFailure
/** `absences:add`. */
export type AbsenceAddResult = { success: true; created: AbsenceCreated } | AbsenceFailure
/** `absences:remove`. */
export type AbsenceRemoveResult = { success: true } | AbsenceFailure

/** The arguments of `absences:add` (the absence is always the caller's own here). */
export interface AbsenceAddInput {
  from: string
  until: string
  delegateId: string
}

/** 「11月5日」 from `YYYY-MM-DD` (as given when it is not a date). */
export function absenceDayText(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  return m ? `${Number(m[1])}月${Number(m[2])}日` : day
}

/** 「11月3日〜11月5日」, or one day 「11月3日」. */
export function absenceRangeText(from: string, until: string): string {
  return from === until ? absenceDayText(from) : `${absenceDayText(from)}〜${absenceDayText(until)}`
}
