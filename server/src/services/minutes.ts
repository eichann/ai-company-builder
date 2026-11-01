/**
 * The minutes intake (milestone 4 G7, `.claude/rules/minutes.md`; design
 * 節目4 §1-2, §3-1, §3-7, §9 q5/q14/q15, owner §11).
 *
 * - **Discovery** (`check`): when the member's app asks (at start, every 10
 *   minutes, on a button — no server timer), the member's own calendar is read
 *   with their own Google permission; only Meet meetings with someone from
 *   outside the company's Google domain count (internal-only meetings are never
 *   read further). For each with generated notes / transcript, one `minutes`
 *   record (server only, in the company's minutes folder) per conference —
 *   the organizer is the assignee when they are a member who can read it,
 *   else the member who found it. Stored: the meeting's title, time, attending
 *   member ids, the count of outside attendees, opaque Google ids and the
 *   documents' versions. **No text of the minutes is ever stored or logged.**
 * - **Deal**: candidates are found mechanically (outside attendees' email
 *   domains ↔ imported customers' `domain`; the meeting title ↔ deal titles);
 *   exactly one readable open deal is linked, otherwise a person or their AI
 *   chooses (`linkDeal`). Nothing is written to the outside system here.
 * - **Text** (`text`): read again from Google with the requesting member's own
 *   permission, for the assignee or an attendee who may read the record; handed
 *   back once, marked as outside text (data, not instructions) with the
 *   instruction-like flags. The consultation AI reads it (no separate reader AI,
 *   owner §11) and makes outputs with the typed tools; the server's gates decide.
 */
