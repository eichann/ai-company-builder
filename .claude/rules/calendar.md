---
paths:
  - "shared/core/calendar.ts"
  - "shared/types/calendar.ts"
  - "server/src/ports/calendar.ts"
  - "server/src/services/calendar.ts"
  - "server/src/services/google-calendar.ts"
  - "server/src/routes/calendar.ts"
  - "server/tests/integration/calendar.test.ts"
  - "server/tests/unit/google-calendar.test.ts"
  - "client/shared/calendar.ts"
  - "client/electron/features/calendar/**"
  - "client/src/features/tasks/api.ts"
  - "client/tests/calendar-today.test.ts"
---

# 「今日の予定」 (stage 2 S7a)

The task list shows the member's meetings of today next to their tasks. The server reads the
member's **own** calendar now, with **their own** permission, and keeps nothing (owner: 予定は
やることにしない — read and show, no copy on the server). Today the reader is Google (the
予定と議事録を読む grant of milestone 4, `google-connector.md`); in stage 3 the core role
「予定を読む」 takes its place, so everything Google-specific stays in one module.

## Layers

- `shared/core/calendar.ts`: the neutral event shape `CalendarEvent` (id, title, start / end ISO
  UTC, `allDay`, `online`, `attendeeCount`, `hasExternalAttendees`), `CalendarTodayReason`,
  `dayWindow(nowMs, timeZone)` (the day's date and [from, to) through `Intl`), and
  `DEFAULT_COMPANY_TIME_ZONE = 'Asia/Tokyo'`. There is no company time-zone setting yet; the
  composition passes `timeZoneOf: () => DEFAULT_COMPANY_TIME_ZONE`, the one place a setting
  would plug in.
- `server/src/ports/calendar.ts` `CalendarReader.eventsBetween(companyId, userId, fromMs, toMs)` →
  `{ ok: true, events }` or `{ ok: false, reason }`; never throws for a provider failure.
- `server/src/services/google-calendar.ts` (the Google implementation; the only file to replace
  for the role): `GET /calendar/v3/calendars/primary/events` (`timeMin` / `timeMax` = the day,
  `singleEvents`, `orderBy=startTime`, ≤ 4 pages of 250) through `googleClient.request` with
  scope `calendar.events.readonly`, so every Google switch applies from the next call. Only
  `primary` is ever asked: nothing can name another person's calendar. Event rules
  (`calendarEventOf`): cancelled, declined by the member (`self` + `declined`) and
  `workingLocation` events are dropped; an all-day event is kept as `allDay` spanning the day's
  window; `online` = a `hangoutLink`, a `video` entry point, or a Meet / Zoom / Teams / Webex
  link in the place; `attendeeCount` = people invited (resources such as rooms not counted; the
  organizer counted when there is a guest list); `hasExternalAttendees` = an address outside the
  company's Google domain (`isExternalAddress`, the G3 client's `domain`). Google's refusals →
  reasons (`calendarReasonOf`): no / ended grant, scope missing, token refused, Google 401/403 →
  `not-connected`; not configured, off, vault off, operator stop, not a member, a real secret in
  practice mode → `stopped`; anything else → `unavailable`.
- `server/src/services/calendar.ts` `today(member)`: the company's day, the reader, events sorted
  (all-day first, then start, then end). A reader that cannot read → `ok` with `events: []` and
  the reason; a thrown error → `unavailable`.
- Route `GET /api/companies/:companyId/me/calendar/today` (`routes/calendar.ts`): any member
  (non-member 404, signed out 401), `Cache-Control: no-store`. Answer `CalendarToday`
  (`shared/types/calendar.ts`): `{ date: 'YYYY-MM-DD', timeZone, events, reason: null |
  'not-connected' | 'stopped' | 'unavailable' }` — always 200 for a member.

## What is never kept or answered

Nothing about the events is stored (no table, no cache) or logged (no titles, no attendees); the
one Google client records its usual AI-action-log line (`calendar.events.list`, no content).
Attendee addresses and names never leave `google-calendar.ts`: the answer has a count and a flag.

## The app

- Main: `client/electron/features/calendar/ipc.ts` `calendar:today(companyId)` with the session
  (which stays in main) → the server's `CalendarToday` as is (`isCalendarToday` checks the shape;
  a malformed answer is a failure), or `{ success: false, offline, error }` with a sentence from
  the status only (`calendarErrorText`, `client/shared/calendar.ts`), never the server's text.
  Logged: the status only.
- Renderer: `client/src/features/tasks/api.ts` `getCalendarToday(companyId, reads)` (port
  `CalendarReads = ElectronPort<'getCalendarToday'>`), for the task list (S7b). Not shown on any
  screen yet.

## Tests

`server/tests/integration/calendar.test.ts` against the fake Google (practice redirect): the
member's own meetings with times, title, online, count and the outside flag, no address in the
answer, `no-store`; a colleague's meeting never shows and a member without a permission gets
`not-connected` although colleagues have one (no Google call); the company's day (00:30 Tokyo is
still the previous UTC day); a non-member 404, the same person in another company without Google
→ `stopped`, no Google call; Google off → `stopped`, Google failing → `unavailable`, both 200 and
empty; 「許可をやめる」 → `not-connected`; no title in any table or log line. Mutation-checked:
another member's id passed to the reader, a UTC day, a refusal instead of the empty list, a
logged title, the missing `no-store`, the membership check, the outside flag.
`server/tests/unit/google-calendar.test.ts`: cancelled / declined / working-location / outside
the day dropped; all-day, rooms not counted, a video link in the place.
`client/tests/calendar-today.test.ts`: the member's own route with the session, the answer handed
on as is (a reason too), refusals / malformed / offline as status-built sentences. Permission
matrix row (`MEMBERS`).
