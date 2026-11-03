/**
 * Which of the member's 「あなたの番」 is this week's (owner 2026-11-03, 使い心地のメモ #2: 「足しただけで
 * あなたの番になるのか？ 今やるものじゃないかもなのに」). One copy for the server's morning summary
 * (`services/notifications.ts` `turnCounts`), the app's title bar count (`notifications/watcher.ts`)
 * and the task list's sections (`model.ts`), so the three agree.
 *
 * - `now`: this week's turn — due on or before the end of this week or overdue, started, or anything
 *   that waits for the member to press (review, acceptance, an approval, a reply request, a
 *   minutes check, what the AI prepared, a wait given back by the clock): counted.
 * - `later`: a task not started, nothing to press, due after this week (the list's 「先のこと」).
 * - `someday`: the same with no due at all (the list's 「いつか」).
 * Neither `later` nor `someday` is counted; both stay in the list, folded.
 *
 * Pure: imports only core siblings.
 */
import { addDays, dayOfWeek } from './business-days'

export type TurnTiming = 'now' | 'later' | 'someday'

/** What the rule reads of a record in the member's turn (a `RecordSummary` fits). */
export interface TurnTimingInput {
  type: string
  state: string | null
  fields: Readonly<Record<string, unknown>>
  /** The server clock gave it back from 返事待ち (`waitCameBack`): it waits for the member now. */
  waitCameBack?: unknown
}

/**
 * The last day of "this week" (a Sunday) from the company's `today` (`YYYY-MM-DD`): on a Saturday
 * or Sunday it is next week's Sunday, so tomorrow's work never folds away (the task list's rule).
 */
export function weekEndOf(today: string): string {
  const toSunday = (7 - dayOfWeek(today)) % 7
  return addDays(today, toSunday < 2 ? toSunday + 7 : toSunday)
}

/**
 * A task that only rests in the member's turn: not started (`todo`), and nothing in it asks for a
 * press — not given back by the clock, not a minutes check (`task_kind`), not prepared by the AI
 * (`prep_summary`). Every other record of the turn waits for the member now.
 */
export function restingTask(r: TurnTimingInput): boolean {
  if (r.type !== 'task' || r.state !== 'todo' || r.waitCameBack) return false
  const f = r.fields
  return !(typeof f.task_kind === 'string' && f.task_kind) && !(typeof f.prep_summary === 'string' && f.prep_summary.trim())
}

/** `now` / `later` / `someday` of one record in the member's turn, from the company's `today`. */
export function turnTiming(r: TurnTimingInput, today: string): TurnTiming {
  if (!restingTask(r)) return 'now'
  const due = typeof r.fields.due === 'string' && r.fields.due ? r.fields.due.slice(0, 10) : null
  if (due === null) return 'someday'
  return due > weekEndOf(today) ? 'later' : 'now'
}
