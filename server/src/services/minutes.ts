/**
 * The minutes intake (milestone 4 G7, `.claude/rules/minutes.md`; design
 * 節目4 §1-2, §3-1, §3-7, §9 q5/q14/q15, owner §11; meetings for their attendees,
 * owner decision 2026-11-04 — 会議の記録と「参加した人だけ」の見え方 §2/§4/§5).
 *
 * - **Discovery** (`discover`, run for every member by the server clock's
 *   `pollCompany` and for one member by the app's `check`): the member's own
 *   calendar of the last 3 days, read with their own Google permission. Every
 *   Meet meeting with generated notes / transcript becomes one `meeting`
 *   record per conference (会議, server only) — except events marked private in
 *   the calendar, which are not recorded at all. The record is **members-only**:
 *   the attending members (calendar attendees matched by ACB email; declined
 *   ones left out; ones added later join, removed
 *   ones stay). It starts `arrived` (議事録が届いた): nobody's turn, no AI turn;
 *   each attendee is told once. Stored: the meeting's title, time, attending
 *   member ids, the count of outside attendees, opaque Google ids and the
 *   minutes documents' versions. **No text of the minutes is ever stored or logged.**
 * - **Reading** is never automatic: an attendee's ［AI に読ませる］ (`requestReading`)
 *   makes it the AI's turn on their PC with their own Google permission (they become
 *   the assignee); ［読まない］ (`skipReading`) ends it for everyone. A member's
 *   「この定例は次から自動で読む」 (`setAutoSeries`) does the first for each new
 *   meeting of that series their own discovery finds.
 * - **まとまり** (`bundle`): candidates are found mechanically, whatever their
 *   type — outside attendees' email domains ↔ the `domain` of 相手 records
 *   (types implementing `counterpart`) that a まとまり links to; the meeting
 *   title ↔ まとまり titles. Linking one is an attendee's choice (it shows part of the
 *   meeting to the まとまり's department): never automatic (`linkBundle`). Nothing
 *   is written to the outside system here.
 * - **Text** (`text`): read again from Google with the requesting member's own
 *   permission, for the assignee or an attendee who may read the record; handed
 *   back once, marked as outside text (data, not instructions) with the
 *   instruction-like flags. The consultation AI reads it (no separate reader AI,
 *   owner §11) and makes outputs with the typed tools; the server's gates decide.
 */
import { CLOCK_ACTOR, CORE_BUNDLE_TYPE } from '../../shared/core/core-types'
import { FEATURE_OFF } from '../../shared/core/features'
import {
  MEETING_ARRIVED_DAYS, MEETING_ARRIVED_STATE, MEETING_ATTENDEES_ACTION, MEETING_BUNDLE_DAYS_MAX, MEETING_BUNDLE_DAYS_MIN, MEETING_INTAKE_CHOICES,
  MEETING_BUNDLE_LINKED_ACTION, MEETING_NO_BUNDLE_ACTION, MEETING_READ_REQUEST_ACTION, MEETING_SKIP_ACTION, MEETING_TYPE, meetingAsksBundle,
  meetingBundleDaysOf, meetingIntakeOf, MINUTES_TEXT_FOOTER, MINUTES_TEXT_HEADER, MINUTES_TEXT_MAX, MINUTES_TEXT_PAGED_MAX, keepHeadAndTail,
} from '../../shared/core/minutes'
import { INSTRUCTION_LIKE_WORDS } from '../../shared/core/instruction-like'
import { neutralizeOutsideText, outsideTextFlags } from '../../shared/core/outside-text'
import { isExternalAddress, emailDomain, normalizeEmail } from '../../shared/core/mail'
import { foldAsciiCase, nameKey, normalizeRepoPath } from '../../shared/core/paths'
import { findPrivateScope, FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import type { LedgerValue } from '../../shared/core/record-ledger'
import type { TypeDefinition } from '../../shared/core/record-types'
import { newRecordId, RECORD_ID_RE } from '../../shared/core/records'
import type {
  MeetingArrival, MeetingArrivals, MeetingAutoSeriesResult, MeetingBundleQuestion, MeetingBundleQuestions, MeetingBundleQuestionState,
  MeetingReadRequestResult, MeetingSkipResult, MinutesBundleSummary, MinutesCheckResult, MinutesFolderSetting,
  MinutesLinkBundleResult, MinutesNoBundleResult, MinutesText,
} from '../../shared/types/minutes'
import { logError } from '../lib/error-log'
import type { Clock } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import { MeetingReadFailed as GoogleReadFailed, type MeetEvent, type MeetingAttendee, type MeetingRecordsReader } from '../ports/meeting-records'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'
import { recordReader, type RecordReader } from './record-access'
import type { ServiceActor, ServiceRecordWriter } from './record-engine'
import type { AfterActionListener } from './record-engine/types'
import { currentTypes, ensureCoreTypes } from './record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from './records'

export interface MinutesMember {
  userId: string
  email: string
  name: string
  role: string
}

export interface MinutesServiceDeps {
  companyData: CompanyDataSource
  /**
   * 「使う機能」 会議と議事録 is on (records.md "Features on and off"). Off: no meeting is found
   * (the clock, the app's check), the reading, まとまり, skip and auto-series routes answer 409
   * FEATURE_OFF, arrivals and まとまり questions answer empty; earlier meetings stay readable on their
   * card. Absent → on.
   */
  enabled?: (companyId: string) => boolean
  /**
   * 「使う機能」 プロジェクト is on: off, 「どの〇〇の会議ですか？」 is asked only where a business
   * plugin's 束ねるもの exists (a department of the core's プロジェクト alone has nothing to choose).
   * Absent → on.
   */
  projectsOn?: (companyId: string) => boolean
  writer: ServiceRecordWriter
  /** The core role 会議の記録を読む, routed to the company's connector (connector-roles.md). */
  meetings: MeetingRecordsReader
  /**
   * A person asked for the reading again: its execution run, if one stopped for a person, may be
   * claimed anew (`AiRunService.askedAgain`; ai-turns.md "Asked again").
   */
  readingAskedAgain?: (companyId: string, recordId: string) => void
  /** The company's members with their ACB email and display name (compared only; never logged). */
  members: (companyId: string) => MinutesMember[]
  clock: Clock
  tokenDigest: TokenDigest
  /**
   * 名寄せ (identity.md, B1): the 相手 records of an address's company (by its domain, never free
   * mail), readable by that member. Used when no まとまり was linked at intake: the outside
   * participants' company becomes the meeting's 相手, and its one open まとまり is suggested.
   */
  resolveAddress?: (member: Member, address: string) => Outcome<{ person: string[]; company: string[] }>
  /**
   * The record engine's after-action reaction (plugin-steps.md "After a meeting is read"): told
   * when a まとまり is linked to a meeting already read without one, so the まとまり moves to the
   * business plugin's step for it as after a reading. Best effort: never changes the answer.
   */
  afterAction?: AfterActionListener
}

/** How far back the calendar is read (design §1-2: the last few days). */
export const MINUTES_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000
/** A record 「読んでいる」 longer than this is put back to 「届いた」 (design §1-8). */
export const MINUTES_READING_STALE_MS = 30 * 60 * 1000
const STALE_PUT_BACK_NOTE = '読み始めてから30分たっても終わらなかったため、AI の番に戻しました'
const RUN_PUT_BACK_NOTE = 'AI の自動実行が読み終えずに止まったため、AI の番に戻しました'
const MAX_MEETINGS_PER_CHECK = 50
/** Google calls of the meetings' discovery per company and clock run (the rest waits for the next run), and per app check. */
export const MEETING_CALLS_PER_RUN = 300
const MEETING_CALLS_PER_CHECK = 100
/** Minutes not generated yet: look again after these waits (minutes), shared by every attendee's discovery. */
const MEETING_LOOK_AGAIN_MIN = [5, 15, 30, 60, 120, 240]
const FOUND_NOTE = 'カレンダーの予定から見つけました'
/** At most this many meetings in the member's 「議事録が届きました」 answer. */
const MAX_ARRIVALS = 100
const AUTO_SERIES_NOTE = 'この定例は自動で読む設定のため、AI に読ませました'
const READ_REQUEST_NOTE = 'AI に読ませる'
const SKIP_NOTE = '読まない'
const ATTENDEES_NOTE = 'カレンダーで会議に加わった人'
/** At most this many of a member's read meetings are looked at for 「どのまとまりの会議ですか？」. */
const MAX_BUNDLE_QUESTIONS = 100
const NO_BUNDLE_NOTE = 'まとまりはない（社内の会議など）'

export const MINUTES_FOLDER_REFUSED = {
  error: 'この場所は議事録の置き場所に選べません。部署のフォルダを選んでください。',
  code: 'MINUTES_FOLDER_REFUSED',
}

export const MINUTES_NOT_YOURS = {
  error: 'この議事録は、担当の人か会議に出た人だけが読めます。',
  code: 'MINUTES_NOT_YOURS',
}
/** ［AI に読ませる］ tries this much of the text: enough to prove reading works, nothing is kept. */
const READ_PROBE_CHARS = 200
/**
 * A document is taken whole before its beginning and end are kept (`readDocuments`' `keepEnd`):
 * Google sends the whole export anyway (an answer is at most 12 MB, google-client.ts), this only
 * bounds the string handled.
 */
const MINUTES_TEXT_FETCH_MAX = 4_000_000
const NOTES_HEADING = '■ 会議メモ'
const TRANSCRIPT_HEADING = '■ 文字起こし'
/** Words said in the meeting, read from Meet's record because Drive refused the document. */
const MEET_RECORD_HEADING = '■ 文字起こし（Google Meet の記録から）'
const PART_REFUSED_NOTE = '（Google が文章の取り出しを断ったため、ここは読めませんでした）'

const GOOGLE_RETRY_LATER = 'Google から読めませんでした。少し待ってからもう一度お試しください。'
/** Drive answers its quota with 403 too: that is not a refusal of the member. */
const GOOGLE_BUSY_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'RESOURCE_EXHAUSTED']
const GOOGLE_SETTINGS_REASONS = ['domainPolicy', 'accessNotConfigured', 'SERVICE_DISABLED']
const ACB_PERMISSION_REASONS = ['appNotAuthorizedToFile', 'insufficientPermissions', 'insufficientScopes', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']
const NO_COPY_REASONS = ['cannotExportFile', 'cannotDownload', 'cannotDownloadFile', 'cannotDownloadAbusiveFile']
/** Only what ACB's own permission lacks may be read from Meet's record instead (owner decision 2026-11-05). */
const MEET_RECORD_REASONS = ACB_PERMISSION_REASONS

/** ［AI に読ませる］ by an attendee whose Google cannot open the minutes (reader rotation, design §4-3). */
export const MINUTES_NOT_SHARED_MESSAGE = 'あなたの Google では、この会議の議事録を開けません（Google で共有されていません）。ほかの出席者が［AI に読ませる］を押すと、その人の AI が読めます。'

const GOOGLE_ACTOR: ServiceActor = { id: 'google', kind: 'external', source: 'google' }

/** The opaque pointer kept in `source_ref`: Google ids only, no text. */
interface SourceRef {
  conference: string
  event: string
  docs: Array<{ kind: 'notes' | 'transcript'; id: string }>
  /** The recurring series the event belongs to (calendar `recurringEventId`), when it does. */
  series?: string
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
    if (r.reason === 'feature-off') {
      return refuse('conflict', '「予定と議事録を読む」をオフにしています。アプリの「設定」→「Google」でオンにしてください。', { code: 'GOOGLE_NOT_CONNECTED' })
    }
    if (['operator-stopped', 'not-configured', 'off', 'vault-off', 'not-member', 'practice-real-secret', 'no-connector', 'choice-needed'].includes(r.reason)) {
      return refuse('forbidden', 'この会社では、いま Google につなげません（止められているか、まだ設定されていません）。', { code: 'GOOGLE_STOPPED' })
    }
  }
  if (r.kind === 'refused' && (r.status === 403 || r.status === 404)) {
    if (GOOGLE_BUSY_REASONS.includes(r.googleReason ?? '')) return refuse('unavailable', GOOGLE_RETRY_LATER, { code: 'GOOGLE_UNAVAILABLE' })
    if (GOOGLE_SETTINGS_REASONS.includes(r.googleReason ?? '')) {
      return refuse('forbidden', '会社の Google の設定で、ACB から議事録を読むことが止められています。Google の管理者に伝えてください。', { code: 'GOOGLE_STOPPED' })
    }
    return refuse('forbidden', MINUTES_NOT_SHARED_MESSAGE, { code: 'MINUTES_NO_ACCESS' })
  }
  return refuse('unavailable', GOOGLE_RETRY_LATER, { code: 'GOOGLE_UNAVAILABLE' })
}

