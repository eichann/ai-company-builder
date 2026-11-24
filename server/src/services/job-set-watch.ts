/**
 * The set watch's combination (schema 5, 4b-4 PR2; `.claude/rules/jobs.md` "The set watch (schema 5)"; owner memo 「4b-4 商談から
 * 提案書」 第6版 §2 / §3 / 付録 B): what makes a ledger row the event of the one opened line of `JOB_SET_WATCH_OPENED` — 「自分が担当の
 * 『議事録を確認する』が、その一生で初めて完了したとき」 — and its guards, at the scan and while its run goes on. **Only the rules of
 * the combination live here**: reading the ledger by delivery number, the cursor, the gaps, the day's limit and the mark are the
 * scan's (job-events.ts `scanSetJob`), the run's conditions around it the occurrences' (job-occurrences.ts `eventCondition`).
 * Opening another combination adds its own matcher and guards here, reviewed then.
 *
 * - **The record** (§2-2): a やること (`task`) whose `task_kind` was `minutes_review` when it was made, made by the minutes intake
 *   (`MINUTES_ACTOR`: no person's or AI's create may write `task_kind`, records.md), with exactly one `links.meeting` and the id the
 *   meeting's output id gives (`minutesReviewId`) — never told by a title.
 * - **The event**: its **first** `done` in its whole ledger (`first_done`), by a change `ledgerRowIsEvent` counts (the scan's).
 * - **Whose** (`responsible_from_creation`): its assignee was the job's responsible person in its first version and still at
 *   the event. Anyone else's record is never this job's (no mark: it is not this job's to mark, T18).
 * - **Guards** (each named in the definition, so the responsible person consented to them): `after_acceptance` — the record
 *   made and the meeting first read after the job's current consent was accepted, compared by delivery number (a row without
 *   one cannot be compared: out); `people_only_meeting` — the meeting has its own attendee list (members-only), so one from
 *   before 2026-11-04 is out; `attendee_responsible` — the responsible person reads the record and the meeting now and is one
 *   of the meeting's people; `outside_attendee` — at least one attendee from outside the company; `plugin_step_exclusive` — no
 *   business plugin step running one of the job's Skills is busy with the meeting's まとまり for that meeting (§3 ②).
 */
import { MINUTES_ACTOR, MINUTES_REVIEW_KIND, TASK_KIND_FIELD } from '../../shared/core/core-types'
import {
  JOB_ACTOR, JOB_SET_CHECK_KIND, JOB_SET_WATCH_SCHEMA, isSetTrigger, jobPinnedDepartmentSkills, jobSetWatchOpened, occurrenceTaskId, storedJobDefinition,
  type JobDefinition, type JobOutcomeCode, type JobSetMarkOutcome, type JobSetTrigger,
} from '../../shared/core/jobs'
import { replayRecordState, type LedgerEntry, type LedgerValue } from '../../shared/core/record-ledger'
import type { CompanyData } from '../ports/company-data'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { isMeetingPerson } from './meeting-people'
import { recordReader } from './record-access'
import type { ServiceCreateInput } from './record-engine'
import { currentTypes } from './record-index'

/** The meeting's output id of its 「議事録を確認する」 (minutes-review.ts: `meetingOutputId(…, 'task', meeting, MINUTES_REVIEW_KEY)`). */
export type MinutesReviewId = (meetingId: string) => string

/** A version of a set watch the server runs: schema 5, its trigger the set watch's, on the PC, checked by `matched_record`. */
export function isSetWatchDefinition(d: JobDefinition | null): d is JobDefinition & { trigger: JobSetTrigger } {
  return d !== null && d.schema === JOB_SET_WATCH_SCHEMA && isSetTrigger(d.trigger) && d.placement === 'a' && d.check.kind === JOB_SET_CHECK_KIND
}

/** An occurrence of a set watch (its record and the meeting it was made for, pinned when made). */
export function isSetWatchOccurrence(occ: { eventRecordId?: string | null; eventMeetingId?: string | null }, definition: JobDefinition | null): boolean {
  return !!occ.eventRecordId && !!occ.eventMeetingId && isSetWatchDefinition(definition)
}

