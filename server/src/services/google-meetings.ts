/**
 * Reading meetings from Google for the minutes (milestone 4 G7,
 * `.claude/rules/minutes.md`): the member's calendar events in a window, the
 * Meet conference of an event, its smart notes and transcripts, and a
 * document's text and version. Every call goes through the one Google client
 * (`services/google-client.ts` `request`) with the member's own grant, so
 * every switch (operator stop, the company's Google off, the vault, the
 * grant, the scope) is checked from the next call.
 *
 * Nothing here is stored or logged: the callers keep opaque ids only, and
 * the text goes to the one route that hands it to the member's AI.
 */
import { GOOGLE_SCOPE } from '../../shared/core/google'
import { MINUTES_TEXT_MAX } from '../../shared/core/minutes'
import type { GoogleRequest, GoogleResult } from './google-client'

export type GoogleRequester = (companyId: string, userId: string, req: GoogleRequest) => Promise<GoogleResult>

/** A Google call that did not give an answer we can use (the caller maps it to a refusal). */
export class GoogleReadFailed extends Error {
  constructor(readonly result: Extract<GoogleResult, { ok: false }> | { ok: false; kind: 'unreadable'; reason: 'unreadable' }) {
    super(`google read failed: ${result.kind} ${result.reason}`)
  }
}

export interface MeetingAttendee {
  /** Lower-case address as Google gave it (never logged). */
  email: string
  /** Google's display name (may be empty). */
  name: string
  organizer: boolean
}

export interface MeetEvent {
  eventId: string
  title: string
  /** ISO 8601 (UTC). */
  start: string
  end: string
  meetingCode: string
  organizer: string | null
  attendees: MeetingAttendee[]
}

export interface MeetArtifactDoc {
  kind: 'notes' | 'transcript'
  docId: string
}

const MAX_EVENT_PAGES = 4
const MEETING_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/
/** A conference counts for an event when it started within this much of the event. */
const CONFERENCE_SLACK_MS = 3 * 60 * 60 * 1000
const TRUNCATED = '\n【長いため、ここから先は省きました】'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function eventOf(raw: unknown): MeetEvent | null {
  if (!isObj(raw) || raw.status === 'cancelled') return null
  const eventId = str(raw.id)
  const conf = isObj(raw.conferenceData) ? raw.conferenceData : null
  const code = conf ? str(conf.conferenceId) : null
  const isMeet = conf && isObj(conf.conferenceSolution) && isObj(conf.conferenceSolution.key) && conf.conferenceSolution.key.type === 'hangoutsMeet'
  const start = isObj(raw.start) ? str(raw.start.dateTime) : null
  const end = isObj(raw.end) ? str(raw.end.dateTime) : null
  if (!eventId || !ID_RE.test(eventId) || !code || !isMeet || !MEETING_CODE_RE.test(code) || !start || !end) return null
  const s = Date.parse(start)
  const e = Date.parse(end)
  if (Number.isNaN(s) || Number.isNaN(e)) return null
  const organizer = isObj(raw.organizer) ? str(raw.organizer.email)?.toLowerCase() ?? null : null
  const attendees: MeetingAttendee[] = []
  for (const a of Array.isArray(raw.attendees) ? raw.attendees : []) {
    if (!isObj(a) || typeof a.email !== 'string' || a.resource === true) continue
    attendees.push({ email: a.email.toLowerCase(), name: str(a.displayName) ?? '', organizer: a.organizer === true || a.email.toLowerCase() === organizer })
  }
  if (organizer && !attendees.some(a => a.email === organizer)) attendees.push({ email: organizer, name: '', organizer: true })
  return {
    eventId, title: (str(raw.summary) ?? '').trim(), start: new Date(s).toISOString(), end: new Date(e).toISOString(),
    meetingCode: code, organizer, attendees,
  }
}

/** Docs' plain-text export: no byte-order mark, `\n` line ends, NFC. */
export function cleanExportText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC')
}

