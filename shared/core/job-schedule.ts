/**
 * When a scheduled job's occurrences fall (定期の仕事, B PR 3b, `.claude/rules/jobs.md` "The clock"): the
 * slots of a trigger in the company's own time, as `YYYY-MM-DDTHH:MM` text (no zone; the occurrence
 * keeps the zone it was computed in). A slot is the occurrence's identity (`due_slot`): computed again
 * by a later clock, after a restart or by a second server, it is the same text, so the occurrence table's
 * `UNIQUE (company, job, due_slot)` makes it once.
 *
 * Business days are `business-days.ts`'s: weekends, Japanese public holidays (calculated) and the
 * company's own days off. Pure (server/tests/unit/core-purity.test.ts): the caller converts its clock to
 * company time and a slot back to an instant.
 */
import { addDays, dayOfWeek, isBusinessDay, nextBusinessDay, previousBusinessDay } from './business-days'
import type { JobTrigger, JobWeekday } from './jobs'

/** Days looked back / ahead for a slot: more than a month and a week's business days either way. */
const LOOK_BACK_DAYS = 70
const LOOK_AHEAD_DAYS = 70

const WEEKDAY_INDEX: Record<JobWeekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

const pad = (n: number) => String(n).padStart(2, '0')

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The slot dates (YYYY-MM-DD) of `trigger` from `from` to `to` (both inclusive), sorted, each once. */
export function jobSlotDates(trigger: JobTrigger, from: string, to: string, companyHolidays: Iterable<string> = []): string[] {
  const own = new Set(companyHolidays)
  const out = new Set<string>()
  if (trigger.every === 'day') {
    for (let d = from; d <= to; d = addDays(d, 1)) if (!trigger.businessDaysOnly || isBusinessDay(d, own)) out.add(d)
  } else if (trigger.every === 'week') {
    // Each `weekday` around the window, moved `businessDaysBefore` business days earlier (「火曜の1営業日前」).
    // The base days run a week past both ends: a move of up to 5 business days can cross a holiday week.
    const target = WEEKDAY_INDEX[trigger.weekday]
    let base = addDays(from, -14)
    while (dayOfWeek(base) !== target) base = addDays(base, 1)
    for (; base <= addDays(to, 14); base = addDays(base, 7)) {
      let d = base
      for (let i = 0; i < trigger.businessDaysBefore; i++) d = previousBusinessDay(d, own)
      if (d >= from && d <= to) out.add(d)
    }
  } else {
    // Day `day` (or the last) of every month around the window; a day off stays, or moves to the
    // business day before / after (`ifHoliday`) — which may cross into the next or previous month.
    let y = Number(from.slice(0, 4))
    let m = Number(from.slice(5, 7)) - 1
    if (m === 0) { y -= 1; m = 12 }
    const endY = Number(to.slice(0, 4))
    const endM = Number(to.slice(5, 7))
    for (let guard = 0; guard < 24 && (y < endY || (y === endY && m <= endM + 1)); guard++) {
      const day = trigger.day === 'last' ? lastDayOfMonth(y, m) : trigger.day
      let d = `${y}-${pad(m)}-${pad(day)}`
      if (!isBusinessDay(d, own)) {
        if (trigger.ifHoliday === 'before') d = previousBusinessDay(d, own)
        else if (trigger.ifHoliday === 'after') d = nextBusinessDay(d, own)
      }
      if (d >= from && d <= to) out.add(d)
      m += 1
      if (m === 13) { y += 1; m = 1 }
    }
  }
  return [...out].sort()
}

/**
 * The newest slot at or before `nowLocal` (company time, `YYYY-MM-DDTHH:MM`), or null when none lies
 * in the last `LOOK_BACK_DAYS` days.
 */
export function latestJobSlot(trigger: JobTrigger, nowLocal: string, companyHolidays: Iterable<string> = []): string | null {
  const today = nowLocal.slice(0, 10)
  const slots = jobSlotDates(trigger, addDays(today, -LOOK_BACK_DAYS), today, companyHolidays).map(d => `${d}T${trigger.at}`)
  const past = slots.filter(s => s <= nowLocal)
  return past.length > 0 ? past[past.length - 1] : null
}

/** The first slot after `nowLocal` (company time), or null when none lies in the next `LOOK_AHEAD_DAYS` days. */
export function nextJobSlot(trigger: JobTrigger, nowLocal: string, companyHolidays: Iterable<string> = []): string | null {
  const today = nowLocal.slice(0, 10)
  return jobSlotDates(trigger, today, addDays(today, LOOK_AHEAD_DAYS), companyHolidays).map(d => `${d}T${trigger.at}`).find(s => s > nowLocal) ?? null
}