/** The fields of a record now (its state's), or {}. */
export function fieldsNow(handle: CompanyData, recordId: string): { state: string | null; fields: Record<string, LedgerValue> } {
  const s = handle.records.states([recordId])[0]
  let fields: Record<string, LedgerValue> = {}
  try { fields = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { fields = {} }
  return { state: s?.state ?? null, fields }
}

/** The record, live and readable by `member` now; else null. */
function readable(handle: CompanyData, member: Member, recordId: string): RecordRow | null {
  const row = handle.records.byIds([recordId])[0]
  if (!row || row.removedAt !== null) return null
  return recordReader(member, handle.scopes.listWithRules()).record(row) ? row : null
}

/** The meeting record (type `meeting`) the member reads now and is one of the people of; else null. */
export function meetingOfPerson(handle: CompanyData, member: Member, meetingId: string): RecordRow | null {
  const row = readable(handle, member, meetingId)
  if (!row || row.type !== 'meeting') return null
  return isMeetingPerson(row, fieldsNow(handle, meetingId).fields, member.userId) ? row : null
}

/**
 * Who sees a set watch's occurrence (§2-5, I8): someone who reads its record now **and** reads the meeting it was made for and is
 * one of that meeting's people (on its list as a person, its assignee or an attendee) — an owner / admin who did not attend
 * included: never.
 */
export function setOccurrenceShown(handle: CompanyData, member: Member, recordId: string, meetingId: string): boolean {
  return readable(handle, member, recordId) !== null && meetingOfPerson(handle, member, meetingId) !== null
}

/** The record's one `links.meeting` now, or null (none, or more than one). */
function meetingLinkOf(handle: CompanyData, recordId: string): string | null {
  const links = handle.records.linksFrom([recordId]).filter(l => l.name === 'meeting')
  return links.length === 1 && links[0].targetId ? links[0].targetId : null
}

/** The record's assignee at a version of its ledger, or null (the ledger cannot say). */
function assigneeAt(ledger: LedgerEntry[], version: number): string | null {
  try {
    const v = replayRecordState(ledger, version).fields.assignee
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/**
 * Whether the company's task type still means what the combination names (T9): a `task_kind` choice that holds
 * `minutes_review`, and a `meeting` link. When it no longer does, the scan reads nothing for the job (it never guesses).
 */
export function minutesReviewKindKnown(handle: CompanyData): boolean {
  const def = currentTypes(handle.records).get('task')?.definition
  return !!def && def.fields[TASK_KIND_FIELD]?.options?.includes(MINUTES_REVIEW_KIND) === true && def.links.meeting !== undefined
}

/**
 * The record of a ledger row when it is the combination's (§2-2): a 「議事録を確認する」 the minutes intake made for its one meeting,
 * in its first `done` (the row's), its assignee the responsible person from its first version and at the row. null when it is not
 * — or when it is someone else's (that job's to judge; nothing is marked here).
 */
export function minutesReviewEvent(handle: CompanyData, minutesReviewId: MinutesReviewId, responsible: string, row: { recordId: string; version: number }): { meetingId: string } | null {
  const ledger = handle.records.ledger(row.recordId)
  const first = ledger.find(e => e.version === 1)
  if (!first || first.actorId !== MINUTES_ACTOR.id) return null
  let made: Record<string, LedgerValue>
  try { made = replayRecordState(ledger, 1).fields } catch { return null }
  if (made[TASK_KIND_FIELD] !== MINUTES_REVIEW_KIND) return null
  const meetingId = meetingLinkOf(handle, row.recordId)
  if (meetingId === null || minutesReviewId(meetingId) !== row.recordId) return null
  // `first_done`: never after an earlier completion (a reopen and a second completion are not the event).
  if (ledger.some(e => e.version < row.version && e.toState === 'done' && e.fromState !== 'done')) return null
  // `responsible_from_creation`: the responsible person's from its first version — the record of anyone else is not this job's.
  if (assigneeAt(ledger, 1) !== responsible) return null
  return { meetingId }
}

/**
 * The guards of the combination for one record (in the scan's transaction): null when they all hold, else the mark's outcome.
 * `boundary`: the delivery number at which the job's current consent was accepted (null: unknown — never compared). The
 * assignee at the event must still be the responsible person (assigned away in between: not this job's to run).
 */
export function setGuardRefusal(handle: CompanyData, trigger: JobSetTrigger, definition: JobDefinition, ctx: {
  responsible: Member; boundary: number | null; recordId: string; version: number; meetingId: string
}): Exclude<JobSetMarkOutcome, 'made' | 'paused' | 'day_limit'> | null {
  if (assigneeAt(handle.records.ledger(ctx.recordId), ctx.version) !== ctx.responsible.userId) return 'not_matched'
  for (const guard of trigger.guards) {
    const refusal = guardRefusal(handle, guard, definition, ctx)
    if (refusal) return refusal
  }
  return null
}

function guardRefusal(handle: CompanyData, guard: string, definition: JobDefinition, ctx: {
  responsible: Member; boundary: number | null; recordId: string; meetingId: string
}): Exclude<JobSetMarkOutcome, 'made' | 'paused' | 'day_limit'> | null {
  switch (guard) {
    case 'after_acceptance': {
      // Both after the job's current consent was accepted, by delivery number (never the clock); one without a number — a row
      // written before delivery numbers — is out, and no later reading stands in for the first (§2-3, T21).
      const made = handle.jobs.firstLedgerSeq(ctx.recordId, null)
      const read = handle.jobs.firstLedgerSeq(ctx.meetingId, 'read')
      const after = (seq: number | null | undefined) => ctx.boundary !== null && seq !== null && seq !== undefined && seq > ctx.boundary
      return after(made?.seq) && after(read?.seq) ? null : 'before_acceptance'
    }
    case 'people_only_meeting': {
      const row = handle.records.byIds([ctx.meetingId])[0]
      return row && row.removedAt === null && row.type === 'meeting' && row.members !== null ? null : 'not_matched'
    }
    case 'attendee_responsible':
      return readable(handle, ctx.responsible, ctx.recordId) !== null && meetingOfPerson(handle, ctx.responsible, ctx.meetingId) !== null ? null : 'not_matched'
    case 'outside_attendee': {
      const n = fieldsNow(handle, ctx.meetingId).fields.external_count
      return typeof n === 'number' && n > 0 ? null : 'not_matched'
    }
    case 'plugin_step_exclusive': {
      const bundle = handle.records.linksFrom([ctx.meetingId]).find(l => l.name === 'bundle' && l.targetId)?.targetId ?? null
      const skills = [...new Set(jobPinnedDepartmentSkills(definition).map(p => p.skill))]
      return bundle !== null && handle.pluginSteps.stepBusyWithSkills(bundle, ctx.meetingId, skills) ? 'step_busy' : null
    }
    // A guard this build does not know is never assumed to hold (an opened line names only known ones).
    default: return 'not_matched'
  }
}

/**
 * What a set watch's running occurrence still needs (its conditions beyond the job's — owner memo 付録 B 「C8 の代わり」), in this
 * order: its combination still opened (a line taken out stops it); the responsible person reads the record and the meeting and
 * is one of its people; the record's meeting is still the one it was made for; the record still `done`; its assignee still them.
 * null when all hold.
 */
export function setWatchCondition(handle: CompanyData, definition: JobDefinition, responsible: Member | null,
  occ: { eventRecordId?: string | null; eventMeetingId?: string | null }): JobOutcomeCode | null {
  if (!isSetTrigger(definition.trigger) || !jobSetWatchOpened(definition.trigger)) return 'SET_WATCH_NOT_OPENED'
  const recordId = occ.eventRecordId ?? ''
  const meetingId = occ.eventMeetingId ?? ''
  if (!responsible || !setOccurrenceShown(handle, responsible, recordId, meetingId)) return 'EVENT_RECORD_GONE'
  if (meetingLinkOf(handle, recordId) !== meetingId) return 'SET_WATCH_MEETING_CHANGED'
  const now = fieldsNow(handle, recordId)
  if (now.state !== 'done') return 'EVENT_NOT_NEEDED'
  if (now.fields.assignee !== responsible.userId) return 'EVENT_NOT_ASSIGNEE'
  return null
}

/**
 * The やること a set watch's finish makes (4b-4 PR3, owner memo §5-1 / 付録 B 「作るやること」): a service write — never the AI's
 * create, so the meeting's 出どころの枠 (a quote) does not apply —, its id from the occurrence (one by construction), **owner-only**
 * for the responsible person, linked to the meeting it was made for (`links.meeting`: the meeting's name reaches only someone
 * who reads the meeting, through the link). **Its name is the meeting's date only** (「11月23日の会議のたたき台を確かめる」):
 * the やること outlives the person's access to the meeting, so neither the meeting's name nor a customer's may be in it (I6,
 * T15). The judgement (進める / 人に聞く / 判断できなかった), its reason and what is not confirmed are **not** on it (T17): they are the
 * occurrence's (`ai_job_set_reports`, read only through its visibility) and the PC's. Quiet (D9): the やること in 「あなたの番」 is
 * the notice.
 */
export function setWatchTaskInput(handle: CompanyData, definition: JobDefinition,
  occ: { id: string; dueAt: string; timeZone: string; eventMeetingId?: string | null }, runId: string): ServiceCreateInput {
  const meetingId = occ.eventMeetingId ?? ''
  const at = fieldsNow(handle, meetingId).fields.meeting_at
  return {
    type: 'task', id: occurrenceTaskId(occ.id), title: setWatchTaskTitle(typeof at === 'string' ? at : null, occ.dueAt, occ.timeZone),
    personalOwner: definition.actingUser, fields: { assignee: definition.actingUser }, links: { meeting: [meetingId] },
    actor: { ...JOB_ACTOR, runId }, note: '定期の仕事から作りました', quiet: true,
  }
}

/** 「<月>月<日>日の会議のたたき台を確かめる」 from the meeting's time (else the event's), in company time: a date and fixed words only. */
export function setWatchTaskTitle(meetingAt: string | null, fallback: string, timeZone: string): string {
  const ms = meetingAt !== null && !Number.isNaN(Date.parse(meetingAt)) ? Date.parse(meetingAt) : Date.parse(fallback)
  let month = ''
  let day = ''
  try {
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(new Date(ms))) {
      if (p.type === 'month') month = p.value
      if (p.type === 'day') day = p.value
    }
  } catch { /* an unknown zone: the words without a date */ }
  return month && day ? `${month}月${day}日の会議のたたき台を確かめる` : '会議のたたき台を確かめる'
}

/**
 * A set watch's occurrence the member may see as its responsible person (4b-4 PR3): the occurrence (a shape this build knows),
 * of `jobId` when given, pinned to a version naming them, of a set watch, and shown to them now (I8: they read the record and
 * the meeting and are one of its people — `setOccurrenceShown`). Else null: the notice, the judgement and the correction
 * route are not there for them, whoever they are (an owner / admin who did not attend included).
 */
export function ownSetOccurrence(handle: CompanyData, member: Member, occurrenceId: string, jobId: string | null = null):
  { occ: NonNullable<ReturnType<CompanyData['jobs']['occurrence']>>; definition: JobDefinition } | null {
  const occ = handle.jobs.occurrence(occurrenceId)
  if (!occ || (jobId !== null && occ.jobId !== jobId)) return null
  const version = handle.jobs.version(occ.jobId, occ.jobVersion)
  if (!version || version.actingUserId !== member.userId) return null
  const definition = storedJobDefinition(version)
  if (!isSetWatchOccurrence(occ, definition) || !setOccurrenceShown(handle, member, occ.eventRecordId as string, occ.eventMeetingId as string)) return null
  return { occ, definition: definition as JobDefinition }
}

/**
 * 「〈会議名〉では、たたき台を作りませんでした（理由）」 (`job_set_declined`)'s words for the member **now** (§5-1, T15): the meeting's
 * title and the reason's label (the pinned definition's), only while the occurrence is theirs to see (`ownSetOccurrence`) and
 * its judgement is 見送る. Else null — the notice is not shown at all (no row in the list, no unread count).
 */
export function setDeclinedNotice(handle: CompanyData, member: Member, jobId: string, occurrenceId: string): { meeting: string; reason: string } | null {
  const own = ownSetOccurrence(handle, member, occurrenceId, jobId)
  const report = own ? handle.jobs.setReport(occurrenceId) : null
  if (!own || report?.decision !== 'decline') return null
  const meeting = handle.records.byIds([own.occ.eventMeetingId as string])[0]
  const label = own.definition.decision?.reasons.find(r => r.code === report.reason)?.label ?? 'その他'
  return meeting ? { meeting: meeting.title, reason: label } : null
}