/** Drive opened the document but refused its text, and this is not Google asking to wait or a company-wide stop. */
function textRefused(err: GoogleReadFailed): boolean {
  const r = err.result
  return r.kind === 'refused' && (r.status === 403 || r.status === 404)
    && !GOOGLE_BUSY_REASONS.includes(r.googleReason ?? '') && !GOOGLE_SETTINGS_REASONS.includes(r.googleReason ?? '')
}

/**
 * The minutes are shared with the member (Drive opened them) and Google still refused their text:
 * what happened, by Google's reason. Never 「共有されていません」, and no one else's press helps.
 */
export function textRefusal(err: GoogleReadFailed): Refusal {
  const reason = err.result.googleReason ?? ''
  if (reason === 'exportSizeLimitExceeded') {
    return refuse('forbidden', '議事録が大きすぎて、Google が文章を取り出せませんでした（10MB まで）。Google ドキュメントで開いて読んでください。', { code: 'MINUTES_TOO_LARGE' })
  }
  if (NO_COPY_REASONS.includes(reason)) {
    return refuse('forbidden', 'この議事録は、ファイルの持ち主がコピーやダウンロードを止めているため、AI は読めません。Google ドキュメントで開いて読んでください。', { code: 'MINUTES_TEXT_REFUSED' })
  }
  if (ACB_PERMISSION_REASONS.includes(reason)) {
    return refuse('forbidden', 'この議事録は共有されていて開けますが、いま ACB に許可している範囲では、Google が文章の取り出しを断りました。AI は読めないため、Google ドキュメントで開いて読んでください。会社の管理者にも伝えてください。', { code: 'MINUTES_TEXT_REFUSED' })
  }
  return refuse('forbidden', 'この議事録は開けますが、Google が文章の取り出しを断りました。AI は読めないため、Google ドキュメントで開いて読んでください。会社の管理者にも伝えてください。', { code: 'MINUTES_TEXT_REFUSED' })
}

