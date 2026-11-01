/**
 * Google's event → the neutral 「今日の予定」 shape (`services/google-calendar.ts`,
 * `.claude/rules/calendar.md`): the cases the fake Google's seed has no example of.
 */
import { describe, expect, it } from 'vitest'
import { calendarEventOf } from '../../src/services/google-calendar'

const FROM = Date.parse('2026-11-05T00:00:00+09:00')
const TO = Date.parse('2026-11-06T00:00:00+09:00')
const timed = (extra: Record<string, unknown> = {}) => ({
  id: 'ev1', status: 'confirmed', summary: ' 打ち合わせ ',
  start: { dateTime: '2026-11-05T10:00:00+09:00' }, end: { dateTime: '2026-11-05T11:00:00+09:00' }, ...extra,
})

describe('calendarEventOf', () => {
  it('drops what is not a meeting of the member\'s day: cancelled, declined by the member, a working-location marker, outside the day', () => {
    expect(calendarEventOf(timed({ status: 'cancelled' }), 'div.example', FROM, TO)).toBeNull()
    expect(calendarEventOf(timed({ attendees: [{ email: 'sato@div.example', self: true, responseStatus: 'declined' }] }), 'div.example', FROM, TO)).toBeNull()
    expect(calendarEventOf(timed({ eventType: 'workingLocation' }), 'div.example', FROM, TO)).toBeNull()
    expect(calendarEventOf(timed({ start: { dateTime: '2026-11-06T10:00:00+09:00' }, end: { dateTime: '2026-11-06T11:00:00+09:00' } }), 'div.example', FROM, TO)).toBeNull()
    expect(calendarEventOf(timed({ attendees: [{ email: 'sato@div.example', self: true, responseStatus: 'accepted' }] }), 'div.example', FROM, TO)).not.toBeNull()
  })

  it('an all-day event spans the day; rooms are not people; a video link in the place counts as online', () => {
    const e = calendarEventOf({
      id: 'ev2', summary: '展示会', start: { date: '2026-11-05' }, end: { date: '2026-11-06' },
      location: 'https://us02web.zoom.us/j/123',
      attendees: [
        { email: 'sato@div.example', self: true, responseStatus: 'accepted' },
        { email: 'room-1@resource.calendar.google.com', resource: true, responseStatus: 'accepted' },
        { email: 'guest@a-corp.example', responseStatus: 'needsAction' },
      ],
    }, 'div.example', FROM, TO)
    expect(e).toEqual({
      id: 'ev2', title: '展示会', start: new Date(FROM).toISOString(), end: new Date(TO).toISOString(),
      allDay: true, online: true, attendeeCount: 2, hasExternalAttendees: true,
    })
    const inPerson = calendarEventOf(timed({ location: '本社 3F 会議室' }), 'div.example', FROM, TO)
    expect(inPerson).toMatchObject({ title: '打ち合わせ', online: false, attendeeCount: 0, hasExternalAttendees: false })
  })
})
