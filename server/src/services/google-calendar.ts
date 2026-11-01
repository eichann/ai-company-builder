/**
 * Google's side of 「今日の予定」 (stage 2 S7a, `.claude/rules/calendar.md`):
 * implements the provider-neutral `CalendarReader` port with the member's
 * own Google permission (the 予定と議事録を読む grant of milestone 4,
 * `calendar.events.readonly`). Everything Google-specific — the API path,
 * the event's shape, the Workspace domain, Google's refusals — stays in this
 * file, so the stage-3 role 「予定を読む」 replaces only this module.
 *
 * Every call goes through the one Google client (`google-client.ts`), so each
 * switch (operator stop, the company's Google off, the vault, the grant, the
 * scope) applies from the next call. Only `primary` — the signed-in member's
 * own calendar — is ever asked for; there is no parameter naming another one.
 * Nothing is stored or logged: titles and attendees are only passed through,
 * and attendee addresses never leave this module (a count and a flag do).
 */
import type { CalendarEvent, CalendarTodayReason } from '../../shared/core/calendar'
import { GOOGLE_SCOPE } from '../../shared/core/google'
import { isExternalAddress } from '../../shared/core/mail'
import type { CalendarRead, CalendarReader } from '../ports/calendar'
import type { GoogleResult } from './google-client'
import type { GoogleRequester } from './google-meetings'

export interface GoogleCalendarDeps {
  request: GoogleRequester
  /** The company's Google Workspace domain (the G3 client's), null when none is set up. */
  internalDomain: (companyId: string) => string | null
}

const MAX_PAGES = 4
const TITLE_MAX = 200
const ID_MAX = 1024
/** Video-call links in an event's place (Zoom, Teams, Meet, Webex) count as online. */
const VIDEO_HOST_RE = /(^|[\s/.])(meet\.google\.com|([a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com|([a-z0-9-]+\.)?webex\.com)\//i

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Why a Google answer cannot give today's list, as the neutral reason. */
export function calendarReasonOf(r: Extract<GoogleResult, { ok: false }>): CalendarTodayReason {
  if (r.kind === 'not-sent') {
    if (['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted', 'token-refused'].includes(r.reason)) return 'not-connected'
    if (['operator-stopped', 'not-configured', 'off', 'vault-off', 'not-member', 'practice-real-secret'].includes(r.reason)) return 'stopped'
  }
  if (r.kind === 'refused' && (r.status === 401 || r.status === 403)) return 'not-connected'
  return 'unavailable'
}

/** An all-day event's `YYYY-MM-DD`, else null. */
const dateOnly = (v: string | null): string | null => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)

/**
 * One Google event as the neutral shape, or null when it is not a meeting of the
 * member's day: cancelled, declined by the member, a working-location marker, or
 * outside [fromMs, toMs). All-day events are kept with `allDay` and the day's window.
 */
export function calendarEventOf(raw: unknown, domain: string | null, fromMs: number, toMs: number): CalendarEvent | null {
  if (!isObj(raw) || raw.status === 'cancelled' || raw.eventType === 'workingLocation') return null
  const id = str(raw.id)
  if (!id || id.length > ID_MAX) return null
  const attendees = (Array.isArray(raw.attendees) ? raw.attendees : []).filter(isObj)
  if (attendees.some(a => a.self === true && a.responseStatus === 'declined')) return null

  let start: number, end: number, allDay = false
  if (isObj(raw.start) && dateOnly(str(raw.start.date))) {
    // An all-day event (Google's own days; timeMin / timeMax already chose the ones covering today):
    // shown as today's whole window.
    if (!isObj(raw.end) || !dateOnly(str(raw.end.date))) return null
    allDay = true
    start = fromMs
    end = toMs
  } else {
    start = Date.parse(isObj(raw.start) ? str(raw.start.dateTime) ?? '' : '')
    end = Date.parse(isObj(raw.end) ? str(raw.end.dateTime) ?? '' : '')
    if (Number.isNaN(start) || Number.isNaN(end) || end <= fromMs || start >= toMs) return null
  }

  const people = attendees.filter(a => a.resource !== true && typeof a.email === 'string')
  const organizer = isObj(raw.organizer) ? str(raw.organizer.email)?.toLowerCase() ?? null : null
  const emails = new Set(people.map(a => (a.email as string).toLowerCase()))
  // The organizer counts as invited when there is a guest list (a group calendar's address does not).
  if (organizer && emails.size > 0 && !organizer.endsWith('calendar.google.com')) emails.add(organizer)
  const conf = isObj(raw.conferenceData) ? raw.conferenceData : null
  const online = typeof raw.hangoutLink === 'string'
    || (conf !== null && Array.isArray(conf.entryPoints) && conf.entryPoints.some(e => isObj(e) && e.entryPointType === 'video'))
    || VIDEO_HOST_RE.test(str(raw.location) ?? '')
  return {
    id,
    title: (str(raw.summary) ?? '').trim().slice(0, TITLE_MAX),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    allDay,
    online,
    attendeeCount: emails.size,
    hasExternalAttendees: domain !== null && [...emails].some(e => isExternalAddress(e, [domain])),
  }
}

export function createGoogleCalendar(deps: GoogleCalendarDeps): CalendarReader {
  return {
    async eventsBetween(companyId, userId, fromMs, toMs): Promise<CalendarRead> {
      const domain = deps.internalDomain(companyId)
      const events: CalendarEvent[] = []
      let pageToken: string | null = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await deps.request(companyId, userId, {
          api: 'calendar', method: 'GET', path: '/calendar/v3/calendars/primary/events',
          query: {
            timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
            singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
            ...(pageToken ? { pageToken } : {}),
          },
          scope: GOOGLE_SCOPE.calendarEventsReadonly, operation: 'calendar.events.list',
        })
        if (!r.ok) return { ok: false, reason: calendarReasonOf(r) }
        const body = isObj(r.json) ? r.json : {}
        for (const item of Array.isArray(body.items) ? body.items : []) {
          const e = calendarEventOf(item, domain, fromMs, toMs)
          if (e) events.push(e)
        }
        pageToken = str(body.nextPageToken)
        if (!pageToken) break
      }
      return { ok: true, events }
    },
  }
}