import { MINUTES_TEXT_FOOTER, MINUTES_TEXT_HEADER, MINUTES_TEXT_MAX } from '../../shared/core/minutes'
import { findInstructionLikeText, INSTRUCTION_LIKE_WORDS } from '../../shared/core/instruction-like'
import { isExternalAddress, emailDomain, normalizeEmail } from '../../shared/core/mail'
import { foldAsciiCase, nameKey, normalizeRepoPath } from '../../shared/core/paths'
import { findPrivateScope, FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { newRecordId, RECORD_ID_RE } from '../../shared/core/records'
import type { MinutesCheckResult, MinutesDealSummary, MinutesFolderSetting, MinutesLinkDealResult, MinutesText } from '../../shared/types/minutes'
import type { Clock } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { GoogleReadFailed, type GoogleMeetings, type MeetEvent, type MeetingAttendee } from './google-meetings'
import { ok, refuse, type Outcome, type Refusal } from './outcome'
import { recordReader, type RecordReader } from './record-access'
import type { ServiceActor, ServiceRecordWriter } from './record-engine'
import { currentTypes } from './record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from './records'

export interface MinutesMember {
  userId: string
  email: string
  name: string
  role: string
}

export interface MinutesServiceDeps {
  companyData: CompanyDataSource
  writer: ServiceRecordWriter
  meetings: GoogleMeetings
  /** The company's members with their ACB email and display name (compared only; never logged). */
  members: (companyId: string) => MinutesMember[]
  clock: Clock
  tokenDigest: TokenDigest
}

/** How far back the calendar is read (design §1-2: the last few days). */
export const MINUTES_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000
/** A record 「読んでいる」 longer than this may be put back to 「届いた」 (design §1-8). */
export const MINUTES_READING_STALE_MS = 30 * 60 * 1000
const MAX_MEETINGS_PER_CHECK = 50

export const MINUTES_FOLDER_REFUSED = {
  error: 'この場所は議事録の置き場所に選べません。部署のフォルダを選んでください。',
  code: 'MINUTES_FOLDER_REFUSED',
}
export const MINUTES_NOT_YOURS = {
  error: 'この議事録は、担当の人か会議に出た人だけが読めます。',
  code: 'MINUTES_NOT_YOURS',
}
const NO_FOLDER_MESSAGE = '議事録の置き場所がまだ決まっていません。管理者に、管理画面の「つなぎ先」→「Google」で置き場所を選んでもらってください。'
const FOLDER_UNUSABLE_MESSAGE = '議事録の置き場所が使えなくなっています。管理者に、管理画面の「つなぎ先」→「Google」で置き場所を選び直してもらってください。'

const GOOGLE_ACTOR: ServiceActor = { id: 'google', kind: 'external', source: 'google' }

/** The opaque pointer kept in `source_ref`: Google ids only, no text. */
interface SourceRef {
  conference: string
  event: string
  docs: Array<{ kind: 'notes' | 'transcript'; id: string }>
}

function parseRef(raw: LedgerValue | undefined): SourceRef | null {
  if (typeof raw !== 'string') return null
  try {
    const r = JSON.parse(raw) as SourceRef
    if (typeof r.conference !== 'string' || typeof r.event !== 'string' || !Array.isArray(r.docs)) return null
    if (!r.docs.every(d => d && (d.kind === 'notes' || d.kind === 'transcript') && typeof d.id === 'string')) return null
    return r
  } catch {
    return null
  }
}

function fieldsOf(records: CompanyData['records'], id: string): { state: string | null; fields: Record<string, LedgerValue>; version: number; updatedAt: string | null } {
  const s = records.states([id])[0]
  let fields: Record<string, LedgerValue> = {}
  try { fields = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { fields = {} }
  return { state: s?.state ?? null, fields, version: s?.version ?? 0, updatedAt: s?.updatedAt ?? null }
}

function attendeeIds(raw: LedgerValue | undefined): string[] {
  if (typeof raw !== 'string') return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Comparison form of a title: NFC, A–Z folded, no spaces or brackets. */
const squash = (s: string) => foldAsciiCase(s.normalize('NFKC')).replace(/[\s()（）「」【】[\]・、。,.]+/g, '')

/** Why a Google call failed, as the member's refusal (never Google's message). */
export function googleRefusal(err: GoogleReadFailed): Refusal {
  const r = err.result
  if (r.kind === 'not-sent') {
    if (['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted', 'token-refused'].includes(r.reason)) {
      return refuse('conflict', 'Google の許可がありません。アプリの「設定」→「Google」で、議事録を読む許可をしてください。', { code: 'GOOGLE_NOT_CONNECTED' })
    }
    if (['operator-stopped', 'not-configured', 'off', 'vault-off', 'not-member', 'practice-real-secret'].includes(r.reason)) {
      return refuse('forbidden', 'この会社では、いま Google につなげません（止められているか、まだ設定されていません）。', { code: 'GOOGLE_STOPPED' })
    }
  }
  if (r.kind === 'refused' && (r.status === 403 || r.status === 404)) {
    return refuse('forbidden', 'あなたの Google の許可では、この議事録の文書を開けません。', { code: 'MINUTES_NO_ACCESS' })
  }
  return refuse('unavailable', 'Google から読めませんでした。少し待ってからもう一度お試しください。', { code: 'GOOGLE_UNAVAILABLE' })
}

export function createMinutesService(deps: MinutesServiceDeps) {
  const { companyData, writer, meetings } = deps
  const disabled = () => refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
  const notFound = () => refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })

  /** Department folders that may hold minutes (never a private folder). */
  function folderChoices(handle: CompanyData): string[] {
    const scopes = handle.scopes.listWithRules()
    return handle.departments.folders().map(d => d.folder).filter(f => !findPrivateScope(scopes, f))
  }

  /** The stored folder if it is still a usable department folder. */
  function usableFolder(handle: CompanyData, folder: string): string | null {
    const choice = folderChoices(handle).find(f => nameKey(f) === nameKey(folder))
    return choice ?? null
  }

  /** The minutes record `id` if the member may read it (anything else is "not found"). */
  function readableMinutes(handle: CompanyData, reader: RecordReader, id: string): RecordRow | null {
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return null
    const row = handle.records.byIds([id])[0]
    if (!row || row.removedAt !== null || row.type !== 'minutes' || !reader.record(row)) return null
    return row
  }

  /** Open deals the meeting may be about, readable by `reader` (mechanical: domains, then title). */
  function dealCandidates(handle: CompanyData, reader: RecordReader, externalDomains: string[], title: string): RecordRow[] {
    const records = handle.records
    const types = currentTypes(records)
    const dealDef = types.get('deal')?.definition
    if (!dealDef) return []
    const old = new Set(handle.plugins.oldConnectionRecordIds())
    const open = (rows: RecordRow[]) => {
      const states = new Map(records.states(rows.map(r => r.id)).map(s => [s.recordId, s.state]))
      return rows.filter(r => r.type === 'deal' && r.removedAt === null && !old.has(r.id) && reader.record(r)
        && !dealDef.final.includes(states.get(r.id) ?? dealDef.initial ?? ''))
    }
    let byDomain: RecordRow[] = []
    if (externalDomains.length > 0 && types.get('customer')?.definition.fields.domain?.source === 'server') {
      const customers = records.candidates({ types: ['customer'], fields: [{ name: 'domain', values: externalDomains }] }, 200)
        .filter(c => !old.has(c.id) && reader.record(c))
      const dealIds = [...new Set(records.linksTo(customers.map(c => c.id)).filter(l => l.name === 'customer').map(l => l.sourceId))]
      byDomain = open(records.byIds(dealIds))
    }
    const t = squash(title)
    const titleMatch = (r: RecordRow) => {
      const d = squash(r.title)
      return t.length >= 2 && d.length >= 2 && (t.includes(d) || d.includes(t))
    }
    if (byDomain.length > 0) {
      const both = byDomain.filter(titleMatch)
      return both.length > 0 ? both : byDomain
    }
    if (t.length < 2) return []
    const all = records.candidates({ types: ['deal'] }, 2000)
    return open(records.byIds(all.map(r => r.id))).filter(titleMatch)
  }

  /** The deal's customer (its `customer` link), if any. */
  function customerOf(handle: CompanyData, dealId: string): string | null {
    return handle.records.linksFrom([dealId]).find(l => l.name === 'customer' && l.targetId)?.targetId ?? null
  }

  /** Is the member the minutes' assignee or an attendee? */
  function isYours(fields: Record<string, LedgerValue>, userId: string): boolean {
    return fields.assignee === userId || attendeeIds(fields.attendees).includes(userId)
  }

  return {
    /** GET /google/minutes-folder — owner/admin. */
    folderSetting(member: Member): Outcome<MinutesFolderSetting> {
      if (!FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', 'この設定は管理者だけが見られます', { code: 'FORBIDDEN' })
      const handle = companyData.forCompany(member.companyId)
      return ok({ folder: handle.records.minutesFolder(), choices: folderChoices(handle) })
    },

    /** PUT /google/minutes-folder { folder: string | null } — owner/admin; a department folder, never private. */
    setFolder(member: Member, body: unknown): Outcome<MinutesFolderSetting> {
      if (!FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', 'この設定は管理者だけが変えられます', { code: 'FORBIDDEN' })
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b) || !('folder' in b)) return refuse('bad-request', 'folder: a department folder or null', { code: 'BAD_REQUEST' })
      for (const k of Object.keys(b)) if (k !== 'folder') return refuse('bad-request', `Unknown key: ${k}`, { code: 'BAD_REQUEST' })
      const handle = companyData.forCompany(member.companyId)
      let folder: string | null = null
      if (b.folder !== null) {
        const wanted = typeof b.folder === 'string' ? normalizeRepoPath(b.folder) : null
        folder = wanted ? usableFolder(handle, wanted) : null
        // One answer for "not a department" and "private": the place is never named.
        if (!folder) return refuse('bad-request', MINUTES_FOLDER_REFUSED.error, { code: MINUTES_FOLDER_REFUSED.code })
      }
      handle.records.setMinutesFolder(folder, member.userId, deps.clock.now())
      return ok({ folder, choices: folderChoices(handle) })
    },

    /** POST /me/minutes/check — the member's own calendar, with their own Google permission. */
    async check(member: Member): Promise<Outcome<MinutesCheckResult>> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      const reader = recordReader(member, handle.scopes.listWithRules())
      const nowMs = deps.clock.nowMs()

      // The member's own minutes stuck in 「読んでいる」 (the app puts them back with `retry`).
      const stale = records.candidates({ types: ['minutes'], states: ['reading'], fields: [{ name: 'assignee', values: [member.userId] }] }, 200)
        .filter(r => reader.record(r))
        .filter(r => {
          const at = Date.parse(fieldsOf(records, r.id).updatedAt ?? '')
          return !Number.isNaN(at) && nowMs - at > MINUTES_READING_STALE_MS
        })
        .map(r => r.id)

      const result: MinutesCheckResult = { checked: false, meetings: 0, internalOnly: 0, created: [], existing: 0, waiting: 0, stale }
      const stored = records.minutesFolder()
      if (!stored) return ok({ ...result, reason: 'no-folder', message: NO_FOLDER_MESSAGE })
      const folder = usableFolder(handle, stored)
      if (!folder) return ok({ ...result, reason: 'folder-unusable', message: FOLDER_UNUSABLE_MESSAGE })

      let events: MeetEvent[]
      try {
        events = await meetings.meetEvents(member.companyId, member.userId, new Date(nowMs - MINUTES_LOOKBACK_MS), new Date(nowMs))
      } catch (err) {
        if (err instanceof GoogleReadFailed) return googleRefusal(err)
        throw err
      }
      const domain = handle.connectors.client()?.domain
      if (!domain) return refuse('forbidden', 'この会社では、いま Google につなげません（止められているか、まだ設定されていません）。', { code: 'GOOGLE_STOPPED' })
      result.checked = true
      const members = deps.members(member.companyId)
      const byEmail = new Map(members.flatMap(m => {
        const e = normalizeEmail(m.email)
        return e ? [[e, m] as const] : []
      }))

      for (const event of events.slice(0, MAX_MEETINGS_PER_CHECK)) {
        // Internal-only meetings are never read (design §1-2): not even their Meet record.
        const external = event.attendees.filter(a => isExternalAddress(a.email, [domain]))
        if (external.length === 0) { result.internalOnly++; continue }
        result.meetings++
        try {
          const conference = await meetings.conferenceFor(member.companyId, member.userId, event)
          if (!conference) { result.waiting++; continue }
          // One record per conference, whoever finds it (the id is the conference's).
          const id = newRecordId('minutes', deps.tokenDigest.digest(`minutes:${conference}`).slice(0, 24))
          if (records.find(id) && records.states([id]).length > 0) { result.existing++; continue }
          const docs = await meetings.documents(member.companyId, member.userId, conference)
          if (docs.length === 0) { result.waiting++; continue }
          const versions: string[] = []
          for (const d of docs) versions.push(`${d.kind}:${await meetings.docVersion(member.companyId, member.userId, d.docId)}`)

          const attending = [...new Set(event.attendees.flatMap(a => {
            const m = byEmail.get(normalizeEmail(a.email) ?? '')
            return m ? [m.userId] : []
          }))]
          // The field is text (500 characters): a very large meeting keeps the first members that fit.
          while (JSON.stringify(attending).length > 500) attending.pop()
          const organizer = event.organizer ? byEmail.get(normalizeEmail(event.organizer) ?? '') : undefined
          const ref: SourceRef = { conference, event: event.eventId, docs: docs.map(d => ({ kind: d.kind, id: d.docId })) }
          const base = {
            type: 'minutes', id, title: (event.title || '会議').slice(0, 200), folder,
            actor: GOOGLE_ACTOR, note: `${member.userId} のカレンダーから`,
          }
          // The organizer is the assignee when they are a member who can read the folder; else the finder.
          const assignees = [...new Set([organizer?.userId, member.userId].filter((u): u is string => !!u))]
          let made: ReturnType<ServiceRecordWriter['create']> | null = null
          for (const assignee of assignees) {
            const role = members.find(m => m.userId === assignee)?.role
            if (!role) continue
            const assigneeReader = recordReader({ companyId: member.companyId, userId: assignee, role }, handle.scopes.listWithRules())
            const candidates = dealCandidates(handle, assigneeReader, [...new Set(external.map(a => emailDomain(a.email)))], event.title)
            const deal = candidates.length === 1 ? candidates[0] : null
            const customer = deal ? customerOf(handle, deal.id) : null
            const input = {
              ...base,
              fields: {
                meeting_at: event.start, assignee, attendees: JSON.stringify(attending), external_count: external.length,
                source_ref: JSON.stringify(ref), doc_version: versions.join(','),
              },
              links: { ...(deal ? { deal: [deal.id] } : {}), ...(customer ? { customer: [customer] } : {}) },
            }
            const problem = writer.check(member.companyId, input)
            if (problem?.reason === 'assignee-cannot-read') continue
            made = writer.create(member.companyId, input)
            break
          }
          if (made?.ok) result.created.push(made.record.id)
          else if (made && made.reason === 'exists') result.existing++
        } catch (err) {
          if (err instanceof GoogleReadFailed) {
            // A switch turned off mid-way stops the whole check; a single unreadable meeting waits.
            if (err.result.kind === 'not-sent') return googleRefusal(err)
            result.waiting++
            continue
          }
          throw err
        }
      }
      return ok(result)
    },

    /** The minutes as outside text, for the assignee or an attendee (their own Google permission). */
    async text(member: Member, recordId: string): Promise<Outcome<MinutesText>> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      const reader = recordReader(member, handle.scopes.listWithRules())
      const row = readableMinutes(handle, reader, recordId)
      if (!row) return notFound()
      const now = fieldsOf(records, row.id)
      if (!isYours(now.fields, member.userId)) return refuse('forbidden', MINUTES_NOT_YOURS.error, { code: MINUTES_NOT_YOURS.code })
      const ref = parseRef(now.fields.source_ref)
      if (!ref || ref.docs.length === 0) return refuse('conflict', 'この議事録の元の文書が分かりません。', { code: 'MINUTES_SOURCE_UNKNOWN' })

      const parts: string[] = []
      const versions: string[] = []
      let truncated = false
      let event: MeetEvent | null = null
      try {
        let room = MINUTES_TEXT_MAX
        for (const d of ref.docs) {
          versions.push(`${d.kind}:${await meetings.docVersion(member.companyId, member.userId, d.id)}`)
          if (room <= 0) { truncated = true; continue }
          const heading = d.kind === 'notes' ? '■ 会議メモ' : '■ 文字起こし'
          const got = await meetings.docText(member.companyId, member.userId, d.id, Math.max(0, room - heading.length - 2))
          truncated ||= got.truncated
          parts.push(`${heading}\n${got.text}`)
          room -= heading.length + 2 + got.text.length
        }
        event = await meetings.event(member.companyId, member.userId, ref.event)
      } catch (err) {
        if (err instanceof GoogleReadFailed) return googleRefusal(err)
        throw err
      }
      const text = parts.join('\n\n')

      const names = new Map(deps.members(member.companyId).map(m => [m.userId, m.name]))
      const deal = handle.records.linksFrom([row.id]).find(l => l.name === 'deal' && l.targetId)
      const dealRow = deal ? handle.records.byIds([deal.targetId as string]).find(r => r.removedAt === null && reader.record(r)) : undefined
      let dealSummary: MinutesDealSummary | null = null
      if (dealRow) {
        const s = fieldsOf(records, dealRow.id)
        dealSummary = { id: dealRow.id, title: dealRow.title, state: s.state, fields: s.fields, version: s.version }
      }
      const domain = handle.connectors.client()?.domain ?? null
      const externalDomains = event && domain
        ? [...new Set(event.attendees.filter(a => isExternalAddress(a.email, [domain])).map(a => emailDomain(a.email)))]
        : []
      const candidates = dealSummary ? [] : dealCandidates(handle, reader, externalDomains, row.title).map(r => ({ id: r.id, title: r.title }))
      return ok({
        recordId: row.id,
        header: MINUTES_TEXT_HEADER,
        text,
        footer: MINUTES_TEXT_FOOTER,
        truncated,
        docVersion: versions.join(','),
        meeting: { title: row.title, at: typeof now.fields.meeting_at === 'string' ? now.fields.meeting_at : null },
        folder: row.folder,
        attendees: attendeeIds(now.fields.attendees).map(id => ({ memberId: id, displayName: names.get(id) ?? '' })),
        externalAttendees: typeof now.fields.external_count === 'number' ? now.fields.external_count : 0,
        deal: dealSummary,
        candidates,
        instructionLike: findInstructionLikeText(text).map(label => ({ label, words: INSTRUCTION_LIKE_WORDS[label] ?? label })),
      })
    },

    /** POST …/minutes/:recordId/deal { dealId, expectedVersion? } — the assignee, an admin, or their AI. */
    linkDeal(member: Member, actor: Omit<ServiceActor, 'id'>, recordId: string, body: unknown): Outcome<MinutesLinkDealResult> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      const reader = recordReader(member, handle.scopes.listWithRules())
      const row = readableMinutes(handle, reader, recordId)
      if (!row) return notFound()
      const now = fieldsOf(records, row.id)
      if (now.fields.assignee !== member.userId && !FULL_ACCESS_ROLES.has(member.role)) {
        return refuse('forbidden', '案件を選べるのは、議事録の担当の人か管理者です。', { code: 'MINUTES_NOT_YOURS' })
      }
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return refuse('bad-request', 'The body must be an object', { code: 'BAD_REQUEST' })
      for (const k of Object.keys(b)) if (k !== 'dealId' && k !== 'expectedVersion') return refuse('bad-request', `Unknown key: ${k}`, { code: 'BAD_REQUEST' })
      if (b.expectedVersion !== undefined && (typeof b.expectedVersion !== 'number' || !Number.isInteger(b.expectedVersion))) {
        return refuse('bad-request', 'expectedVersion: a whole number', { code: 'BAD_REQUEST' })
      }
      const dealRow = typeof b.dealId === 'string' && RECORD_ID_RE.test(b.dealId)
        ? records.byIds([b.dealId]).find(r => r.removedAt === null && r.type === 'deal' && reader.record(r))
        : undefined
      if (!dealRow) return refuse('bad-request', 'dealId: a deal record you can read', { code: 'BAD_LINK' })
      const customer = customerOf(handle, dealRow.id)
      const expected = typeof b.expectedVersion === 'number' ? b.expectedVersion : now.version
      const r = writer.transition(member.companyId, {
        recordId: row.id, action: 'link_deal', expectedVersion: expected, to: null,
        links: { deal: [dealRow.id], customer: customer ? [customer] : [] },
        actor: { id: member.userId, ...actor },
      })
      if (!r.ok) {
        if (r.reason === 'stale') return refuse('conflict', 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', { code: 'VERSION_CONFLICT', version: fieldsOf(records, row.id).version })
        if (r.reason === 'records-off') return disabled()
        return refuse('bad-request', '案件をつなげませんでした', { code: 'MINUTES_LINK_REFUSED' })
      }
      return ok({ recordId: row.id, dealId: dealRow.id, customerId: customer, version: r.entry.version })
    },

    /**
     * For the thank-you mail (G8): the meeting's attendees from the calendar,
     * read now with the member's own permission — the verified recipients'
     * source. Only for the assignee or an attendee who may read the record.
     * `external`: outside the company's Google domain.
     */
    async meetingAttendees(companyId: string, userId: string, role: string, minutesId: string): Promise<Outcome<Array<MeetingAttendee & { external: boolean }>>> {
      const member: Member = { companyId, userId, role }
      const handle = companyData.forCompany(companyId)
      if (!handle.records.settings().enabled) return disabled()
      const row = readableMinutes(handle, recordReader(member, handle.scopes.listWithRules()), minutesId)
      if (!row) return notFound()
      const now = fieldsOf(handle.records, row.id)
      if (!isYours(now.fields, userId)) return refuse('forbidden', MINUTES_NOT_YOURS.error, { code: MINUTES_NOT_YOURS.code })
      const ref = parseRef(now.fields.source_ref)
      if (!ref) return refuse('conflict', 'この議事録の元の会議が分かりません。', { code: 'MINUTES_SOURCE_UNKNOWN' })
      let event: MeetEvent | null
      try {
        event = await meetings.event(companyId, userId, ref.event)
      } catch (err) {
        if (err instanceof GoogleReadFailed) return googleRefusal(err)
        throw err
      }
      if (!event) return refuse('gone', 'カレンダーにこの会議が見つかりません。', { code: 'MEETING_GONE' })
      const domain = handle.connectors.client()?.domain
      if (!domain) return refuse('forbidden', 'この会社では、いま Google につなげません（止められているか、まだ設定されていません）。', { code: 'GOOGLE_STOPPED' })
      return ok(event.attendees.map(a => ({ ...a, external: isExternalAddress(a.email, [domain]) })))
    },
  }
}

export type MinutesService = ReturnType<typeof createMinutesService>