export function createGoogleMeetings(request: GoogleRequester) {
  async function call(companyId: string, userId: string, req: GoogleRequest): Promise<Extract<GoogleResult, { ok: true }>> {
    const r = await request(companyId, userId, req)
    if (!r.ok) throw new GoogleReadFailed(r)
    return r
  }

  return {
    /** The member's events with a Meet conference in [from, to] (single events, by start time). */
    async meetEvents(companyId: string, userId: string, from: Date, to: Date): Promise<MeetEvent[]> {
      const out: MeetEvent[] = []
      let pageToken: string | null = null
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const r = await call(companyId, userId, {
          api: 'calendar', method: 'GET', path: '/calendar/v3/calendars/primary/events',
          query: {
            timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
            ...(pageToken ? { pageToken } : {}),
          },
          scope: GOOGLE_SCOPE.calendarEventsReadonly, operation: 'calendar.events.list',
        })
        const body = isObj(r.json) ? r.json : {}
        for (const item of Array.isArray(body.items) ? body.items : []) {
          const e = eventOf(item)
          if (e) out.push(e)
        }
        pageToken = str(body.nextPageToken)
        if (!pageToken) break
      }
      return out
    },

    /** One event of the member's calendar (null when it is not there any more). */
    async event(companyId: string, userId: string, eventId: string): Promise<MeetEvent | null> {
      if (!ID_RE.test(eventId)) return null
      const r = await request(companyId, userId, {
        api: 'calendar', method: 'GET', path: `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        scope: GOOGLE_SCOPE.calendarEventsReadonly, operation: 'calendar.events.get',
      })
      if (!r.ok && r.kind === 'refused' && (r.status === 404 || r.status === 410)) return null
      if (!r.ok) throw new GoogleReadFailed(r)
      return eventOf(r.json)
    },

    /** The conference record of a Meet code that started near the event (null when none yet). */
    async conferenceFor(companyId: string, userId: string, event: MeetEvent): Promise<string | null> {
      const from = new Date(Date.parse(event.start) - CONFERENCE_SLACK_MS).toISOString()
      const to = new Date(Date.parse(event.end) + CONFERENCE_SLACK_MS).toISOString()
      const r = await call(companyId, userId, {
        api: 'meet', method: 'GET', path: '/v2/conferenceRecords',
        query: { filter: `space.meeting_code = "${event.meetingCode}" AND start_time >= "${from}" AND start_time <= "${to}"`, pageSize: '10' },
        scope: GOOGLE_SCOPE.meetReadonly, operation: 'meet.conferenceRecords.list',
      })
      const body = isObj(r.json) ? r.json : {}
      const records = (Array.isArray(body.conferenceRecords) ? body.conferenceRecords : [])
        .flatMap(c => {
          const name = isObj(c) ? str(c.name) : null
          const id = name?.startsWith('conferenceRecords/') ? name.slice('conferenceRecords/'.length) : null
          const at = isObj(c) ? Date.parse(str(c.startTime) ?? '') : NaN
          return id && ID_RE.test(id) && !Number.isNaN(at) ? [{ id, at }] : []
        })
        .sort((a, b) => Math.abs(a.at - Date.parse(event.start)) - Math.abs(b.at - Date.parse(event.start)))
      return records[0]?.id ?? null
    },

    /** The conference's smart notes and transcripts whose document is generated (notes first). */
    async documents(companyId: string, userId: string, conferenceId: string): Promise<MeetArtifactDoc[]> {
      if (!ID_RE.test(conferenceId)) return []
      const out: MeetArtifactDoc[] = []
      for (const [kind, plural] of [['notes', 'smartNotes'], ['transcript', 'transcripts']] as const) {
        const r = await call(companyId, userId, {
          api: 'meet', method: 'GET', path: `/v2/conferenceRecords/${encodeURIComponent(conferenceId)}/${plural}`, query: { pageSize: '10' },
          scope: GOOGLE_SCOPE.meetReadonly, operation: `meet.${plural}.list`,
        })
        const body = isObj(r.json) ? r.json : {}
        for (const a of Array.isArray(body[plural]) ? body[plural] as unknown[] : []) {
          if (!isObj(a) || a.state !== 'FILE_GENERATED' || !isObj(a.docsDestination)) continue
          const docId = str(a.docsDestination.document)
          if (docId && ID_RE.test(docId)) out.push({ kind, docId })
        }
      }
      return out
    },

    /** A document's version (Drive's `version`, a number as text). */
    async docVersion(companyId: string, userId: string, docId: string): Promise<string> {
      const r = await call(companyId, userId, {
        api: 'drive', method: 'GET', path: `/drive/v3/files/${encodeURIComponent(docId)}`, query: { fields: 'id,version' },
        scope: GOOGLE_SCOPE.driveMeetReadonly, operation: 'drive.files.get',
      })
      const v = isObj(r.json) ? r.json.version : null
      if (typeof v !== 'string' && typeof v !== 'number') throw new GoogleReadFailed({ ok: false, kind: 'unreadable', reason: 'unreadable' })
      return String(v)
    },

    /** A document as plain text (BOM removed, `\n`, NFC), at most `max` characters with a notice. */
    async docText(companyId: string, userId: string, docId: string, max = MINUTES_TEXT_MAX): Promise<{ text: string; truncated: boolean }> {
      const r = await call(companyId, userId, {
        api: 'drive', method: 'GET', path: `/drive/v3/files/${encodeURIComponent(docId)}/export`, query: { mimeType: 'text/plain' },
        scope: GOOGLE_SCOPE.driveMeetReadonly, operation: 'drive.files.export',
      })
      const raw = r.text ?? (typeof r.json === 'string' || typeof r.json === 'number' ? String(r.json) : null)
      if (raw === null) throw new GoogleReadFailed({ ok: false, kind: 'unreadable', reason: 'unreadable' })
      const text = cleanExportText(raw)
      if (text.length <= max) return { text, truncated: false }
      return { text: `${text.slice(0, Math.max(0, max - TRUNCATED.length)).trimEnd()}${TRUNCATED}`, truncated: true }
    },
  }
}

export type GoogleMeetings = ReturnType<typeof createGoogleMeetings>
