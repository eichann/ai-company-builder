/**
 * Reading a member's own calendar (stage 2 S7a, `.claude/rules/calendar.md`).
 * Provider-neutral: Google implements it today (`services/google-calendar.ts`);
 * the core role 「予定を読む」 (stage 3) will put another provider behind the
 * same seam without touching the service or the route.
 */
import type { CalendarEvent, CalendarTodayReason } from '../../shared/core/calendar'

export type CalendarRead =
  | { ok: true; events: CalendarEvent[] }
  | { ok: false; reason: CalendarTodayReason }

export interface CalendarReader {
  /**
   * The events of `userId`'s **own** calendar that overlap [fromMs, toMs), read now
   * with that member's own permission. Never throws for a provider failure: it
   * answers the reason instead. Nothing read is stored or logged.
   */
  eventsBetween(companyId: string, userId: string, fromMs: number, toMs: number): Promise<CalendarRead>
}