export function createMinutesService(deps: MinutesServiceDeps) {
  const { companyData, writer, meetings } = deps
  /** Who goes first in each company's next clock run (fairness only; nothing depends on it). */
  const pollTurn = new Map<string, number>()

  /** A meeting still 「読んでいる」 back to 「届いた」 (the type's `retry`), with the actor that caused it. */
  const PUT_BACK: Record<string, { action: string; to: string }> = {
    reading: { action: 'retry', to: 'received' },
  }
  function putBack(companyId: string, recordId: string, actor: ServiceActor, note: string): boolean {
    const now = fieldsOf(companyData.forCompany(companyId).records, recordId)
    const back = now.state ? PUT_BACK[now.state] : undefined
    if (!back) return false
    return writer.transition(companyId, { recordId, action: back.action, expectedVersion: now.version, to: back.to, actor, note }).ok
  }
  const disabled = () => refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
  const featureOn = (companyId: string) => deps.enabled?.(companyId) ?? true
  const featureOff = () => refuse('conflict', FEATURE_OFF.error, { code: FEATURE_OFF.code })
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

  /** The meeting record `id` if the member may read it (anything else is "not found"). */
  function readableMeeting(handle: CompanyData, reader: RecordReader, id: string): RecordRow | null {
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return null
    const row = handle.records.byIds([id])[0]
    if (!row || row.removedAt !== null || row.type !== MEETING_TYPE || !reader.record(row)) return null
    return row
  }

  /** The names of the types in force implementing an interface (`bundle`, `counterpart`). */
  function typesImplementing(handle: CompanyData, iface: string): Map<string, TypeDefinition> {
    const out = new Map<string, TypeDefinition>()
    for (const [name, t] of currentTypes(handle.records)) if (t.definition.implements.includes(iface)) out.set(name, t.definition)
    return out
  }

  /**
   * Unfinished まとまり (any type implementing `bundle`) the meeting may be about,
   * readable by `reader` — mechanical: outside domains ↔ the `domain` of a 相手
   * the まとまり links to, then the title.
   */
  function bundleCandidates(handle: CompanyData, reader: RecordReader, externalDomains: string[], title: string): RecordRow[] {
    const records = handle.records
    const bundles = typesImplementing(handle, 'bundle')
    if (bundles.size === 0) return []
    const old = new Set(handle.plugins.oldConnectionRecordIds())
    const open = (rows: RecordRow[]) => {
      const states = new Map(records.states(rows.map(r => r.id)).map(s => [s.recordId, s.state]))
      return rows.filter(r => {
        const def = bundles.get(r.type)
        return !!def && r.removedAt === null && !old.has(r.id) && reader.record(r) && !def.final.includes(states.get(r.id) ?? def.initial ?? '')
      })
    }
    let byDomain: RecordRow[] = []
    const counterparts = [...typesImplementing(handle, 'counterpart').keys()]
    if (externalDomains.length > 0 && counterparts.length > 0) {
      const found = records.candidates({ types: counterparts, fields: [{ name: 'domain', values: externalDomains }] }, 200)
        .filter(c => !old.has(c.id) && reader.record(c))
      const bundleIds = [...new Set(records.linksTo(found.map(c => c.id)).map(l => l.sourceId))]
      byDomain = open(records.byIds(bundleIds))
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
    const all = records.candidates({ types: [...bundles.keys()] }, 2000)
    return open(records.byIds(all.map(r => r.id))).filter(titleMatch)
  }

  /**
   * The まとまり's 相手: the first record it links to whose type implements `counterpart` and that
   * the member reads, if any — one they cannot read does not exist for them (its id is never
   * answered nor linked by them; records.md "No leaks").
   */
  function counterpartOf(handle: CompanyData, reader: RecordReader, bundleId: string): string | null {
    const counterparts = typesImplementing(handle, 'counterpart')
    const targets = handle.records.linksFrom([bundleId]).map(l => l.targetId).filter((t): t is string => !!t)
    const live = new Map(handle.records.byIds(targets).filter(r => r.removedAt === null && counterparts.has(r.type) && reader.record(r)).map(r => [r.id, r]))
    return targets.find(t => live.has(t)) ?? null
  }

  /** A まとまり as the AI and the app see it. */
  function bundleSummary(handle: CompanyData, row: RecordRow): MinutesBundleSummary {
    const s = fieldsOf(handle.records, row.id)
    const label = currentTypes(handle.records).get(row.type)?.definition.label ?? row.type
    return { id: row.id, type: row.type, typeLabel: label, title: row.title, state: s.state, fields: s.fields, version: s.version }
  }

  function folderView(handle: CompanyData, folder: string | null): MinutesFolderSetting {
    return {
      folder, choices: folderChoices(handle), meetings: meetingIntakeOf(handle.records.meetingIntake()),
      bundleQuestionDays: meetingBundleDaysOf(handle.records.meetingBundleDays()),
    }
  }

  /** A person closed 「どのまとまりの会議ですか？」 for this meeting (its ledger keeps the choice). */
  const noBundleChosen = (handle: CompanyData, id: string) => handle.records.ledger(id).some(e => e.action === MEETING_NO_BUNDLE_ACTION)
  const hasBundleLink = (handle: CompanyData, id: string) => handle.records.linksFrom([id]).some(l => l.name === 'bundle' && l.targetId)
  /**
   * Who chooses a meeting's まとまり: its assignee, an owner / admin (for a meeting they may read), and
   * on a members-only meeting anyone on its list (design §2: the attendees choose to share it).
   */
  const mayChooseBundle = (member: Member, fields: Record<string, LedgerValue>, row: RecordRow) =>
    fields.assignee === member.userId || FULL_ACCESS_ROLES.has(member.role) || (row.members?.includes(member.userId) ?? false)

  /**
   * Which meetings ask together (one row 「まとまりを選ぶ会議 n件」): the same 相手, else the same
   * calendar series (a recurring event's instances share its base id), else the same title. The key
   * is a digest: no calendar id leaves the server.
   */
  function bundleGroup(handle: CompanyData, reader: RecordReader, row: RecordRow, fields: Record<string, LedgerValue>): MeetingBundleQuestion['group'] {
    const key = (raw: string) => deps.tokenDigest.digest(`meeting-bundle-group:${raw}`).slice(0, 16)
    const cp = handle.records.linksFrom([row.id]).find(l => l.name === 'counterpart' && l.targetId)
    const cpRow = cp ? handle.records.byIds([cp.targetId as string]).find(r => r.removedAt === null && reader.record(r)) : undefined
    if (cpRow) return { key: key(`c:${cpRow.id}`), label: cpRow.title || row.title }
    const event = parseRef(fields.source_ref)?.event ?? ''
    const cut = event.indexOf('_')
    if (cut > 0) return { key: key(`s:${event.slice(0, cut)}`), label: row.title }
    return { key: key(`t:${squash(row.title)}`), label: row.title }
  }

  /**
   * The outside participants' company (名寄せ, identity.md resolveAddress): when every participant
   * who resolves at all resolves to the same 相手 records, the first of them; else null.
   */
  function participantsCompany(member: Member, emails: string[]): string | null {
    if (!deps.resolveAddress) return null
    const sets = new Set<string>()
    let first: string | null = null
    for (const email of emails) {
      const r = deps.resolveAddress(member, email)
      if (!r.ok || r.value.company.length === 0) continue
      const ids = [...r.value.company].sort()
      sets.add(ids.join(','))
      first ??= ids[0]
    }
    return sets.size === 1 ? first : null
  }

  /**
   * 「『…』の会議ですか？」 (owner 2026-11-02): the one open まとまり of the meeting's 相手 that the
   * member reads, or null (none, two or more, or a 相手 the member does not read). Never linked
   * without the person's click.
   */
  function suggestedBundle(handle: CompanyData, reader: RecordReader, meetingId: string): MeetingBundleQuestion['suggested'] {
    const records = handle.records
    const cp = records.linksFrom([meetingId]).find(l => l.name === 'counterpart' && l.targetId)
    const cpRow = cp ? records.byIds([cp.targetId as string]).find(r => r.removedAt === null && reader.record(r)) : undefined
    if (!cpRow) return null
    const bundles = typesImplementing(handle, 'bundle')
    const old = new Set(handle.plugins.oldConnectionRecordIds())
    const rows = records.byIds([...new Set(records.linksTo([cpRow.id]).map(l => l.sourceId))])
    const states = new Map(records.states(rows.map(r => r.id)).map(s => [s.recordId, s.state]))
    const open = rows.filter(r => {
      const def = bundles.get(r.type)
      return !!def && r.removedAt === null && !old.has(r.id) && reader.record(r) && !def.final.includes(states.get(r.id) ?? def.initial ?? '')
    })
    if (open.length !== 1) return null
    return { id: open[0].id, title: open[0].title, typeLabel: bundles.get(open[0].type)?.label ?? open[0].type }
  }

  /** Is the member the minutes' assignee or an attendee? */
  function isYours(fields: Record<string, LedgerValue>, userId: string): boolean {
    return fields.assignee === userId || attendeeIds(fields.attendees).includes(userId)
  }

  /**
   * The member's own meetings whose minutes are stuck in 「読んでいる」 for over 30 minutes: back to
   * 「届いた」 as the server clock (the ledger says no person did it). Returns their ids.
   */
  function putBackStale(member: Member): string[] {
    const handle = companyData.forCompany(member.companyId)
    const records = handle.records
    const reader = recordReader(member, handle.scopes.listWithRules())
    const nowMs = deps.clock.nowMs()
    const stale = records.candidates({ types: [MEETING_TYPE], states: Object.keys(PUT_BACK), fields: [{ name: 'assignee', values: [member.userId] }] }, 200)
      .filter(r => reader.record(r))
      .filter(r => {
        const at = Date.parse(fieldsOf(records, r.id).updatedAt ?? '')
        return !Number.isNaN(at) && nowMs - at > MINUTES_READING_STALE_MS
      })
      .map(r => r.id)
    for (const id of stale) putBack(member.companyId, id, { ...CLOCK_ACTOR }, STALE_PUT_BACK_NOTE)
    return stale
  }

  /** Is the member one of the meeting's people: on its list, its assignee or an attendee? */
  function isAttendee(row: RecordRow, fields: Record<string, LedgerValue>, userId: string): boolean {
    return (row.members?.includes(userId) ?? false) || isYours(fields, userId)
  }

  /** A series' key for the member's 「自動で読む」 (a digest: no calendar id is stored there). */
  const seriesKey = (series: string) => deps.tokenDigest.digest(`meeting-series:${series}`).slice(0, 24)

  /**
   * The minutes' documents as text with the member's own Google permission, at most `max` characters:
   * what ［AI に読ませる］ tries and what the text answer hands over (minutes.md "The text"). A document
   * Drive will not open is the member's refusal (not shared). One it opens but whose text it refuses
   * does not stop the others; when no transcript came through and every refusal was about what ACB
   * is allowed (never a copy block: the file's owner said no), Meet's own record of what was said
   * stands in. Nothing readable → why, by Google's reason, a copy block first.
   * `keepEnd` (an app that reads in parts): a document over its room keeps its beginning and its
   * end, the middle skipped with a mark (`keepHeadAndTail`, minutes.md "Long minutes"); Google sends
   * the whole document either way, so this costs no more reading. Without it the end is cut as before.
   */
  async function readDocuments(companyId: string, userId: string, ref: SourceRef, max: number, keepEnd = false): Promise<Outcome<{ text: string; truncated: boolean; versions: string[] }>> {
    const versions: string[] = []
    let parts: Array<{ kind: 'notes' | 'transcript'; text: string | null }> = []
    let truncated = false
    const refused: GoogleReadFailed[] = []
    let room = max
    const take = (heading: string, got: { text: string; truncated: boolean }) => {
      truncated ||= got.truncated
      room -= heading.length + 2 + got.text.length
      return `${heading}\n${got.text}`
    }
    try {
      for (const d of ref.docs) {
        versions.push(`${d.kind}:${await meetings.docVersion(companyId, userId, d.id)}`)
        if (room <= 0) { truncated = true; continue }
        const heading = d.kind === 'notes' ? NOTES_HEADING : TRANSCRIPT_HEADING
        try {
          const docRoom = Math.max(0, room - heading.length - 2)
          const got = keepEnd ? headAndTail(await meetings.docText(companyId, userId, d.id, MINUTES_TEXT_FETCH_MAX), docRoom) : await meetings.docText(companyId, userId, d.id, docRoom)
          parts.push({ kind: d.kind, text: take(heading, got) })
        } catch (err) {
          if (!(err instanceof GoogleReadFailed) || !textRefused(err)) throw err
          refused.push(err)
          parts.push({ kind: d.kind, text: null })
        }
      }
      const meetRecordAllowed = refused.length > 0 && refused.every(e => MEET_RECORD_REASONS.includes(e.result.googleReason ?? ''))
      if (meetRecordAllowed && !parts.some(p => p.kind === 'transcript' && p.text !== null) && room > 0) {
        const got = await meetRecordText(companyId, userId, ref.conference, Math.max(0, room - MEET_RECORD_HEADING.length - 2))
        if (got) parts = [...parts.filter(p => p.kind !== 'transcript'), { kind: 'transcript', text: take(MEET_RECORD_HEADING, got) }]
      }
    } catch (err) {
      if (err instanceof GoogleReadFailed) return googleRefusal(err)
      throw err
    }
    if (refused.length > 0 && !parts.some(p => p.text !== null)) {
      return textRefusal(refused.find(e => NO_COPY_REASONS.includes(e.result.googleReason ?? '')) ?? refused[0])
    }
    const text = parts.map(p => p.text ?? `${p.kind === 'notes' ? NOTES_HEADING : TRANSCRIPT_HEADING}\n${PART_REFUSED_NOTE}`).join('\n\n')
    return ok({ text, truncated, versions })
  }

  /** A document's text within `max`, its beginning and end kept (`readDocuments`' `keepEnd`). */
  function headAndTail(got: { text: string; truncated: boolean }, max: number): { text: string; truncated: boolean } {
    const kept = keepHeadAndTail(got.text, max)
    return { text: kept.text, truncated: got.truncated || kept.skipped }
  }

  /** Meet's record of what was said, or null when it holds none or Google refuses this member too. */
  async function meetRecordText(companyId: string, userId: string, conference: string, max: number): Promise<{ text: string; truncated: boolean } | null> {
    try {
      return await meetings.transcriptText(companyId, userId, conference, max)
    } catch (err) {
      if (err instanceof GoogleReadFailed && textRefused(err)) return null
      throw err
    }
  }

  /**
   * The meeting becomes the AI's turn on `userId`'s PC (［AI に読ませる］, or their 「自動で読む」
   * series): first the reading itself is tried with that member's own Google permission
   * (`readDocuments`, a little of the text, thrown away), so a member whose Google cannot read the
   * minutes hears why at once, not after a failed turn of the AI, and when they are not shared
   * another attendee can press instead (design §4-3). Then arrived / skipped / failed → received
   * with them as the assignee. Quiet: a turn of the AI tells nobody. An earlier run of the reading
   * that stopped for a person is given back: this press is that person's answer.
   */
  async function askToRead(companyId: string, userId: string, recordId: string, expected: number, actor: ServiceActor, note: string): Promise<Outcome<MeetingReadRequestResult>> {
    const records = companyData.forCompany(companyId).records
    const ref = parseRef(fieldsOf(records, recordId).fields.source_ref)
    if (!ref || ref.docs.length === 0) return refuse('conflict', 'この議事録の元の文書が分かりません。', { code: 'MINUTES_SOURCE_UNKNOWN' })
    const tried = await readDocuments(companyId, userId, ref, READ_PROBE_CHARS)
    if (!tried.ok) return tried
    const r = writer.transition(companyId, {
      recordId, action: MEETING_READ_REQUEST_ACTION, expectedVersion: expected, to: 'received',
      fields: { assignee: userId, doc_version: tried.value.versions.join(',') }, actor, note, quiet: true,
    })
    if (!r.ok) {
      if (r.reason === 'stale') return refuse('conflict', 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', { code: 'VERSION_CONFLICT', version: fieldsOf(records, recordId).version })
      if (r.reason === 'records-off') return disabled()
      return refuse('conflict', 'この会議は、いまは AI に読ませられません。', { code: 'MEETING_NOT_WAITING', version: fieldsOf(records, recordId).version })
    }
    deps.readingAskedAgain?.(companyId, recordId)
    return ok({ recordId, version: r.entry.version, state: 'received' })
  }

  /** A calendar event's key in `meeting_events` (a digest: no calendar id is stored there). */
  const eventKey = (eventId: string) => deps.tokenDigest.digest(`meeting-event:${eventId}`).slice(0, 24)

  /**
   * Members by an address Google verified for them: the account of their active Google grant (the
   * grant is only given for the member's own address, google-connector.md). The ACB account's email
   * is chosen at sign-up and not verified, so it never puts anyone on a meeting's list.
   */
  function verifiedMembers(companyId: string): Map<string, MinutesMember> {
    const members = new Map(deps.members(companyId).map(m => [m.userId, m]))
    const out = new Map<string, MinutesMember>()
    for (const g of companyData.forCompany(companyId).connectors.grants('google')) {
      const m = members.get(g.userId)
      const e = normalizeEmail(g.accountEmail)
      if (g.status === 'active' && m && e) out.set(e, m)
    }
    return out
  }

  /** Someone's calendar marks these events private: no member's discovery records them (now or later). */
  function markPrivate(companyId: string, events: MeetEvent[]): void {
    const records = companyData.forCompany(companyId).records
    for (const e of events) {
      if (e.private && !records.meetingEvent(eventKey(e.eventId))?.private) records.setMeetingEvent(eventKey(e.eventId), { private: true }, deps.clock.now())
    }
  }

  /** The member's Meet events of the last 3 days, newest first. */
  async function eventsOf(companyId: string, userId: string): Promise<Outcome<MeetEvent[]>> {
    const nowMs = deps.clock.nowMs()
    try {
      const events = await meetings.meetEvents(companyId, userId, new Date(nowMs - MINUTES_LOOKBACK_MS), new Date(nowMs))
      return ok([...events].sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0)))
    } catch (err) {
      if (err instanceof GoogleReadFailed) return googleRefusal(err)
      throw err
    }
  }

  /** No minutes yet: look again after a growing wait (shared by every attendee's discovery). */
  function lookLater(companyId: string, key: string): void {
    const records = companyData.forCompany(companyId).records
    const tries = (records.meetingEvent(key)?.tries ?? 0) + 1
    const wait = MEETING_LOOK_AGAIN_MIN[Math.min(tries - 1, MEETING_LOOK_AGAIN_MIN.length - 1)] * 60_000
    records.setMeetingEvent(key, { tries, nextAt: new Date(deps.clock.nowMs() + wait).toISOString() }, deps.clock.now())
  }

  /**
   * One member's events (minutes.md "Meetings for their attendees"): each ended Meet meeting not
   * marked private by anyone, with generated minutes, is one members-only record of its attending
   * members, `arrived`; a meeting recorded from this very event gets the attendees the calendar
   * added since. Their own 「自動で読む」 series are asked to be read for them. Google calls stop at
   * the budget (the rest waits for the next run) and at a rate limit.
   */
  async function discoverEvents(companyId: string, userId: string, events: MeetEvent[], budget: { calls: number }): Promise<Outcome<MinutesCheckResult>> {
    const handle = companyData.forCompany(companyId)
    const records = handle.records
    const result: MinutesCheckResult = { checked: true, meetings: 0, internalOnly: 0, created: [], existing: 0, waiting: 0, stale: [] }
    const domain = handle.connectors.client()?.domain
    if (!domain) return refuse('forbidden', 'この会社では、いま Google につなげません（止められているか、まだ設定されていません）。', { code: 'GOOGLE_STOPPED' })
    // The meeting definition in force must know its states and fields before the intake writes them,
    // also in a company whose map was not indexed since the server was updated.
    ensureCoreTypes(records, deps.clock.now())
    const finder = deps.members(companyId).find(m => m.userId === userId)
    if (!finder) return ok(result)
    const byEmail = verifiedMembers(companyId)
    const auto = new Set(records.meetingAutoSeries(userId))
    const nowMs = deps.clock.nowMs()

    for (const event of events.slice(0, MAX_MEETINGS_PER_CHECK)) {
      const key = eventKey(event.eventId)
      const known = records.meetingEvent(key)
      // Marked private in someone's calendar: not recorded at all — not even its Meet record is looked
      // up. A meeting recorded before it turned private stays, and gets no one added or told.
      if (event.private || known?.private) {
        if (event.private && !known?.private) records.setMeetingEvent(key, { private: true }, deps.clock.now())
        result.internalOnly++
        continue
      }
      result.meetings++
      // The meeting's people: attendees on the event's list who are members by an address Google
      // verified for them (another address or a mailing list is not matched yet: design §4-4),
      // never one who declined.
      const attending = [...new Set(event.attendees.flatMap(a => {
        if (a.declined || !a.listed) return []
        const m = byEmail.get(normalizeEmail(a.email) ?? '')
        return m ? [m.userId] : []
      }))]
      const wantsAuto = !!event.series && auto.has(seriesKey(event.series)) && attending.includes(userId)
      // Recorded from this event already: no Google call for it.
      if (known?.recordId) {
        result.existing++
        await joinAndAuto(companyId, userId, known.recordId, attending, wantsAuto)
        continue
      }
      if (Date.parse(event.end) > nowMs) { result.waiting++; continue }
      if (known?.nextAt && known.nextAt > deps.clock.now()) { result.waiting++; continue }
      if (attending.length === 0) continue
      if (budget.calls <= 0) { result.waiting++; continue }
      try {
        budget.calls--
        const conference = await meetings.conferenceFor(companyId, userId, event)
        if (!conference) { lookLater(companyId, key); result.waiting++; continue }
        // One record per conference, whoever finds it (the id is the conference's). A record made
        // before the type was renamed keeps its `minutes-…` id (db migrateCoreInterfaceLinks).
        const confKey = deps.tokenDigest.digest(`minutes:${conference}`).slice(0, 24)
        const id = newRecordId(MEETING_TYPE, confKey)
        const existing = [id, newRecordId('minutes', confKey)].find(rid => !!records.find(rid) && records.states([rid]).length > 0)
        if (existing) {
          result.existing++
          // Only the event it was recorded from is that meeting: another event on the same Meet
          // (a reused link, a copied event) never widens its list.
          if (parseRef(fieldsOf(records, existing).fields.source_ref)?.event === event.eventId) {
            records.setMeetingEvent(key, { recordId: existing }, deps.clock.now())
            await joinAndAuto(companyId, userId, existing, attending, wantsAuto)
          } else {
            lookLater(companyId, key)
          }
          continue
        }
        budget.calls -= 2
        const docs = await meetings.documents(companyId, userId, conference)
        if (docs.length === 0) { lookLater(companyId, key); result.waiting++; continue }
        const versions: string[] = []
        for (const d of docs) {
          budget.calls--
          versions.push(`${d.kind}:${await meetings.docVersion(companyId, userId, d.docId)}`)
        }

        // The field is text (500 characters): a very large meeting keeps the first members that fit (the list keeps all).
        const shown = [...attending]
        while (JSON.stringify(shown).length > 500) shown.pop()
        const external = event.attendees.filter(a => a.listed && isExternalAddress(a.email, [domain]))
        const ref: SourceRef = { conference, event: event.eventId, docs: docs.map(d => ({ kind: d.kind, id: d.docId })), ...(event.series ? { series: event.series } : {}) }
        // No まとまり at intake (choosing one shows part of the meeting to its department: an
        // attendee's choice). The outside participants' company (名寄せ) is still its 相手.
        const counterpart = participantsCompany({ companyId, userId, role: finder.role }, external.map(a => a.email))
        const made = writer.create(companyId, {
          type: MEETING_TYPE, id, title: (event.title || '会議').slice(0, 200), members: attending,
          actor: GOOGLE_ACTOR, note: FOUND_NOTE,
          fields: {
            // occurred_at: the common outside time (`outside_event`); meeting_at stays for older readers.
            meeting_at: event.start, occurred_at: event.start, attendees: JSON.stringify(shown), external_count: external.length,
            source_ref: JSON.stringify(ref), doc_version: versions.join(','),
          },
          links: counterpart ? { counterpart: [counterpart] } : {},
          // 「議事録が届きました」 to each attendee, once (notifications.md `minutes_arrived`).
          notify: attending,
        })
        if (made.ok) {
          records.setMeetingEvent(key, { recordId: made.record.id }, deps.clock.now())
          result.created.push(made.record.id)
          if (wantsAuto) await askToRead(companyId, userId, made.record.id, made.entry.version, { ...CLOCK_ACTOR }, AUTO_SERIES_NOTE)
        } else if (made.reason === 'exists') result.existing++
      } catch (err) {
        if (err instanceof GoogleReadFailed) {
          // A switch turned off mid-way stops the whole check; Google asking us to slow down stops this
          // member until the next run; a single unreadable meeting waits.
          if (err.result.kind === 'not-sent') return googleRefusal(err)
          if (err.result.kind === 'rate-limited') { result.waiting++; return ok(result) }
          lookLater(companyId, key)
          result.waiting++
          continue
        }
        throw err
      }
    }
    return ok(result)
  }

  /** One member's discovery on its own (the app's check): their events, private marks, then the meetings. */
  async function discover(companyId: string, userId: string, budget: { calls: number }): Promise<Outcome<MinutesCheckResult>> {
    if (!companyData.forCompany(companyId).records.settings().enabled) return disabled()
    budget.calls -= 1
    const events = await eventsOf(companyId, userId)
    if (!events.ok) return events
    markPrivate(companyId, events.value)
    return discoverEvents(companyId, userId, events.value, budget)
  }

  /**
   * A meeting found again from the event it was recorded from (the caller checked: `meeting_events`
   * maps only that event to it): the attendees the calendar added
   * since join its list (removed ones stay; told 「議事録が届きました」 while it is still arrived), and
   * the finder's 「自動で読む」 series asks the AI to read it. Best effort: someone else's change in
   * between leaves it to the next run.
   */
  async function joinAndAuto(companyId: string, userId: string, recordId: string, attending: string[], wantsAuto: boolean): Promise<void> {
    const records = companyData.forCompany(companyId).records
    const row = records.byIds([recordId])[0]
    if (!row || row.removedAt !== null || row.members === null) return
    let now = fieldsOf(records, recordId)
    const joining = attending.filter(u => !row.members?.includes(u))
    if (joining.length > 0) {
      const shown = [...new Set([...attendeeIds(now.fields.attendees), ...joining])]
      while (JSON.stringify(shown).length > 500) shown.pop()
      writer.transition(companyId, {
        recordId, action: MEETING_ATTENDEES_ACTION, expectedVersion: now.version, to: null, addMembers: joining,
        fields: { attendees: JSON.stringify(shown) }, actor: GOOGLE_ACTOR, note: ATTENDEES_NOTE,
        ...(now.state === MEETING_ARRIVED_STATE ? { notify: joining } : { quiet: true }),
      })
      now = fieldsOf(records, recordId)
    }
    if (wantsAuto && now.state === MEETING_ARRIVED_STATE && (records.byIds([recordId])[0]?.members ?? []).includes(userId)) {
      await askToRead(companyId, userId, recordId, now.version, { ...CLOCK_ACTOR }, AUTO_SERIES_NOTE)
    }
  }

  /** The body `{ expectedVersion? }` of an attendee's button, or why not. */
  function versionBody(body: unknown, current: number): number | Refusal {
    const b = body as Record<string, unknown> | null
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return refuse('bad-request', 'The body must be an object', { code: 'BAD_REQUEST' })
    for (const k of Object.keys(b)) if (k !== 'expectedVersion') return refuse('bad-request', `Unknown key: ${k}`, { code: 'BAD_REQUEST' })
    if (b.expectedVersion === undefined) return current
    if (typeof b.expectedVersion !== 'number' || !Number.isInteger(b.expectedVersion)) return refuse('bad-request', 'expectedVersion: a whole number', { code: 'BAD_REQUEST' })
    return b.expectedVersion
  }

  return {
    /** GET /google/minutes-folder — owner/admin. */
    folderSetting(member: Member): Outcome<MinutesFolderSetting> {
      if (!FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', 'この設定は管理者だけが見られます', { code: 'FORBIDDEN' })
      const handle = companyData.forCompany(member.companyId)
      return ok(folderView(handle, handle.records.minutesFolder()))
    },

    /**
     * PUT /google/minutes-folder { folder?: string | null, meetings?: 'external' | 'all',
     * bundleQuestionDays?: 1–30 } — owner/admin; at least one. The folder is a department folder, never private.
     */
    setFolder(member: Member, body: unknown): Outcome<MinutesFolderSetting> {
      if (!FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', 'この設定は管理者だけが変えられます', { code: 'FORBIDDEN' })
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b) || !('folder' in b || 'meetings' in b || 'bundleQuestionDays' in b)) {
        return refuse('bad-request', 'folder: a department folder or null; meetings: external or all; bundleQuestionDays: 1–30', { code: 'BAD_REQUEST' })
      }
      for (const k of Object.keys(b)) if (k !== 'folder' && k !== 'meetings' && k !== 'bundleQuestionDays') return refuse('bad-request', `Unknown key: ${k}`, { code: 'BAD_REQUEST' })
      if ('meetings' in b && !(MEETING_INTAKE_CHOICES as readonly unknown[]).includes(b.meetings)) {
        return refuse('bad-request', `meetings: ${MEETING_INTAKE_CHOICES.join(' or ')}`, { code: 'BAD_REQUEST' })
      }
      const days = b.bundleQuestionDays
      if ('bundleQuestionDays' in b && !(typeof days === 'number' && Number.isInteger(days) && days >= MEETING_BUNDLE_DAYS_MIN && days <= MEETING_BUNDLE_DAYS_MAX)) {
        return refuse('bad-request', `bundleQuestionDays: a whole number ${MEETING_BUNDLE_DAYS_MIN}–${MEETING_BUNDLE_DAYS_MAX}`, { code: 'BAD_REQUEST' })
      }
      const handle = companyData.forCompany(member.companyId)
      let folder: string | null = handle.records.minutesFolder()
      if ('folder' in b) {
        folder = null
        if (b.folder !== null) {
          const wanted = typeof b.folder === 'string' ? normalizeRepoPath(b.folder) : null
          folder = wanted ? usableFolder(handle, wanted) : null
          // One answer for "not a department" and "private": the place is never named.
          if (!folder) return refuse('bad-request', MINUTES_FOLDER_REFUSED.error, { code: MINUTES_FOLDER_REFUSED.code })
        }
      }
      const at = deps.clock.now()
      if ('folder' in b) handle.records.setMinutesFolder(folder, member.userId, at)
      if ('meetings' in b) handle.records.setMeetingIntake(b.meetings as string, member.userId, at)
      if ('bundleQuestionDays' in b) handle.records.setMeetingBundleDays(days as number, member.userId, at)
      return ok(folderView(handle, folder))
    },

    /**
     * An automatic run of reading this meeting ended unfinished (ai-runs `finish`, failed): back to
     * 「届いた」 at once, so it is not stuck for 30 minutes. The ledger names the run (cause `run`),
     * not the member. Only a meeting the run's member reads and that is still 「読んでいる」.
     */
    putBackAfterRun(member: Member, recordId: string, runId: string): void {
      const handle = companyData.forCompany(member.companyId)
      if (!handle.records.settings().enabled) return
      if (!readableMeeting(handle, recordReader(member, handle.scopes.listWithRules()), recordId)) return
      putBack(member.companyId, recordId, { id: member.userId, kind: 'ai', source: null, runId }, RUN_PUT_BACK_NOTE)
    },

    /**
     * POST /me/minutes/check — the member's own calendar now (an older app calls it at start, every
     * 10 minutes and on a button; the server clock finds meetings without it since 2026-11-04). The
     * same discovery as the clock's for this member, plus putting back their stale readings.
     */
    async check(member: Member): Promise<Outcome<MinutesCheckResult>> {
      if (!companyData.forCompany(member.companyId).records.settings().enabled) return disabled()
      // 会議と議事録 off: nothing is looked up; an older app's periodic check gets a quiet empty answer.
      if (!featureOn(member.companyId)) return ok({ checked: false, message: FEATURE_OFF.error, meetings: 0, internalOnly: 0, created: [], existing: 0, waiting: 0, stale: [] })
      const stale = putBackStale(member)
      const found = await discover(member.companyId, member.userId, { calls: MEETING_CALLS_PER_CHECK })
      if (!found.ok) return found
      return ok({ ...found.value, stale })
    },

    /**
     * The server clock (notifications.md "The server clock"): discovery for every member of the
     * company, one after another with `between` (a yield) in between. A member whose Google is not
     * usable for meetings (no grant, 予定と議事録を読む off, the company's switches) is refused
     * locally, before anything leaves ACB, and skipped. Returns the meetings recorded.
     */
    async pollCompany(companyId: string, between: () => Promise<void> = async () => {}, calls = MEETING_CALLS_PER_RUN): Promise<number> {
      if (!companyData.forCompany(companyId).records.settings().enabled) return 0
      if (!featureOn(companyId)) return 0
      const budget = { calls }
      // A different member first on each run, so a capped run does not always leave the same ones out.
      const all = deps.members(companyId)
      const start = all.length > 0 ? (pollTurn.get(companyId) ?? 0) % all.length : 0
      pollTurn.set(companyId, start + 1)
      const order = [...all.slice(start), ...all.slice(0, start)]
      // First every member's events: someone's private copy marks the event before anyone records it.
      const found: Array<{ userId: string; events: MeetEvent[] }> = []
      for (const m of order) {
        if (budget.calls <= 0) break
        try {
          putBackStale({ companyId, userId: m.userId, role: m.role })
          budget.calls--
          const r = await eventsOf(companyId, m.userId)
          if (r.ok) { markPrivate(companyId, r.value); found.push({ userId: m.userId, events: r.value }) }
        } catch (e) {
          logError('minutes', 'discovery failed', e, { companyId })
        }
        await between()
      }
      let created = 0
      for (const f of found) {
        if (budget.calls <= 0) break
        try {
          const r = await discoverEvents(companyId, f.userId, f.events, budget)
          if (r.ok) created += r.value.created.length
        } catch (e) {
          // One member's failure never stops the others (no meeting, address or text in the log).
          logError('minutes', 'discovery failed', e, { companyId })
        }
        await between()
      }
      return created
    },

    /**
     * The minutes as outside text, for the assignee or an attendee (their own Google permission).
     * `paged`: the caller hands it to its AI in parts (`minutes_read`'s `part`), so it may be longer
     * (`MINUTES_TEXT_PAGED_MAX`) and keeps the end of a document longer than that (its middle skipped
     * with a mark); without it an older app gets `MINUTES_TEXT_MAX`, end cut, as before.
     */
    async text(member: Member, recordId: string, options: { paged?: boolean } = {}): Promise<Outcome<MinutesText>> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      if (!featureOn(member.companyId)) return featureOff()
      const reader = recordReader(member, handle.scopes.listWithRules())
      const row = readableMeeting(handle, reader, recordId)
      if (!row) return notFound()
      const now = fieldsOf(records, row.id)
      if (!isAttendee(row, now.fields, member.userId)) return refuse('forbidden', MINUTES_NOT_YOURS.error, { code: MINUTES_NOT_YOURS.code })
      const ref = parseRef(now.fields.source_ref)
      if (!ref || ref.docs.length === 0) return refuse('conflict', 'この議事録の元の文書が分かりません。', { code: 'MINUTES_SOURCE_UNKNOWN' })

      const read = await (options.paged
        ? readDocuments(member.companyId, member.userId, ref, MINUTES_TEXT_PAGED_MAX, true)
        : readDocuments(member.companyId, member.userId, ref, MINUTES_TEXT_MAX))
      if (!read.ok) return read
      const { text, truncated, versions } = read.value
      let event: MeetEvent | null = null
      try {
        event = await meetings.event(member.companyId, member.userId, ref.event)
      } catch (err) {
        if (err instanceof GoogleReadFailed) return googleRefusal(err)
        throw err
      }

      const names = new Map(deps.members(member.companyId).map(m => [m.userId, m.name]))
      const linked = handle.records.linksFrom([row.id]).find(l => l.name === 'bundle' && l.targetId)
      const bundleRow = linked ? handle.records.byIds([linked.targetId as string]).find(r => r.removedAt === null && reader.record(r)) : undefined
      const bundle = bundleRow ? bundleSummary(handle, bundleRow) : null
      const domain = handle.connectors.client()?.domain ?? null
      const externalDomains = event && domain
        ? [...new Set(event.attendees.filter(a => isExternalAddress(a.email, [domain])).map(a => emailDomain(a.email)))]
        : []
      const types = currentTypes(records)
      const candidates = bundle ? [] : bundleCandidates(handle, reader, externalDomains, row.title)
        .map(r => ({ id: r.id, title: r.title, typeLabel: types.get(r.type)?.definition.label ?? r.type }))
      return ok({
        recordId: row.id,
        version: now.version,
        header: MINUTES_TEXT_HEADER,
        // 【】 → 〔〕 (outside-text.ts): the text cannot close the block, in an older app too.
        text: neutralizeOutsideText(text),
        footer: MINUTES_TEXT_FOOTER,
        truncated,
        docVersion: versions.join(','),
        meeting: { title: row.title, at: typeof now.fields.meeting_at === 'string' ? now.fields.meeting_at : null },
        folder: row.folder,
        attendees: attendeeIds(now.fields.attendees).map(id => ({ memberId: id, displayName: names.get(id) ?? '' })),
        externalAttendees: typeof now.fields.external_count === 'number' ? now.fields.external_count : 0,
        bundle,
        candidates,
        noBundle: noBundleChosen(handle, row.id),
        instructionLike: outsideTextFlags(text).map(label => ({ label, words: INSTRUCTION_LIKE_WORDS[label] ?? label })),
      })
    },

    /**
     * POST …/minutes/item/:recordId/bundle { bundleId, expectedVersion? } — the assignee, an admin,
     * or their AI: which まとまり (any type implementing `bundle`) the meeting belongs to.
     */
    async linkBundle(member: Member, actor: Omit<ServiceActor, 'id'> & { kind: 'human' | 'ai' }, recordId: string, body: unknown): Promise<Outcome<MinutesLinkBundleResult>> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      if (!featureOn(member.companyId)) return featureOff()
      const reader = recordReader(member, handle.scopes.listWithRules())
      const row = readableMeeting(handle, reader, recordId)
      if (!row) return notFound()
      const now = fieldsOf(records, row.id)
      if (!mayChooseBundle(member, now.fields, row)) {
        return refuse('forbidden', 'どのまとまりの会議かを選べるのは、会議の担当の人か管理者です。', { code: 'MINUTES_NOT_YOURS' })
      }
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return refuse('bad-request', 'The body must be an object', { code: 'BAD_REQUEST' })
      for (const k of Object.keys(b)) if (k !== 'bundleId' && k !== 'expectedVersion') return refuse('bad-request', `Unknown key: ${k}`, { code: 'BAD_REQUEST' })
      if (b.expectedVersion !== undefined && (typeof b.expectedVersion !== 'number' || !Number.isInteger(b.expectedVersion))) {
        return refuse('bad-request', 'expectedVersion: a whole number', { code: 'BAD_REQUEST' })
      }
      // Any まとまり the member reads, whatever its type; anything else (a missing id, an unreadable
      // record, a record of another kind) gets one answer.
      const bundles = typesImplementing(handle, 'bundle')
      const bundleRow = typeof b.bundleId === 'string' && RECORD_ID_RE.test(b.bundleId)
        ? records.byIds([b.bundleId]).find(r => r.removedAt === null && bundles.has(r.type) && reader.record(r))
        : undefined
      if (!bundleRow) return refuse('bad-request', 'bundleId: a まとまり (bundle) record you can read', { code: 'BAD_LINK' })
      const counterpart = counterpartOf(handle, reader, bundleRow.id)
      const expected = typeof b.expectedVersion === 'number' ? b.expectedVersion : now.version
      // Read without a まとまり: the meeting stays read (no AI run of its own); the まとまり moves to the
      // business plugin's step for it, as after a reading — once (minutes.md "A まとまり chosen later").
      const firstAfterReading = now.state === 'read' && !records.linksFrom([row.id]).some(l => l.name === 'bundle' && l.targetId)
      const r = writer.transition(member.companyId, {
        recordId: row.id, action: MEETING_BUNDLE_LINKED_ACTION, expectedVersion: expected, to: null,
        links: { bundle: [bundleRow.id], counterpart: counterpart ? [counterpart] : [] },
        actor: { id: member.userId, ...actor },
      })
      if (!r.ok) {
        if (r.reason === 'stale') return refuse('conflict', 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', { code: 'VERSION_CONFLICT', version: fieldsOf(records, row.id).version })
        if (r.reason === 'records-off') return disabled()
        return refuse('bad-request', 'まとまりをつなげませんでした', { code: 'MINUTES_LINK_REFUSED' })
      }
      if (firstAfterReading && deps.afterAction) {
        try {
          await deps.afterAction(member, { kind: actor.kind, source: actor.source ?? undefined, conversationId: actor.conversationId ?? null, runId: actor.runId ?? null },
            { recordId: row.id, type: MEETING_TYPE, action: MEETING_BUNDLE_LINKED_ACTION, toState: 'read' })
        } catch { /* the link stands; the まとまり's step is best effort */ }
      }
      return ok({ recordId: row.id, bundleId: bundleRow.id, counterpartId: counterpart, version: r.entry.version })
    },

    /**
     * GET /me/minutes/bundle-questions — the member's 「どのまとまりの会議ですか？」 items of あなたの番
     * (minutes.md "The まとまり question"): meetings they are the assignee of, read within the
     * company's days, with someone from outside, no まとまり linked, the question not closed — only
     * in a company with some まとまり the member reads. The app shows exactly these.
     */
    bundleQuestions(member: Member): Outcome<MeetingBundleQuestions> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      if (!featureOn(member.companyId)) return ok({ days: meetingBundleDaysOf(records.meetingBundleDays()), questions: [] })
      const days = meetingBundleDaysOf(records.meetingBundleDays())
      const reader = recordReader(member, handle.scopes.listWithRules())
      // プロジェクト off (「使う機能」): the core's kind is no choice; a business plugin's kind still is.
      const projectsOn = deps.projectsOn?.(member.companyId) ?? true
      const bundleTypes = [...typesImplementing(handle, 'bundle').keys()].filter(t => projectsOn || t !== CORE_BUNDLE_TYPE)
      if (bundleTypes.length === 0 || !records.candidates({ types: bundleTypes }, 200).some(r => reader.record(r))) return ok({ days, questions: [] })
      const since = new Date(deps.clock.nowMs() - days * 86_400_000).toISOString()
      const rows = records.candidates({
        types: [MEETING_TYPE], states: ['read'], fields: [{ name: 'assignee', values: [member.userId] }],
        finishedSince: { since, finals: [{ type: MEETING_TYPE, state: 'read' }] },
      }, MAX_BUNDLE_QUESTIONS).filter(r => reader.record(r))
      const questions: MeetingBundleQuestion[] = []
      for (const row of records.byIds(rows.map(r => r.id))) {
        const now = fieldsOf(records, row.id)
        const ledger = records.ledger(row.id)
        const asks = meetingAsksBundle({
          externalAttendees: typeof now.fields.external_count === 'number' ? now.fields.external_count : 0,
          hasBundle: hasBundleLink(handle, row.id),
          noBundleChosen: ledger.some(e => e.action === MEETING_NO_BUNDLE_ACTION),
          bundleKindInUse: bundleTypes.length > 0,
        })
        if (!asks) continue
        const readAt = [...ledger].reverse().find(e => e.toState === 'read' && e.fromState !== 'read')?.at
        if (!readAt || readAt < since) continue
        questions.push({
          recordId: row.id, title: row.title, version: now.version,
          meetingAt: typeof now.fields.meeting_at === 'string' ? now.fields.meeting_at : null,
          readAt, group: bundleGroup(handle, reader, row, now.fields), suggested: suggestedBundle(handle, reader, row.id),
        })
      }
      questions.sort((a, b) => (b.readAt < a.readAt ? -1 : b.readAt > a.readAt ? 1 : 0))
      return ok({ days, questions })
    },

    /** GET /me/minutes/item/:recordId/bundle-question — the meeting card's 「まとまりを選ぶ」 / 「まとまりはない」. */
    bundleQuestion(member: Member, recordId: string): Outcome<MeetingBundleQuestionState> {
      const handle = companyData.forCompany(member.companyId)
      if (!handle.records.settings().enabled) return disabled()
      if (!featureOn(member.companyId)) return featureOff()
      const row = readableMeeting(handle, recordReader(member, handle.scopes.listWithRules()), recordId)
      if (!row) return notFound()
      const now = fieldsOf(handle.records, row.id)
      const canChoose = mayChooseBundle(member, now.fields, row) && !hasBundleLink(handle, row.id)
      const reader = recordReader(member, handle.scopes.listWithRules())
      return ok({
        recordId: row.id, title: row.title, version: now.version, canChoose,
        noBundle: noBundleChosen(handle, row.id),
        suggested: canChoose ? suggestedBundle(handle, reader, row.id) : null,
      })
    },

    /**
     * POST /me/minutes/item/:recordId/no-bundle { expectedVersion? } — the assignee or an admin:
     * 「まとまりはない（社内の会議など）」. Closes the question for good: a ledger entry that is the
     * person's choice, no field, no state, no AI turn, nobody told. A まとまり can still be chosen later.
     */
    noBundle(member: Member, actor: Omit<ServiceActor, 'id'>, recordId: string, body: unknown): Outcome<MinutesNoBundleResult> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      if (!featureOn(member.companyId)) return featureOff()
      const row = readableMeeting(handle, recordReader(member, handle.scopes.listWithRules()), recordId)
      if (!row) return notFound()
      const now = fieldsOf(records, row.id)
      if (!mayChooseBundle(member, now.fields, row)) {
        return refuse('forbidden', 'まとまりがないと決められるのは、会議の担当の人か管理者です。', { code: 'MINUTES_NOT_YOURS' })
      }
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return refuse('bad-request', 'The body must be an object', { code: 'BAD_REQUEST' })
      for (const k of Object.keys(b)) if (k !== 'expectedVersion') return refuse('bad-request', `Unknown key: ${k}`, { code: 'BAD_REQUEST' })
      if (b.expectedVersion !== undefined && (typeof b.expectedVersion !== 'number' || !Number.isInteger(b.expectedVersion))) {
        return refuse('bad-request', 'expectedVersion: a whole number', { code: 'BAD_REQUEST' })
      }
      if (hasBundleLink(handle, row.id)) {
        return refuse('conflict', 'この会議には、もうまとまりがつながっています。', { code: 'MINUTES_HAS_BUNDLE', version: now.version })
      }
      // Asked twice (two windows, a retry): the first answer stands, nothing more is written.
      if (noBundleChosen(handle, row.id)) return ok({ recordId: row.id, version: now.version })
      const r = writer.transition(member.companyId, {
        recordId: row.id, action: MEETING_NO_BUNDLE_ACTION, expectedVersion: typeof b.expectedVersion === 'number' ? b.expectedVersion : now.version,
        to: null, note: NO_BUNDLE_NOTE, quiet: true, actor: { id: member.userId, ...actor },
      })
      if (!r.ok) {
        if (r.reason === 'stale') return refuse('conflict', 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', { code: 'VERSION_CONFLICT', version: fieldsOf(records, row.id).version })
        if (r.reason === 'records-off') return disabled()
        return refuse('bad-request', 'できませんでした', { code: 'MINUTES_NO_BUNDLE_REFUSED' })
      }
      return ok({ recordId: row.id, version: r.entry.version })
    },

    /**
     * POST /me/minutes/item/:recordId/read-request { expectedVersion? } — ［AI に読ませる］: any of the
     * meeting's people (minutes.md "Meetings for their attendees"). A meeting that arrived, that
     * someone chose not to read, or whose reading failed (another attendee's Google may be shared
     * the minutes) becomes the AI's turn on the caller's PC; they are its assignee. Pressed again by
     * the same member while it waits for their AI: the same answer, nothing written.
     */
    async requestReading(member: Member, recordId: string, body: unknown): Promise<Outcome<MeetingReadRequestResult>> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      if (!featureOn(member.companyId)) return featureOff()
      const row = readableMeeting(handle, recordReader(member, handle.scopes.listWithRules()), recordId)
      if (!row) return notFound()
      const now = fieldsOf(records, row.id)
      if (!isAttendee(row, now.fields, member.userId)) return refuse('forbidden', MINUTES_NOT_YOURS.error, { code: MINUTES_NOT_YOURS.code })
      const expected = versionBody(body, now.version)
      if (typeof expected !== 'number') return expected
      if (now.state === 'received' && now.fields.assignee === member.userId) {
        // Nothing new on the record; a run that stopped before this press still must not hold the reading back.
        deps.readingAskedAgain?.(member.companyId, row.id)
        return ok({ recordId: row.id, version: now.version, state: 'received' })
      }
      if (!['arrived', 'skipped', 'failed'].includes(now.state ?? '')) {
        return refuse('conflict', 'この会議は、もう AI が読んでいるか、読み終わっています。', { code: 'MEETING_NOT_WAITING', version: now.version })
      }
      if (expected !== now.version) return refuse('conflict', 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', { code: 'VERSION_CONFLICT', version: now.version })
      return askToRead(member.companyId, member.userId, row.id, expected, { id: member.userId, kind: 'human', source: null }, READ_REQUEST_NOTE)
    },

    /**
     * POST /me/minutes/item/:recordId/skip { expectedVersion? } — ［読まない］: any of the meeting's
     * people while it has only arrived (or its reading failed) — nobody is asked again, the record is
     * kept and its 経緯 says who chose it; the assignee alone while it waits for their AI (「今回だけ
     * 読まない」 of an automatic series). Asked twice: the first answer stands.
     */
    skipReading(member: Member, recordId: string, body: unknown): Outcome<MeetingSkipResult> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      if (!featureOn(member.companyId)) return featureOff()
      const row = readableMeeting(handle, recordReader(member, handle.scopes.listWithRules()), recordId)
      if (!row) return notFound()
      const now = fieldsOf(records, row.id)
      if (!isAttendee(row, now.fields, member.userId)) return refuse('forbidden', MINUTES_NOT_YOURS.error, { code: MINUTES_NOT_YOURS.code })
      const expected = versionBody(body, now.version)
      if (typeof expected !== 'number') return expected
      if (now.state === 'skipped') return ok({ recordId: row.id, version: now.version })
      const mayEnd = now.state === 'arrived' || now.state === 'failed' || (now.state === 'received' && now.fields.assignee === member.userId)
      if (!mayEnd) return refuse('conflict', 'この会議は、いまは「読まない」にできません。', { code: 'MEETING_NOT_WAITING', version: now.version })
      const r = writer.transition(member.companyId, {
        recordId: row.id, action: MEETING_SKIP_ACTION, expectedVersion: expected, to: 'skipped', note: SKIP_NOTE, quiet: true,
        actor: { id: member.userId, kind: 'human', source: null },
      })
      if (!r.ok) {
        if (r.reason === 'stale') return refuse('conflict', 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', { code: 'VERSION_CONFLICT', version: fieldsOf(records, row.id).version })
        if (r.reason === 'records-off') return disabled()
        return refuse('conflict', 'この会議は、いまは「読まない」にできません。', { code: 'MEETING_NOT_WAITING', version: fieldsOf(records, row.id).version })
      }
      return ok({ recordId: row.id, version: r.entry.version })
    },

    /**
     * PUT /me/minutes/item/:recordId/auto-series { auto } — 「この定例は次から自動で読む」: the caller's
     * own choice for the meeting's recurring series (one of the meeting's people; a meeting of no
     * series → 409). Applies to the meetings of the series the caller's discovery finds from now on.
     */
    setAutoSeries(member: Member, recordId: string, body: unknown): Outcome<MeetingAutoSeriesResult> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      if (!featureOn(member.companyId)) return featureOff()
      const row = readableMeeting(handle, recordReader(member, handle.scopes.listWithRules()), recordId)
      if (!row) return notFound()
      const now = fieldsOf(records, row.id)
      if (!isAttendee(row, now.fields, member.userId)) return refuse('forbidden', MINUTES_NOT_YOURS.error, { code: MINUTES_NOT_YOURS.code })
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b) || typeof b.auto !== 'boolean' || Object.keys(b).some(k => k !== 'auto')) {
        return refuse('bad-request', 'auto: true or false', { code: 'BAD_REQUEST' })
      }
      const series = parseRef(now.fields.source_ref)?.series
      if (!series) return refuse('conflict', 'この会議はくり返しの予定（定例）ではありません。', { code: 'MEETING_NOT_SERIES' })
      records.setMeetingAutoSeries(member.userId, seriesKey(series), b.auto, deps.clock.now())
      return ok({ recordId: row.id, autoSeries: b.auto })
    },

    /**
     * GET /me/minutes/arrivals — the caller's meetings of the last `MEETING_ARRIVED_DAYS` days (by
     * when they took place) for the task list's 「議事録が届きました」, newest first: only meetings
     * the caller reads, ids / titles / times / counts / names of members on the list — never text.
     * Older ones leave this answer and stay openable and readable from their card.
     */
    arrivals(member: Member): Outcome<MeetingArrivals> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return disabled()
      // 会議と議事録 off: nothing has arrived (earlier meetings stay on their cards and in 探す).
      if (!featureOn(member.companyId)) return ok({ days: MEETING_ARRIVED_DAYS, items: [] })
      const reader = recordReader(member, handle.scopes.listWithRules())
      const since = new Date(deps.clock.nowMs() - MEETING_ARRIVED_DAYS * 86_400_000).toISOString()
      // Only meetings whose list names the member (every meeting found since 2026-11-04), then by time.
      const listed = records.listedRecordIds(member.userId, MEETING_TYPE)
      const recent = new Set(records.states(listed).filter(st => {
        try { const at = (JSON.parse(st.fields) as Record<string, unknown>).meeting_at; return typeof at === 'string' && at >= since } catch { return false }
      }).map(st => st.recordId))
      const rows = records.byIds(listed.filter(id => recent.has(id))).filter(r => r.removedAt === null && reader.record(r)).slice(0, MAX_ARRIVALS)
      const names = new Map(deps.members(member.companyId).map(m => [m.userId, m.name]))
      const auto = new Set(records.meetingAutoSeries(member.userId))
      const status: Record<string, MeetingArrival['status']> = { arrived: 'arrived', received: 'asked', reading: 'reading', read: 'read', skipped: 'skipped', failed: 'failed' }
      const items: MeetingArrival[] = []
      for (const row of records.byIds(rows.map(r => r.id))) {
        const now = fieldsOf(records, row.id)
        const st = status[now.state ?? '']
        if (!st) continue
        let byId: string | null = null
        if (st === 'skipped') byId = [...records.ledger(row.id)].reverse().find(e => e.toState === 'skipped' && e.fromState !== 'skipped' && e.actorKind === 'human')?.actorId ?? null
        else if (st !== 'arrived' && typeof now.fields.assignee === 'string') byId = now.fields.assignee
        const series = parseRef(now.fields.source_ref)?.series ?? null
        items.push({
          recordId: row.id, title: row.title, version: now.version,
          meetingAt: typeof now.fields.meeting_at === 'string' ? now.fields.meeting_at : null,
          status: st, attendeeCount: row.members?.length ?? attendeeIds(now.fields.attendees).length,
          by: byId ? { memberId: byId, displayName: names.get(byId) ?? '' } : null, byYou: byId === member.userId,
          series: series !== null, autoSeries: series !== null && auto.has(seriesKey(series)),
        })
      }
      items.sort((a, b) => ((b.meetingAt ?? '') < (a.meetingAt ?? '') ? -1 : (b.meetingAt ?? '') > (a.meetingAt ?? '') ? 1 : 0))
      return ok({ days: MEETING_ARRIVED_DAYS, items })
    },

    /**
     * For the thank-you mail (G8): the meeting's attendees from the calendar,
     * read now with the member's own permission — the verified recipients'
     * source. Only for the assignee or an attendee who may read the record.
     * `external`: outside the company's Google domain.
     */
    async meetingAttendees(companyId: string, userId: string, role: string, meetingId: string): Promise<Outcome<Array<MeetingAttendee & { external: boolean }>>> {
      const member: Member = { companyId, userId, role }
      const handle = companyData.forCompany(companyId)
      if (!handle.records.settings().enabled) return disabled()
      const row = readableMeeting(handle, recordReader(member, handle.scopes.listWithRules()), meetingId)
      if (!row) return notFound()
      const now = fieldsOf(handle.records, row.id)
      if (!isAttendee(row, now.fields, userId)) return refuse('forbidden', MINUTES_NOT_YOURS.error, { code: MINUTES_NOT_YOURS.code })
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
