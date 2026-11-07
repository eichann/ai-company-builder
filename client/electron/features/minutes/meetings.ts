// Meetings for their attendees (.claude/rules/minutes.md "Meetings for their attendees", owner
// decision 2026-11-04): the task list's 「議事録が届きました」 and the meeting card's buttons, with the
// member's session (it stays here). Ids, titles, times, counts and member names only — never
// minutes text. An older server without these routes answers nothing usable: no banner, no
// buttons (quietly; the card still shows as before).

import { RECORD_ID_RE } from '../../../../shared/core/records'
import type { RecordDetail } from '../../../../shared/types/records'
import type { MeetingArrival, MeetingArrivals } from '../../../../shared/types/minutes'
import {
  MEETING_NO_ACCESS_TEXT, MINUTES_ID_RE, MINUTES_OFFLINE_TEXT,
  type MeetingArrivalsResult, type MeetingArrivalView, type MeetingCardStateResult, type InviteSet, type MeetingInviteChoicesResult, type MeetingInviteResult, type MeetingPressResult, type MinutesActionResult,
} from '../../../shared/minutes-app'
import { reviewOf } from '../../../shared/task-card'

export interface MeetingsDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** ［AI に読ませる］ was accepted: the received minutes (the AI turn runner's queue) are read again now. */
  onReadRequested?: (companyId: string) => void
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const MEMBER = /^[A-Za-z0-9_-]{1,100}$/
const BAD_INPUT = { success: false as const, error: '入力が正しくありません。' }
const STATUSES = new Set<MeetingArrival['status']>(['arrived', 'asked', 'reading', 'read', 'skipped', 'failed'])
/** A meeting record's state → its place in the reading (`received` is the AI's turn after ［AI に読ませる］). */
const STATUS_OF: Record<string, MeetingArrival['status']> = { arrived: 'arrived', received: 'asked', reading: 'reading', read: 'read', skipped: 'skipped', failed: 'failed' }

type Answer = { status: number; json: { data?: unknown; error?: unknown; code?: unknown; version?: unknown } | null } | null

/** A server sentence for the member (Japanese), else a plain fallback. */
function memberText(a: Answer, fallback: string): string {
  const error = a?.json?.error
  return typeof error === 'string' && /[぀-ヿ一-鿿]/.test(error) ? error.slice(0, 300) : fallback
}

/** One item of the server's answer, checked field by field (anything malformed is left out). */
function arrivalOf(x: unknown): MeetingArrival | null {
  const a = x as Partial<MeetingArrival> | null
  if (!a || typeof a.recordId !== 'string' || !MINUTES_ID_RE.test(a.recordId) || typeof a.title !== 'string' || typeof a.version !== 'number') return null
  if (!STATUSES.has(a.status as MeetingArrival['status'])) return null
  const by = a.by && typeof a.by.memberId === 'string' && typeof a.by.displayName === 'string' ? { memberId: a.by.memberId, displayName: a.by.displayName.slice(0, 100) } : null
  return {
    recordId: a.recordId, title: a.title.slice(0, 200), version: a.version,
    meetingAt: typeof a.meetingAt === 'string' ? a.meetingAt : null,
    status: a.status as MeetingArrival['status'],
    attendeeCount: typeof a.attendeeCount === 'number' && a.attendeeCount >= 0 ? a.attendeeCount : 0,
    by, byYou: a.byYou === true, series: a.series === true, autoSeries: a.autoSeries === true,
  }
}

/** What the reading made, from the meeting's links: decisions not retracted, tasks from it but the review task. */
export function madeOf(detail: RecordDetail): { decisions: number; proposals: number } {
  let decisions = 0
  let proposals = 0
  for (const l of detail.links) {
    const r = l.record
    if (!r) continue
    if (r.type === 'decision' && r.state !== 'retracted') decisions++
    if (r.type === 'task' && r.fields.task_kind !== 'minutes_review' && r.state !== 'cancelled') proposals++
  }
  return { decisions, proposals }
}

export function createMeetingsApi(deps: MeetingsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  /** `<company>:<meeting>@<version>` → what its reading made: a meeting's links change only with its version… */
  const madeCache = new Map<string, { decisions: number; proposals: number }>()
  let me: { cookies: string; id: string } | null = null

  async function request(url: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<Answer> {
    const cookies = deps.cookies()
    if (cookies.length === 0) return null
    try {
      const res = await doFetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: await res.json().catch(() => null) as NonNullable<Answer>['json'] }
    } catch {
      return null
    }
  }
  const base = () => deps.baseUrl().replace(/\/+$/, '')
  const call = (companyId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Answer> =>
    base() ? request(`${base()}/api/companies/${encodeURIComponent(companyId)}${path}`, method, body) : Promise.resolve(null)
  const meetingPath = (id: string) => `/me/minutes/item/${encodeURIComponent(id)}`

  async function myId(): Promise<string | null> {
    const cookies = deps.cookies().join('; ')
    if (me && me.cookies === cookies) return me.id
    if (!base()) return null
    const a = await request(`${base()}/api/me`, 'GET')
    const id = (a?.json?.data as { id?: unknown } | undefined)?.id
    if (a?.status !== 200 || typeof id !== 'string') return null
    me = { cookies, id }
    return id
  }

  async function detailOf(companyId: string, id: string): Promise<RecordDetail | null> {
    const a = await call(companyId, 'GET', `/records/item/${encodeURIComponent(id)}`)
    const d = a?.status === 200 ? a.json?.data as RecordDetail | undefined : undefined
    return d?.record && Array.isArray(d.links) ? d : null
  }

  /**
   * The names of the 責任者 who cannot read this meeting's decisions (`decisionChecks`, decision version 6),
   * for 「〇〇さんはこの会議を見られません」: the members list is asked only when there is one.
   */
  async function namesOf(companyId: string, detail: RecordDetail): Promise<Record<string, string>> {
    const ids = new Set(Object.values(detail.decisionChecks ?? {}).flatMap(c => c.cannotRead))
    if (ids.size === 0) return {}
    const a = await call(companyId, 'GET', '/members')
    const out: Record<string, string> = {}
    for (const m of (a?.status === 200 && Array.isArray(a.json?.data) ? a.json.data : []) as Array<{ userId?: unknown; name?: unknown }>) {
      if (typeof m.userId === 'string' && ids.has(m.userId) && typeof m.name === 'string' && m.name.trim()) out[m.userId] = m.name.trim().slice(0, 100)
    }
    return out
  }

  /** The reading's outputs of a read meeting, looked up once per version. */
  async function made(companyId: string, item: MeetingArrival, detail?: RecordDetail | null): Promise<MeetingArrivalView['made']> {
    if (item.status !== 'read') return null
    const key = `${companyId}:${item.recordId}@${item.version}`
    const known = madeCache.get(key)
    if (known) return known
    const d = detail ?? await detailOf(companyId, item.recordId)
    if (!d) return null
    const counts = madeOf(d)
    madeCache.set(key, counts)
    return counts
  }

  async function arrivalsOf(companyId: string): Promise<MeetingArrival[] | null> {
    const a = await call(companyId, 'GET', '/me/minutes/arrivals')
    // An older server (404 without the route), records off, offline: no banner.
    if (a?.status !== 200) return null
    const items = (a.json?.data as Partial<MeetingArrivals> | undefined)?.items
    return Array.isArray(items) ? items.map(arrivalOf).filter((x): x is MeetingArrival => x !== null) : null
  }

  async function press(companyId: string, id: string, what: 'read-request' | 'skip', expectedVersion: number): Promise<MeetingPressResult> {
    if (!COMPANY.test(companyId) || !MINUTES_ID_RE.test(id) || !Number.isInteger(expectedVersion)) return BAD_INPUT
    const a = await call(companyId, 'POST', `${meetingPath(id)}/${what}`, { expectedVersion })
    if (!a) return { success: false, error: MINUTES_OFFLINE_TEXT }
    const version = (a.json?.data as { version?: unknown } | undefined)?.version
    if (a.status === 200 && typeof version === 'number') {
      if (what === 'read-request') deps.onReadRequested?.(companyId)
      return { success: true, version }
    }
    log.warn(`[minutes] ${what}: answered ${a.status}`)
    if (a.json?.code === 'MINUTES_NO_ACCESS') return { success: false, error: MEETING_NO_ACCESS_TEXT, noAccess: true }
    return { success: false, error: memberText(a, `できませんでした（サーバーの応答 ${a.status}）。`) }
  }

  return {
    /** 「議事録が届きました」: the member's meetings of the last days, each read one with what it made. */
    async arrivals(companyId: string): Promise<MeetingArrivalsResult> {
      if (!COMPANY.test(companyId)) return { available: false, items: [] }
      const items = await arrivalsOf(companyId)
      if (!items) return { available: false, items: [] }
      return { available: true, items: await Promise.all(items.map(async item => ({ ...item, made: await made(companyId, item) }))) }
    },

    /** One meeting for its card: from the banner's answer when it is there, else from the record (older than the banner). */
    async meeting(companyId: string, id: string): Promise<MeetingCardStateResult> {
      if (!COMPANY.test(companyId) || !MINUTES_ID_RE.test(id)) return BAD_INPUT
      const [detail, items, mine, google] = await Promise.all([detailOf(companyId, id), arrivalsOf(companyId), myId(), call(companyId, 'GET', '/me/google')])
      if (!detail || detail.record.type !== 'meeting') return { success: false, error: MINUTES_OFFLINE_TEXT }
      // Without the banner's route (an older server) the card offers nothing new.
      if (!items) return { success: false, error: '' }
      const r = detail.record
      const listed = items.find(i => i.recordId === id)
      const status = STATUS_OF[r.state ?? '']
      if (!status) return { success: false, error: '' }
      const assignee = typeof r.fields.assignee === 'string' ? r.fields.assignee : null
      const at = r.fields.meeting_at
      // The record is read now: its state and version win over the banner's answer of a moment ago.
      const item: MeetingArrival = listed
        ? { ...listed, title: r.title || listed.title, version: r.version, status }
        : {
          recordId: r.id, title: r.title || '会議', version: r.version, meetingAt: typeof at === 'string' ? at : null, status,
          attendeeCount: 0, by: null, byYou: !!assignee && assignee === mine && status !== 'arrived' && status !== 'skipped', series: false, autoSeries: false,
        }
      return {
        success: true,
        meeting: { ...item, made: await made(companyId, item, detail) },
        review: status === 'read' && mine ? reviewOf(detail, mine, await namesOf(companyId, detail)) : null,
        ...(google?.status === 200 && ((google.json?.data as { renew?: unknown } | undefined)?.renew as unknown[] | undefined)?.includes('minutes') ? { renewGoogle: true as const } : {}),
      }
    },

    /** ［AI に読ませる］: the meeting becomes the AI's turn on this member's PC (the server checks their Google first). */
    requestReading: (companyId: string, id: string, expectedVersion: number) => press(companyId, id, 'read-request', expectedVersion),

    /** ［読まない］: nobody is asked again; the record stays (取り消す is the generic undo of that entry). */
    skip: (companyId: string, id: string, expectedVersion: number) => press(companyId, id, 'skip', expectedVersion),

    /** 「この定例は次から自動で読む」 / 「次から自動で読まない」: the member's own choice for the series. */
    async autoSeries(companyId: string, id: string, auto: boolean): Promise<MinutesActionResult> {
      if (!COMPANY.test(companyId) || !MINUTES_ID_RE.test(id) || typeof auto !== 'boolean') return BAD_INPUT
      const a = await call(companyId, 'PUT', `${meetingPath(id)}/auto-series`, { auto })
      if (!a) return { success: false, error: MINUTES_OFFLINE_TEXT }
      if (a.status === 200) return { success: true }
      log.warn(`[minutes] auto-series: answered ${a.status}`)
      return { success: false, error: memberText(a, `できませんでした（サーバーの応答 ${a.status}）。`) }
    },

    /**
     * ［招待する］: members — and groups / departments, written as a place rule's subjects — added to a
     * members-only record's list (never undone; the server checks the caller is on it and who may add
     * a group or a department).
     */
    async invite(companyId: string, recordId: string, add: string[], expectedVersion: number, sets: InviteSet[] = []): Promise<MeetingInviteResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !Number.isInteger(expectedVersion)) return BAD_INPUT
      if (!Array.isArray(add) || !add.every(m => typeof m === 'string' && MEMBER.test(m))) return BAD_INPUT
      if (!Array.isArray(sets) || !sets.every(s => s && (s.type === 'group' || s.type === 'department') && typeof s.id === 'string' && MEMBER.test(s.id))) return BAD_INPUT
      const people = [...new Set(add)]
      if (people.length + sets.length === 0 || people.length + sets.length > 200) return BAD_INPUT
      const subjects = [...people, ...sets.map(s => ({ subjectType: s.type, subjectId: s.id }))]
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/members`, { add: subjects, expectedVersion })
      if (!a) return { success: false, error: MINUTES_OFFLINE_TEXT }
      if (a.status === 200 || a.status === 201) {
        const data = a.json?.data as { added?: unknown; addedSets?: unknown } | undefined
        const added = Array.isArray(data?.added) ? data.added.filter((x): x is string => typeof x === 'string') : []
        const addedSets = Array.isArray(data?.addedSets)
          ? data.addedSets.filter((x): x is InviteSet => !!x && typeof x === 'object' && ((x as InviteSet).type === 'group' || (x as InviteSet).type === 'department') && typeof (x as InviteSet).id === 'string')
          : []
        return { success: true, added, addedSets }
      }
      log.warn(`[minutes] invite: answered ${a.status}`)
      return { success: false, error: memberText(a, `招待できませんでした（サーバーの応答 ${a.status}）。`) }
    },

    /** What ［招待する］ may offer besides people (the server's answer, reshaped only). */
    async inviteChoices(companyId: string, recordId: string): Promise<MeetingInviteChoicesResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      const a = await call(companyId, 'GET', `/records/item/${encodeURIComponent(recordId)}/members/choices`)
      if (!a) return { success: false, error: MINUTES_OFFLINE_TEXT }
      if (a.status !== 200) {
        log.warn(`[minutes] invite choices: answered ${a.status}`)
        return { success: false, error: memberText(a, `読み込めませんでした（サーバーの応答 ${a.status}）。`) }
      }
      const d = (a.json?.data ?? {}) as Record<string, unknown>
      const named = (v: unknown) => Array.isArray(v)
        ? v.filter((x): x is { id: string; name: string } => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' && typeof (x as { name?: unknown }).name === 'string')
          .map(x => ({ id: x.id, name: x.name }))
        : []
      const listed = Array.isArray(d.listed)
        ? d.listed.filter((x): x is InviteSet & { name: string } => !!x && typeof x === 'object' && ((x as InviteSet).type === 'group' || (x as InviteSet).type === 'department')
          && typeof (x as InviteSet).id === 'string' && typeof (x as { name?: unknown }).name === 'string').map(x => ({ type: x.type, id: x.id, name: x.name }))
        : []
      return { success: true, maySets: d.maySets === true, groups: named(d.groups), departments: named(d.departments), listed }
    },
  }
}

export type MeetingsApi = ReturnType<typeof createMeetingsApi>
