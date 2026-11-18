/**
 * Scheduled jobs (定期の仕事, B 「実行を記録から分ける」 PR 3a, `.claude/rules/jobs.md`): definitions and
 * approval (PR 3a). The occurrences and the server's operation are services/job-occurrences.ts (PR 3b); a PC job's claim and the grant at every call are services/job-runs.ts (PR 5a).
 *
 * Who (owner decisions 2026-11-10, D3 / D4 / D5 / D8 / D10):
 * - owner / admin create, edit (a new version: the approved one stays as it was), approve, pause,
 *   resume and stop all jobs of the company (「定期の仕事をすべて止める」).
 * - The responsible person (責任者, `actingUser`: whom it runs as) sees only their own jobs, accepts a
 *   version in their own name, and may pause their own job and resume a pause they made. No delegate
 *   acts for them (D5). Anyone else: a job they are not responsible for does not exist (404).
 * - A version needs acceptance again only when its consent (who, what runs, where, the grant:
 *   `jobConsentCanonical`) differs from the one accepted.
 * - At approval (and acceptance, and an owner/admin's resume) the server checks again that the
 *   responsible person is a member now and may read every place the version names, and that a pinned
 *   Skill is still the company's as pinned (design memo §4-3). Refusals are codes and fixed sentences:
 *   never a place, a Skill's content or a name.
 * - The responsible person leaving the company, or losing what the approved version needs on a role
 *   change, pauses the job (`OWNER_LEFT` / `OWNER_RIGHTS_CHANGED`) and tells every owner / admin
 *   (notice `job_paused`), in the same transaction as the change.
 */
import {
  JOB_ACTOR, JOB_NEEDS_NEWER_SCREEN, JOB_SCHEMAS, JOB_SYSTEM_PAUSE_REASONS, isJobId, isRecordTrigger, isTimeTrigger, storedJobDefinition, jobConsentCanonical, jobDefinitionCanonical, jobDefinitionPaths, jobDeliveryLabel, newJobId, parseJobAcceptedPlace,
  parseJobDefinition, type JobDefinition, type JobDeliveryPlace, type JobPauseReason,
} from '../../shared/core/jobs'
import type { JobList, JobOccurrenceView, JobState, JobVersionView, JobView, JobWaiting } from '../../shared/types/jobs'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow, JobVersionRow } from '../ports/jobs'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { hashCanonical } from '../lib/content-hash'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader, type RecordReader } from './record-access'
import { resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
import { nextJobSlot } from '../../shared/core/job-schedule'
import { jobChainStopText } from '../../shared/core/job-words'
import { RECORD_ID_RE } from '../../shared/core/records'
import { companyNow } from './notifications'
import { eventShown, recordTriggerProblems, shownSlot, type AiStepStates } from './job-events'

export const JOBS_FORBIDDEN = 'Only owners and admins can manage scheduled jobs'
/** A job's name for a responsible person who cannot read every place its newest version names. */
export const HIDDEN_JOB_NAME = '定期の仕事'
/** How many occurrences `GET /jobs/:jobId/occurrences` answers (newest first). */
export const OCCURRENCES_LISTED = 100
const NOT_FOUND = () => refuse('not-found', '定期の仕事が見つかりません。', { code: 'JOB_NOT_FOUND' })
const BAD_DEFINITION = (problems: string[]) => refuse('bad-request', '定期の仕事の内容に正しくないところがあります。', { code: 'BAD_JOB_DEFINITION', problems })
const BAD_BODY = (what: string) => refuse('bad-request', `Body must be ${what}`, { code: 'BAD_REQUEST' })
const VERSION_NOT_FOUND = () => refuse('not-found', 'その版はありません。', { code: 'JOB_VERSION_NOT_FOUND' })
const FINGERPRINT_CHANGED = () => refuse('conflict', '画面に出ていた内容と違います。読み直してから、もう一度ためしてください。', { code: 'JOB_VERSION_FINGERPRINT' })
const OWNER_NOT_MEMBER = () => refuse('conflict', '責任者がこの会社のメンバーではありません。責任者を決め直してください。', { code: 'JOB_OWNER_NOT_MEMBER' })
const GRANT_EXCEEDS = () => refuse('conflict', '責任者の今の権限では、この仕事の範囲に足りません。範囲か責任者を見直してください。', { code: 'JOB_GRANT_EXCEEDS' })
const SKILL_MISSING = () => refuse('conflict', '会社のスキルが見つかりません。.claude/skills/ に置いて同期してから、もう一度ためしてください。', { code: 'JOB_SKILL_MISSING' })
const SKILL_NOT_HERE = () => refuse('conflict', 'この会社は全社フォルダを使っていないため、手順には「会社の Skill」に公開された Skill を選んでください。', { code: 'JOB_SKILL_NOT_HERE' })
const SHELF_NOT_HERE = () => refuse('conflict', 'この会社は全社フォルダを使っているため、手順には全社フォルダの .claude/skills/ にある Skill を選んでください。', { code: 'JOB_SKILL_NOT_HERE' })
const SHELF_SKILL_MISSING = () => refuse('conflict', '手順の Skill が「会社の Skill」に見つかりません。公開されているか確かめてから、もう一度ためしてください。', { code: 'JOB_SKILL_MISSING' })
const SKILL_CHANGED = () => refuse('conflict', '手順のスキルが、この版を作ったあとに変わりました。新しい版を作ってから承認してください。', { code: 'JOB_SKILL_CHANGED' })
const NOT_RESPONSIBLE = () => refuse('forbidden', 'この定期の仕事を止められるのは、承認された版の責任者か管理者だけです。', { code: 'JOB_NOT_RESPONSIBLE' })
const RETIRED = () => refuse('conflict', 'この定期の仕事はもう使われていません。', { code: 'JOB_RETIRED' })
const PLACE_NEEDED = () => refuse('conflict', 'この定期の仕事は、できたものを置く先を責任者が受け取るときに選びます。アプリを新しくしてから、「設定」→「仕事」→「定期の仕事」の「置き先を選んで受け取る」で選んでください。', { code: 'JOB_PLACE_NEEDED' })
const PLACE_NOT_USABLE = () => refuse('conflict', '選んだ置き先を使えません（選んでから時間がたったか、消されました）。もう一度選んでください。', { code: 'JOB_PLACE_NOT_USABLE' })
/** A version of a shape this server build does not know (a newer build wrote it): never approved, accepted or resumed here. */
const SCHEMA_UNKNOWN = () => refuse('conflict', 'この定期の仕事は新しい版のサーバーで作られたため、このサーバーでは扱えません。', { code: 'JOB_SCHEMA_UNKNOWN' })
/** A version of a shape the calling screen did not say it can read (`JOB_SCHEMAS_HEADER`): never approved, accepted or edited from it. */
const NEEDS_NEWER_SCREEN = () => refuse('conflict', `${JOB_NEEDS_NEWER_SCREEN}。`, { code: 'JOB_NEEDS_NEWER_SCREEN' })
/** An event trigger without its narrowing (owner decision 2026-11-18): refused in plain words. */
const NEEDS_NARROWING = () => refuse('bad-request', '出来事で動く定期の仕事には、見張るやること（1件）を選んでください。すべてのやることを見張ることはできません。', { code: 'BAD_JOB_DEFINITION', problems: ['trigger.startRecord.REQUIRED'] })
/** A record trigger the company's types, its business plugins or the start record do not allow (stage 4a); codes only, never a name. */
const TRIGGER_NOT_ALLOWED = (problems: string[]) => refuse('conflict', 'きっかけにした出来事は、いまの会社の設定では使えません（「AI の番」の状態か、最初のやることが見つからないなど）。選び直してください。', { code: 'JOB_TRIGGER_NOT_ALLOWED', problems })
const NOT_RESPONSIBLE_TO_REWATCH = () => refuse('forbidden', '見張るやることを選び直せるのは、この仕事の責任者だけです。', { code: 'JOB_NOT_RESPONSIBLE' })
const DRAFT_WAITING = () => refuse('conflict', '管理者が内容を直している途中のため、いまは選び直せません。管理者に確かめてください。', { code: 'JOB_DRAFT_WAITING' })
const NOT_EVENT_JOB = () => refuse('conflict', 'この定期の仕事は、出来事で動く仕事ではありません。', { code: 'JOB_NOT_EVENT' })
/** What a client reads when it names no schemas (every screen before stage 4-0). */
const SCHEMA_1_ONLY: readonly number[] = [1]

export interface JobServiceDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  /** The git tree id of a company Skill now (`.claude/skills/<name>`), or null (none, or no shared folder). */
  skillTree: (companyId: string, name: string) => Promise<string | null>
  /** Has the company the shared company folder? Without it a Skill is pinned from the Skill shelf (`shelfSkill`). */
  hasCompanyFolder: (companyId: string) => boolean
  /**
   * A Skill of the Skill shelf as `who` reads it (services/skill-shelf.ts `jobSkill`): null when there is no
   * such Skill (or the company has the shared folder); `readable` false when it is at a place `who` does not
   * read. Absent → no shelf (every shelf Skill is missing).
   */
  shelfSkill?: (who: Member, itemId: string, version?: string) => { name: string; current: string | null; kept: boolean; readable: boolean } | null
  /** Tell these members their notices changed (the push signal, kind + version only). Absent → nothing. */
  noticesChanged?: (companyId: string, userIds: string[]) => void
  /**
   * The occurrences' side of a pause or the company's stop (services/job-occurrences.ts, jobs.md "Held"), in
   * the change's transaction: when it begins, `due` ones are held; when it ends, a slot that passed meanwhile
   * is written held. `jobId` null: every job of the company. Absent → nothing (3a's tests).
   */
  occurrenceHolds?: {
    holdDue(companyId: string, jobId: string | null, code: 'JOB_PAUSED' | 'COMPANY_STOPPED'): void
    holdPassedSlot(companyId: string, jobId: string | null, code: 'JOB_PAUSED' | 'COMPANY_STOPPED'): void
  }
  /** The company's zone and days off, for a view's `nextSlot` (the clock's own: job-occurrences.ts). Absent → no `nextSlot`. */
  timeZoneOf?: (companyId: string) => string
  holidaysOf?: (companyId: string) => string[]
  /**
   * A deliverable place outside (jobs.md "A deliverable place outside"): the member's own live place of that
   * connector and kind with this `ref` — a Drive folder they picked, while the pick lasts — with its name and
   * when the pick ends; null when it is not one (never picked by them, expired, another member's). The
   * connector answers (composition): the core never names one. Absent → no place is ever usable.
   */
  places?: { live(companyId: string, userId: string, place: JobDeliveryPlace): { name: string; expiresAt: string } | null }
  /**
   * 「もう一度」 (B PR 5b, services/job-retry.ts `viewOf`): what an owner / admin's occurrence view adds — how often it was
   * sent back, by whom, whether the button works now and why not. Bound late (built after this service). Absent → nothing.
   */
  occurrenceRetry?: (companyId: string, occ: JobOccurrenceRow) => Partial<JobOccurrenceView>
  /** The definition schemas this server reads (jobs.md "Shapes this build does not know"). Absent → `JOB_SCHEMAS`; tests name a newer one. */
  knownSchemas?: readonly number[]
  /** Event-triggered jobs (stage 4a): a business plugin step's states that run as 「AI の番」 (never a trigger's, ⑧). Absent → none. */
  aiStepStates?: AiStepStates
}

/**
 * An occurrence as `GET /jobs/:jobId/occurrences` answers it to anyone who sees the job: slots, states and codes only.
 * An event occurrence (stage 4a) says `kind: 'event'` and its event's time as the slot — never its delivery number, its
 * record or anything of it (and it reaches only someone who reads that record: `eventShown`).
 */
export function occurrenceView(o: JobOccurrenceRow): JobOccurrenceView {
  return {
    id: o.id, jobVersion: o.jobVersion, dueSlot: shownSlot(o), timeZone: o.timeZone, dueAt: o.dueAt, expiresAt: o.expiresAt,
    state: o.state, outcomeCode: o.outcomeCode, ran: o.runId !== null, updatedAt: o.updatedAt,
    ...(o.eventSeq !== null && o.eventSeq !== undefined ? { kind: 'event' as const } : {}),
  }
}

/**
 * How many of a job's event records (newest first) a look checks the viewer reads (stage 4a). Event occurrences of older
 * records are left out (fails closed). The work is the same whatever the viewer may read: never a measure of what is hidden.
 */
export const EVENT_RECORDS_CHECKED = 2000

const sha256 = hashCanonical
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function createJobService(deps: JobServiceDeps) {
  const { companyData, memberships, transactions, clock, ids } = deps
  const jobsOf = (companyId: string) => companyData.forCompany(companyId).jobs

  const known = deps.knownSchemas ?? JOB_SCHEMAS
  /** The stored definition, or null when this server does not know its shape (never read as if it did). */
  const definitionOf = (v: JobVersionRow): JobDefinition | null => storedJobDefinition(v, known)
  /** The definition as a client that reads `reads` may get it: null when either this server or that client does not know its shape. */
  const shownTo = (v: JobVersionRow, reads: readonly number[]): JobDefinition | null => (reads.includes(v.schema) ? definitionOf(v) : null)

  /**
   * May `userId` (role `role`) read every place the definition names, now? A Skill pinned from the shelf
   * names its place too (B PR 5a): one at a place they do not read counts as a place they cannot read (a
   * Skill gone from the shelf is the Skill check's, `skillPinned`).
   */
  function readsAll(handle: CompanyData, userId: string, role: string, definition: JobDefinition | null): boolean {
    // A shape this server does not know names places it cannot list: never "reads all" (fails closed).
    if (definition === null) return false
    const reader = recordReader({ companyId: handle.companyId, userId, role }, handle.scopes.listWithRules())
    if (!jobDefinitionPaths(definition).every(p => reader.file(p))) return false
    const procedure = definition.run.kind === 'procedure' ? definition.run.procedure : null
    if (procedure?.source !== 'shelf_skill') return true
    return deps.shelfSkill?.({ companyId: handle.companyId, userId, role }, procedure.item)?.readable !== false
  }

  /**
   * Stage 4a: may `member` see a version naming a start record (`trigger.startRecord`)? Only while they read it now —
   * owners and admins too: a record id they cannot read is not theirs to learn (⑥). Any other version: yes.
   */
  function readsStart(handle: CompanyData, member: Member, definition: JobDefinition | null): boolean {
    const start = definition && isRecordTrigger(definition.trigger) ? definition.trigger.startRecord : undefined
    return start === undefined || eventShown(handle, member, { eventRecordId: start })
  }

  /** The company's own checks of a record trigger (job-events.ts): who must read its start record — `who` and the responsible person. */
  function triggerProblems(handle: CompanyData, definition: JobDefinition, who: Member | null): string[] {
    if (!isRecordTrigger(definition.trigger)) return []
    const role = memberships.roleOf(handle.companyId, definition.actingUser)
    const readers: Member[] = [...(who ? [who] : []), ...(role !== null ? [{ companyId: handle.companyId, userId: definition.actingUser, role }] : [])]
    return recordTriggerProblems(handle, deps.aiStepStates, definition.trigger, readers)
  }

  /**
   * An event job's stopped chain as the viewer may read it (owner decision ①): its cause in plain words — a record-side
   * cause in full, with the record's title, only when the viewer reads that record now (else 「見張っていたやることの都合で
   * 止まりました」), computed when read; null while it goes on. Nothing for a job that is not an event job.
   */
  function chainOf(member: Member, handle: CompanyData, job: JobRow, reader: RecordReader): Pick<JobView, 'chainStopped'> {
    const stop = handle.jobs.eventCursor(job.id)?.chainStop ?? null
    const approved = job.approvedVersion === null ? null : handle.jobs.version(job.id, job.approvedVersion)
    const definition = approved ? definitionOf(approved) : null
    if (!definition || !isRecordTrigger(definition.trigger)) return {}
    if (!stop) return { chainStopped: null }
    const row = handle.records.byIds([stop.record])[0]
    const title = row && row.removedAt === null && reader.record(row) ? row.title : null
    return { chainStopped: { why: jobChainStopText(stop.code, { runsPerDay: definition.grant.limits.runsPerDay, record: title }) } }
  }

  /** The member's record reader for one request (the company's rules read once). */
  const readerOf = (member: Member, handle: CompanyData): RecordReader => recordReader(member, handle.scopes.listWithRules())

  /**
   * The viewer's newest occurrences of the job, newest first, at most `limit`: an event one they may not see is not
   * there (⑥). The job's event records (at most `EVENT_RECORDS_CHECKED`, newest first) are read in one batch and checked
   * with one reader, then SQL leaves the others out **before** the limit: what someone else's record made never pushes a
   * visible one out (or in), and the work does not depend on how many are hidden.
   */
  function shownOccurrences(member: Member, handle: CompanyData, jobId: string, limit: number, reader: RecordReader = readerOf(member, handle)): JobOccurrenceRow[] {
    const records = handle.jobs.eventRecordsOf(jobId, EVENT_RECORDS_CHECKED)
    const readable = records.length === 0 ? [] : handle.records.byIds(records).filter(r => r.removedAt === null && reader.record(r)).map(r => r.id)
    return handle.jobs.occurrencesOf(jobId, readable, limit)
  }

  /**
   * Does what the version names fit the person's rights now (design memo §4-3)? They read every place
   * it names, and may write where its deliverables go (`writes.place`).
   */
  function fitsRights(handle: CompanyData, userId: string, role: string, definition: JobDefinition | null): boolean {
    if (definition === null || !readsAll(handle, userId, role, definition)) return false
    if (definition.grant.writes.area !== 'deliverable') return true
    const scopes = handle.scopes.listWithRules()
    const perms: PermissionRepository = { getMemberRole: () => role, listScopes: () => scopes }
    return resolveAccess(handle.companyId, userId, definition.grant.writes.place, perms).write
  }

  /** The responsible person is a member and the version fits their rights now (design memo §4-3). */
  function withinRights(handle: CompanyData, definition: JobDefinition | null): Outcome<void> {
    if (definition === null) return SCHEMA_UNKNOWN()
    const role = memberships.roleOf(handle.companyId, definition.actingUser)
    if (role === null) return OWNER_NOT_MEMBER()
    if (!fitsRights(handle, definition.actingUser, role, definition)) return GRANT_EXCEEDS()
    return ok(undefined)
  }

  async function skillPinned(companyId: string, definition: JobDefinition): Promise<Outcome<void>> {
    if (definition.run.kind !== 'procedure') return ok(undefined)
    const procedure = definition.run.procedure
    if (procedure.source === 'shelf_skill') {
      if (deps.hasCompanyFolder(companyId)) return SHELF_NOT_HERE()
      // As the responsible person reads it: a Skill at a place they do not read is not there for them.
      const role = memberships.roleOf(companyId, definition.actingUser)
      const found = role === null ? null : deps.shelfSkill?.({ companyId, userId: definition.actingUser, role }, procedure.item)
      if (!found || !found.readable || found.current === null) return SHELF_SKILL_MISSING()
      return found.current === procedure.fingerprint ? ok(undefined) : SKILL_CHANGED()
    }
    if (!deps.hasCompanyFolder(companyId)) return SKILL_NOT_HERE()
    const tree = await deps.skillTree(companyId, procedure.skill)
    if (tree === null) return SKILL_MISSING()
    return tree === procedure.fingerprint ? ok(undefined) : SKILL_CHANGED()
  }

  /** The responsible person: of the approved version once there is one, else of the newest. */
  function responsibleOf(handle: CompanyData, job: JobRow): string {
    if (job.approvedVersion === null) return job.actingUserId
    return handle.jobs.version(job.id, job.approvedVersion)?.actingUserId ?? job.actingUserId
  }
  /** Is the member named by the job (its newest or approved version)? They see it (a draft naming them is theirs to read). */
  function isResponsible(handle: CompanyData, job: JobRow, userId: string): boolean {
    return job.actingUserId === userId || responsibleOf(handle, job) === userId
  }
  /** Does the member control the job (pause / resume)? Only the approved version's responsible person — never someone a draft names. */
  function controls(handle: CompanyData, job: JobRow, userId: string): boolean {
    return responsibleOf(handle, job) === userId
  }

  /** The job as the member may see it; null = it does not exist for them. */
  function visibleJob(member: Member, jobId: unknown): { handle: CompanyData; job: JobRow } | null {
    if (!isJobId(jobId)) return null
    const handle = companyData.forCompany(member.companyId)
    const job = handle.jobs.find(jobId)
    if (!job) return null
    if (!hasFullAccess(member.role) && !isResponsible(handle, job, member.userId)) return null
    return { handle, job }
  }

  function consentAccepted(handle: CompanyData, job: JobRow): boolean {
    if (job.approvedVersion === null || job.acceptedConsent === null) return false
    const approved = handle.jobs.version(job.id, job.approvedVersion)
    return approved !== null && approved.consentFingerprint === job.acceptedConsent
  }

  function waitingOf(handle: CompanyData, job: JobRow, stopped: boolean): JobWaiting {
    if (job.state === 'paused' || job.state === 'retired') return 'PAUSED'
    if (stopped) return 'COMPANY_STOPPED'
    if (job.approvedVersion === null) return 'NOT_APPROVED'
    if (!consentAccepted(handle, job)) return 'NOT_ACCEPTED'
    return null
  }

  /**
   * When it runs, for the screens (PR 4): the approved version's trigger (else the newest's) — a trigger
   * names no place, so it is answered with the job —, the approved trigger's next slot, the newest occurrence.
   */
  function whenOf(member: Member, handle: CompanyData, job: JobRow, reads: readonly number[], reader: RecordReader): Pick<JobView, 'trigger' | 'placement' | 'nextSlot' | 'lastOccurrence' | 'needsUpdate'> {
    const approved = job.approvedVersion === null ? null : handle.jobs.version(job.id, job.approvedVersion)
    const shown = approved ?? handle.jobs.version(job.id, job.latestVersion)
    // A shape the client (or this server) does not read: no trigger at all — an older screen would read it as a
    // time of day (`trigger.at`) and fail — and `needsUpdate` for the screens that know the word.
    const definition = shown ? shownTo(shown, reads) : null
    let nextSlot: string | null = null
    // An event job has no next slot (stage 4a): its occurrences come when something happens.
    if (approved && definition && isTimeTrigger(definition.trigger) && job.state !== 'retired' && deps.timeZoneOf && deps.holidaysOf) {
      nextSlot = nextJobSlot(definition.trigger, companyNow(clock.nowMs(), deps.timeZoneOf(handle.companyId)), deps.holidaysOf(handle.companyId))
    }
    // The newest the viewer may see (⑥): what someone else's record made is not there for them.
    const last = shownOccurrences(member, handle, job.id, 1, reader)[0] ?? null
    // A start record the viewer cannot read is not named to them (⑥): no trigger at all then, as for a hidden definition.
    const triggerShown = definition !== null && readsStart(handle, member, definition)
    return {
      ...(definition && triggerShown ? { trigger: definition.trigger, placement: definition.placement } : {}),
      ...(shown && !definition ? { needsUpdate: true as const } : {}),
      nextSlot,
      lastOccurrence: last ? { dueSlot: shownSlot(last), state: last.state, outcomeCode: last.outcomeCode, ...(last.eventSeq != null ? { kind: 'event' as const } : {}) } : null,
    }
  }

  /**
   * What the screens need to know without reading a definition (PR 4; ids, booleans and a name only — never a
   * place): the approved version's responsible person and its name (`HIDDEN_JOB_NAME` over that version's own
   * places), whether the newest version's consent is the accepted one (approving it would run without a new
   * acceptance), and the caller's own relation by the API's own rules.
   */
  function forViewer(member: Member, handle: CompanyData, job: JobRow): Pick<JobView, 'approved' | 'latestConsentAccepted' | 'you'> {
    const approved = job.approvedVersion === null ? null : handle.jobs.version(job.id, job.approvedVersion)
    const latest = handle.jobs.version(job.id, job.latestVersion)
    let approvedView: JobView['approved'] = null
    if (approved) {
      const definition = definitionOf(approved)
      // Never more than the job's own name shows (the newest version's places, `nameFor`): the places of both versions.
      const nameShown = hasFullAccess(member.role)
        || (readsAll(handle, member.userId, member.role, definition) && latest !== null && readsAll(handle, member.userId, member.role, definitionOf(latest)))
      // A shape this server does not know: its name is the job's (owners / admins), else the neutral one.
      approvedView = { responsibleUserId: approved.actingUserId, name: !nameShown ? HIDDEN_JOB_NAME : definition ? definition.name : job.name }
    }
    const accepted = consentAccepted(handle, job)
    return {
      approved: approvedView,
      latestConsentAccepted: latest !== null && job.acceptedConsent !== null && latest.consentFingerprint === job.acceptedConsent,
      you: {
        named: isResponsible(handle, job, member.userId),
        controls: approved !== null && controls(handle, job, member.userId),
        mustAccept: approved !== null && approved.actingUserId === member.userId && !accepted && job.state !== 'retired',
      },
    }
  }

  /** The job's name for the member: the newest version's, or 「定期の仕事」 for a non-admin who cannot read every place it names. */
  function nameFor(member: Member, handle: CompanyData, job: JobRow): string {
    if (hasFullAccess(member.role)) return job.name
    const latest = handle.jobs.version(job.id, job.latestVersion)
    return latest !== null && readsAll(handle, member.userId, member.role, definitionOf(latest)) ? job.name : HIDDEN_JOB_NAME
  }

  function view(member: Member, handle: CompanyData, job: JobRow, withVersions: boolean, reads: readonly number[] = SCHEMA_1_ONLY, reader: RecordReader = readerOf(member, handle)): JobView {
    const full = hasFullAccess(member.role)
    // The name shown is the newest version's (`ai_jobs.name`). A responsible person who is not owner/admin
    // gets it only while they read every place that version names — an admin may have named the job after
    // a place (「経理部の月次報告」) they cannot read; otherwise the neutral 「定期の仕事」.
    const out: JobView = {
      id: job.id, name: nameFor(member, handle, job), state: job.state, actingUserId: job.actingUserId, latestVersion: job.latestVersion,
      approvedVersion: job.approvedVersion, accepted: consentAccepted(handle, job), pausedReason: job.pausedReason,
      waiting: waitingOf(handle, job, handle.jobs.stopped()), createdBy: job.createdBy, createdAt: job.createdAt, updatedAt: job.updatedAt,
      ...whenOf(member, handle, job, reads, reader),
      ...forViewer(member, handle, job),
      deliverTo: placeView(member, handle, job),
      ...chainOf(member, handle, job, reader),
    }
    if (withVersions) {
      out.versions = handle.jobs.versions(job.id).map((v): JobVersionView => {
        const definition = definitionOf(v)
        // A responsible person who is not owner/admin sees a version's definition only while they read
        // every place it names (a draft may name one they cannot: its name is not theirs to learn).
        // A start record the viewer cannot read (stage 4a): the version is hidden from them, owners and admins too (⑥).
        const shown = (full || readsAll(handle, member.userId, member.role, definition)) && readsStart(handle, member, definition)
        // A shape the client does not read (or this server does not know) goes without its definition: an older
        // screen would fail on it (jobs.md "Shapes this build does not know").
        const readable = shownTo(v, reads) !== null
        return {
          // Hidden: the fingerprints too (a sha256 of a known shape lets someone test guesses of a place's name).
          version: v.version, fingerprint: shown ? v.fingerprint : null, consentFingerprint: shown ? v.consentFingerprint : null,
          definition: shown && readable ? definition : null,
          ...(readable ? {} : { needsUpdate: true as const }),
          createdBy: v.createdBy, createdAt: v.createdAt, approvedBy: v.approvedBy, approvedAt: v.approvedAt, acceptedBy: v.acceptedBy, acceptedAt: v.acceptedAt,
        }
      })
    }
    return out
  }

  /**
   * The body's definition, checked and pinned: a procedure's Skill fingerprint is the server's (read
   * now), never the caller's; the responsible person must be a member now.
   */
  async function definitionFrom(companyId: string, body: unknown): Promise<Outcome<{ definition: JobDefinition; canonical: string }>> {
    if (!isObject(body) || Object.keys(body).length !== 1 || !isObject(body.definition)) return BAD_BODY('{ definition }')
    const input: Record<string, unknown> = { ...body.definition }
    let tree: string | null | undefined
    let missing = SKILL_MISSING
    if (isObject(input.run) && input.run.kind === 'procedure' && isObject(input.run.procedure)) {
      const procedure = input.run.procedure
      if (procedure.source === 'shelf_skill') {
        // A company without the shared folder (B PR 5a): the shelf Skill `item`, at its current version, as
        // the responsible person reads it — the server fills its name and version, never the caller.
        if (deps.hasCompanyFolder(companyId)) return SHELF_NOT_HERE()
        missing = SHELF_SKILL_MISSING
        const acting = typeof input.actingUser === 'string' ? input.actingUser : ''
        const role = acting ? memberships.roleOf(companyId, acting) : null
        const found = role !== null && typeof procedure.item === 'string' ? deps.shelfSkill?.({ companyId, userId: acting, role }, procedure.item) : null
        tree = found && found.readable ? found.current : null
        input.run = { ...input.run, procedure: { ...procedure, skill: found && found.readable ? found.name : procedure.skill, fingerprint: tree ?? '' } }
      } else {
        if (!deps.hasCompanyFolder(companyId)) return SKILL_NOT_HERE()
        const skill = procedure.skill
        tree = typeof skill === 'string' ? await deps.skillTree(companyId, skill) : null
        input.run = { ...input.run, procedure: { ...procedure, fingerprint: tree ?? '' } }
      }
    }
    const parsed = parseJobDefinition(input)
    if (!parsed.ok && parsed.problems.includes('trigger.startRecord.REQUIRED')) return NEEDS_NARROWING()
    if (!parsed.ok) {
      // Everything else was right and only the Skill is not the company's: say that, not "bad definition".
      if (tree === null && parsed.problems.every(p => p === 'run.procedure.fingerprint.BAD' || p === 'run.procedure.skill.BAD') && parsed.problems.includes('run.procedure.fingerprint.BAD')) return missing()
      return BAD_DEFINITION(parsed.problems)
    }
    if (memberships.roleOf(companyId, parsed.definition.actingUser) === null) return BAD_DEFINITION(['actingUser.NOT_MEMBER'])
    return ok({ definition: parsed.definition, canonical: jobDefinitionCanonical(parsed.definition) })
  }

  function versionRow(jobId: string, version: number, definition: JobDefinition, canonical: string, by: string, at: string): JobVersionRow {
    return {
      jobId, version, schema: definition.schema, definition: canonical, fingerprint: sha256(canonical),
      consentFingerprint: sha256(jobConsentCanonical(definition)), actingUserId: definition.actingUser, createdBy: by, createdAt: at,
      approvedBy: null, approvedAt: null, acceptedBy: null, acceptedAt: null,
    }
  }

  /** `{ version, fingerprint? }` (and, for an acceptance, `place?`: the deliverable place chosen, checked by `accept`). */
  function versionBody(body: unknown, withPlace = false): { version: number; fingerprint: string | null; place: unknown } | null {
    if (!isObject(body)) return null
    const keys = Object.keys(body)
    if (!keys.every(k => k === 'version' || k === 'fingerprint' || (withPlace && k === 'place'))) return null
    if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) return null
    if (body.fingerprint !== undefined && typeof body.fingerprint !== 'string') return null
    return { version: body.version, fingerprint: (body.fingerprint as string | undefined) ?? null, place: body.place }
  }

  /**
   * The deliverable place outside, as a view shows it (jobs.md "A deliverable place outside"): its kind's words,
   * whether the responsible person chose one and whether it is usable now; its name and when the pick ends only
   * to that person (a Drive folder's name is theirs: never anyone else's to read, owners and admins included).
   */
  function placeView(member: Member, handle: CompanyData, job: JobRow): JobView['deliverTo'] {
    const shownVersion = job.approvedVersion === null ? handle.jobs.version(job.id, job.latestVersion) : handle.jobs.version(job.id, job.approvedVersion)
    const wanted = shownVersion ? definitionOf(shownVersion)?.grant.deliverTo : undefined
    if (!wanted) return null
    const chosen = job.acceptedPlace && job.acceptedPlace.connector === wanted.connector && job.acceptedPlace.kind === wanted.kind ? job.acceptedPlace : null
    const responsible = responsibleOf(handle, job)
    const live = chosen ? deps.places?.live(handle.companyId, responsible, chosen) ?? null : null
    const theirs = member.userId === responsible
    return {
      connector: wanted.connector, kind: wanted.kind, label: jobDeliveryLabel(wanted) ?? wanted.kind, chosen: chosen !== null, usable: chosen !== null && live !== null,
      name: theirs && live ? live.name : null, expiresAt: theirs && live ? live.expiresAt : null,
    }
  }

  /** Pause each job the member is responsible for, for `reason`, and tell every owner / admin (in the caller's transaction). */
  function pauseFor(companyId: string, jobs: JobRow[], reason: JobPauseReason, actorId: string) {
    if (jobs.length === 0) return
    const handle = companyData.forCompany(companyId)
    const at = clock.now()
    const admins = memberships.listByCompany(companyId).filter(m => hasFullAccess(m.role)).map(m => m.user_id)
    let told = false
    for (const job of jobs) {
      if (job.state === 'retired' || job.pausedReason === reason) continue
      handle.jobs.setState(job.id, 'paused', reason, actorId, at)
      deps.occurrenceHolds?.holdDue(companyId, job.id, 'JOB_PAUSED')
      handle.notifications.insert(admins.map(userId => ({
        id: ids.newId(), userId, kind: 'job_paused', recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
        dedupeKey: `job_paused:${job.id}:${reason}:${at}`, createdAt: at, readAt: null,
      })))
      told = true
    }
    // The apps re-read at once (a bare signal; never fails the change).
    if (told) { try { deps.noticesChanged?.(companyId, admins) } catch { /* their own check catches up */ } }
  }

  return {
    /** `GET /jobs`: owner/admin every job; anyone else the jobs they are responsible for. */
    list(member: Member, reads: readonly number[] = SCHEMA_1_ONLY): Outcome<JobList> {
      const handle = companyData.forCompany(member.companyId)
      const full = hasFullAccess(member.role)
      const rows = full ? handle.jobs.list() : handle.jobs.listFor(member.userId)
      // One reader for the whole answer (the company's rules read once).
      const reader = readerOf(member, handle)
      return ok({ stopped: handle.jobs.stopped(), canManage: full, jobs: rows.map(j => view(member, handle, j, false, reads, reader)) })
    },

    /** `GET /jobs/:jobId`: with every version, newest first. */
    get(member: Member, jobId: string, reads: readonly number[] = SCHEMA_1_ONLY): Outcome<JobView> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      return ok(view(member, found.handle, found.job, true, reads))
    },

    /** `POST /jobs { definition }` (owner/admin): a draft with its first version. */
    async create(member: Member, body: unknown, reads: readonly number[] = SCHEMA_1_ONLY): Promise<Outcome<JobView>> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      const parsed = await definitionFrom(member.companyId, body)
      if (!parsed.ok) return parsed
      const { definition, canonical } = parsed.value
      const handle = companyData.forCompany(member.companyId)
      // A shape the screen did not say it reads is never made from it (stage 4a: schema 2 from a 4a client only).
      if (!reads.includes(definition.schema)) return NEEDS_NEWER_SCREEN()
      const problems = triggerProblems(handle, definition, member)
      if (problems.length > 0) return BAD_DEFINITION(problems)
      const at = clock.now()
      const id = newJobId(ids.newId().replace(/-/g, '').toLowerCase())
      handle.jobs.create({
        id, name: definition.name, state: 'draft', actingUserId: definition.actingUser, latestVersion: 1, approvedVersion: null,
        approvedFingerprint: null, acceptedVersion: null, acceptedConsent: null, acceptedPlace: null, pausedReason: null, pausedBy: null, pausedAt: null,
        createdBy: member.userId, createdAt: at, updatedAt: at,
      }, versionRow(id, 1, definition, canonical, member.userId, at))
      return ok(view(member, handle, handle.jobs.find(id) as JobRow, true, reads))
    },

    /** `PUT /jobs/:jobId { definition }` (owner/admin): a new version; the approved one keeps running as it was. */
    async update(member: Member, jobId: string, body: unknown, reads: readonly number[] = SCHEMA_1_ONLY): Promise<Outcome<JobView & { changed: boolean }>> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      if (found.job.state === 'retired') return RETIRED()
      // A screen that cannot show the newest version never writes over it (it was shown an empty form).
      const newest = found.handle.jobs.version(jobId, found.job.latestVersion)
      // Nor does a server that cannot read it (rolled back after a newer build wrote it), whatever the screen says it reads.
      if (newest && definitionOf(newest) === null) return SCHEMA_UNKNOWN()
      if (newest && !reads.includes(newest.schema)) return NEEDS_NEWER_SCREEN()
      const parsed = await definitionFrom(member.companyId, body)
      if (!parsed.ok) return parsed
      const { definition, canonical } = parsed.value
      const { handle } = found
      if (!reads.includes(definition.schema)) return NEEDS_NEWER_SCREEN()
      const problems = triggerProblems(handle, definition, member)
      if (problems.length > 0) return BAD_DEFINITION(problems)
      const changed = transactions.run(() => {
        const job = handle.jobs.find(jobId) as JobRow
        const latest = handle.jobs.version(jobId, job.latestVersion)
        if (latest && latest.definition === canonical) return false
        handle.jobs.addVersion(versionRow(jobId, job.latestVersion + 1, definition, canonical, member.userId, clock.now()), clock.now())
        return true
      })
      return ok({ ...view(member, handle, handle.jobs.find(jobId) as JobRow, true, reads), changed })
    },

    /** `POST /jobs/:jobId/approve { version, fingerprint? }` (owner/admin). */
    async approve(member: Member, jobId: string, body: unknown, reads: readonly number[] = SCHEMA_1_ONLY): Promise<Outcome<JobView>> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const b = versionBody(body)
      if (!b) return BAD_BODY('{ version, fingerprint? }')
      const { handle } = found
      const v = handle.jobs.version(jobId, b.version)
      if (!v) return VERSION_NOT_FOUND()
      if (b.fingerprint !== null && b.fingerprint !== v.fingerprint) return FINGERPRINT_CHANGED()
      if (found.job.state === 'retired') return RETIRED()
      const definition = definitionOf(v)
      if (definition === null) return SCHEMA_UNKNOWN()
      if (!reads.includes(v.schema)) return NEEDS_NEWER_SCREEN()
      const skill = await skillPinned(member.companyId, definition)
      if (!skill.ok) return skill
      // Stage 4a: the trigger again (a business plugin installed since may run that state as the AI's turn, ⑧).
      const problems = triggerProblems(handle, definition, member)
      if (problems.length > 0) return TRIGGER_NOT_ALLOWED(problems)
      let told = false
      const result = transactions.run((): Outcome<void> => {
        // Checked again inside the write: the membership or the rules may have changed meanwhile.
        const rights = withinRights(handle, definition)
        if (!rights.ok) return rights
        const job = handle.jobs.find(jobId) as JobRow
        const state: JobState = job.state === 'draft' ? 'active' : job.state
        const at = clock.now()
        handle.jobs.approve(jobId, v.version, v.fingerprint, member.userId, at, state)
        // 「受け取りが要ります」 (jobs.md "The acceptance notice"): the responsible person, when this version's
        // consent is not the one they accepted — never the approver themself (they see it on the screen).
        if (v.consentFingerprint !== job.acceptedConsent && v.actingUserId !== member.userId) {
          told = handle.notifications.insert([{
            id: ids.newId(), userId: v.actingUserId, kind: 'job_accept_needed', recordId: '', recordVersion: 0, action: '', actorId: member.userId, actorKind: 'human',
            dedupeKey: `job_accept_needed:${jobId}:${v.version}`, createdAt: at, readAt: null,
          }]).length > 0
        }
        return ok(undefined)
      })
      if (!result.ok) return result
      // The app re-reads at once (a bare signal; never fails the approval).
      if (told) { try { deps.noticesChanged?.(member.companyId, [v.actingUserId]) } catch { /* their own check catches up */ } }
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true, reads))
    },

    /**
     * `POST /me/jobs/:jobId/accept { version, fingerprint?, place? }`: the approved version's responsible person, in
     * their own name. A version whose grant names a deliverable place outside needs `place` — that place, chosen by
     * them and usable now (their own live pick: `places.live`) — kept with the acceptance; any other version takes
     * none. Accepting again with another place replaces it (how an expired folder pick is chosen again).
     */
    async accept(member: Member, jobId: string, body: unknown, reads: readonly number[] = SCHEMA_1_ONLY): Promise<Outcome<JobView>> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const b = versionBody(body, true)
      if (!b) return BAD_BODY('{ version, fingerprint?, place? }')
      const { handle, job } = found
      const v = handle.jobs.version(jobId, b.version)
      if (!v) return VERSION_NOT_FOUND()
      if (v.actingUserId !== member.userId) return refuse('forbidden', 'この定期の仕事の責任者だけが受け取れます。', { code: 'JOB_NOT_RESPONSIBLE' })
      if (b.fingerprint !== null && b.fingerprint !== v.fingerprint) return FINGERPRINT_CHANGED()
      if (job.approvedVersion !== v.version) return refuse('conflict', 'まだ承認されていない版は受け取れません。', { code: 'JOB_NOT_APPROVED' })
      const definition = definitionOf(v)
      if (definition === null) return SCHEMA_UNKNOWN()
      // What is accepted is what the screen showed: one that cannot show this shape never accepts it.
      if (!reads.includes(v.schema)) return NEEDS_NEWER_SCREEN()
      const wanted = definition.grant.deliverTo
      if (!wanted && b.place !== undefined) return BAD_BODY('{ version, fingerprint? } (this job has no place to choose)')
      const place = wanted ? parseJobAcceptedPlace(b.place, wanted) : null
      if (wanted && b.place !== undefined && !place) return BAD_BODY('{ version, fingerprint?, place: { connector, kind, ref } }')
      if (wanted && !place) return PLACE_NEEDED()
      // What is accepted must still be what was pinned: a Skill deleted or changed since refuses it.
      const skill = await skillPinned(member.companyId, definition)
      if (!skill.ok) return skill
      const problems = triggerProblems(handle, definition, null)
      if (problems.length > 0) return TRIGGER_NOT_ALLOWED(problems)
      const result = transactions.run((): Outcome<void> => {
        const rights = withinRights(handle, definition)
        if (!rights.ok) return rights
        // The place must be theirs and usable now (their own live pick): the run later puts only there.
        if (place && !deps.places?.live(member.companyId, member.userId, place)) return PLACE_NOT_USABLE()
        const at = clock.now()
        // Accepting the same consent again changes nothing of what an event job has seen (Codex review of #700).
        const again = handle.jobs.find(jobId)?.acceptedConsent === v.consentFingerprint && handle.jobs.eventCursor(jobId) !== null
        handle.jobs.accept(jobId, v.version, v.consentFingerprint, member.userId, at, place)
        // An event job (stage 4a) looks at what happens from its acceptance on — never back in time.
        if (isRecordTrigger(definition.trigger) && !again) handle.jobs.startEventCursor(jobId, definition.trigger.startRecord, at)
        return ok(undefined)
      })
      if (!result.ok) return result
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true, reads))
    },

    /** `POST /jobs/:jobId/pause`: owner/admin (`ADMIN`), or the responsible person (`BY_RESPONSIBLE`). */
    pause(member: Member, jobId: string, reads: readonly number[] = SCHEMA_1_ONLY): Outcome<JobView> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const { handle, job } = found
      if (!hasFullAccess(member.role) && !controls(handle, job, member.userId)) return NOT_RESPONSIBLE()
      if (job.state === 'retired') return RETIRED()
      const reason: JobPauseReason = hasFullAccess(member.role) ? 'ADMIN' : 'BY_RESPONSIBLE'
      // An owner/admin's pause holds over the responsible person's own (who could otherwise resume it); a system pause stays as it is.
      if (job.state !== 'paused' || (reason === 'ADMIN' && job.pausedReason === 'BY_RESPONSIBLE')) {
        transactions.run(() => {
          handle.jobs.setState(jobId, 'paused', reason, member.userId, clock.now())
          // Nothing still waiting runs after this pause, also not after resuming.
          deps.occurrenceHolds?.holdDue(member.companyId, jobId, 'JOB_PAUSED')
        })
      }
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true, reads))
    },

    /**
     * `POST /jobs/:jobId/resume`: owner/admin any pause (an approved version's responsible person and
     * rights checked again); the responsible person only a pause they made themselves.
     */
    async resume(member: Member, jobId: string, reads: readonly number[] = SCHEMA_1_ONLY): Promise<Outcome<JobView>> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const { handle, job } = found
      if (job.state !== 'paused') return ok(view(member, handle, job, true, reads))
      // A non-admin resumes only a pause they made themselves, while still the approved version's
      // responsible person (someone a later draft names may see the job, not lift another's pause).
      if (!hasFullAccess(member.role)
        && !(job.pausedReason === 'BY_RESPONSIBLE' && job.pausedBy === member.userId && controls(handle, job, member.userId))) {
        return refuse('forbidden', '止めた本人か管理者だけが、この定期の仕事を再開できます。', { code: 'JOB_PAUSED_BY_OTHER' })
      }
      if (job.approvedVersion !== null) {
        const approved = handle.jobs.version(jobId, job.approvedVersion) as JobVersionRow
        // Rights and the Skill cannot be checked on a shape this server does not know: it stays paused here.
        const definition = definitionOf(approved)
        if (definition === null) return SCHEMA_UNKNOWN()
        const skill = await skillPinned(member.companyId, definition)
        if (!skill.ok) return skill
      }
      const result = transactions.run((): Outcome<void> => {
        const current = handle.jobs.find(jobId) as JobRow
        if (current.approvedVersion !== null) {
          const approved = handle.jobs.version(jobId, current.approvedVersion) as JobVersionRow
          const rights = withinRights(handle, definitionOf(approved))
          if (!rights.ok) return rights
        }
        handle.jobs.setState(jobId, current.approvedVersion === null ? 'draft' : 'active', null, null, clock.now())
        // A slot that passed while it was paused is held, never made due afterwards.
        deps.occurrenceHolds?.holdPassedSlot(member.companyId, jobId, 'JOB_PAUSED')
        return ok(undefined)
      })
      if (!result.ok) return result
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true, reads))
    },

    /** `PUT /jobs-stop { stopped }` (owner/admin): 「定期の仕事をすべて止める」 (owner decision D8). */
    setStopped(member: Member, body: unknown): Outcome<{ stopped: boolean }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', JOBS_FORBIDDEN)
      if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.stopped !== 'boolean') return BAD_BODY('{ stopped: boolean }')
      const handle = companyData.forCompany(member.companyId)
      const stopped = body.stopped
      transactions.run(() => {
        const was = handle.jobs.stopped()
        handle.jobs.setStopped(stopped, member.userId, clock.now())
        // Begins: nothing still waiting runs. Ends: a slot that passed while it lasted is held, never made due.
        if (stopped) deps.occurrenceHolds?.holdDue(member.companyId, null, 'COMPANY_STOPPED')
        else if (was) deps.occurrenceHolds?.holdPassedSlot(member.companyId, null, 'COMPANY_STOPPED')
      })
      return ok({ stopped })
    },

    /**
     * The member left the company (`companies.removeMember`, in its transaction): every job whose newest
     * or approved version names them is paused (`OWNER_LEFT`) and every owner / admin is told.
     */
    memberLeft(companyId: string, userId: string, actorId: string): void {
      pauseFor(companyId, jobsOf(companyId).listFor(userId), 'OWNER_LEFT', actorId)
    },

    /**
     * The member's role changed (`companies.changeRole`, in its transaction): a job whose approved
     * version they are responsible for and no longer fits within what they may read is paused
     * (`OWNER_RIGHTS_CHANGED`) and every owner / admin is told. (A permission rule changed elsewhere is
     * not looked at here: the run's own checks come with PR 3b / 5, design memo §4-2.)
     */
    roleChanged(companyId: string, userId: string, actorId: string): void {
      const handle = companyData.forCompany(companyId)
      const role = memberships.roleOf(companyId, userId)
      if (role === null) return
      const lost = handle.jobs.listFor(userId).filter(job => {
        if (job.approvedVersion === null) return false
        if (job.state === 'paused' && JOB_SYSTEM_PAUSE_REASONS.includes(job.pausedReason as JobPauseReason)) return false
        const v = handle.jobs.version(job.id, job.approvedVersion)
        if (!v || v.actingUserId !== userId) return false
        // A shape this server does not know never runs here anyway: not paused for a reason it cannot judge.
        const definition = definitionOf(v)
        return definition !== null && !fitsRights(handle, userId, role, definition)
      })
      pauseFor(companyId, lost, 'OWNER_RIGHTS_CHANGED', actorId)
    },

    /**
     * `GET /jobs/:jobId/occurrences`: the job's occurrences (newest slot first, ≤ 100) for the same people
     * as the job (anyone else: the same 404). Slots, states and short codes only — no name, no place.
     */
    occurrences(member: Member, jobId: string): Outcome<{ occurrences: JobOccurrenceView[] }> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      // 「もう一度」 (B PR 5b): whether it works now and why not, only for those who may press it (owner / admin).
      const retry = hasFullAccess(member.role) ? deps.occurrenceRetry : undefined
      return ok({
        // Only what the viewer may see (⑥): an event occurrence of a record they cannot read is not there, owners and admins too.
        occurrences: shownOccurrences(member, found.handle, jobId, OCCURRENCES_LISTED)
          .map((o): JobOccurrenceView => ({ ...occurrenceView(o), ...(retry ? retry(member.companyId, o) : {}) })),
      })
    },

    /**
     * Whether the version's responsible person may still run it now (the run's re-check, like approval's,
     * jobs.md "The runner"): null, or why not (`OWNER_LEFT`: not a member; `OWNER_RIGHTS_CHANGED`: a
     * place it names is no longer theirs to read or write).
     */
    runnerRefusal(companyId: string, version: JobVersionRow): 'OWNER_LEFT' | 'OWNER_RIGHTS_CHANGED' | null {
      const handle = companyData.forCompany(companyId)
      const definition = definitionOf(version)
      // Every runner skips a shape it does not know before asking; here it fails closed all the same.
      if (definition === null) return 'OWNER_RIGHTS_CHANGED'
      const role = memberships.roleOf(companyId, definition.actingUser)
      if (role === null) return 'OWNER_LEFT'
      return fitsRights(handle, definition.actingUser, role, definition) ? null : 'OWNER_RIGHTS_CHANGED'
    },

    /**
     * A PC run's pinned Skill is still there for its responsible person to fetch (B PR 5a, the claim): a shelf
     * Skill's pinned version is still stored at a place they read. A tree id of the shared folder is the
     * app's to find in its clone (true here): the pinned procedure runs even after the Skill changed.
     */
    pinnedSkillKept(companyId: string, version: JobVersionRow): boolean {
      const definition = definitionOf(version)
      if (definition === null) return false
      if (definition.run.kind !== 'procedure' || definition.run.procedure.source !== 'shelf_skill') return true
      const role = memberships.roleOf(companyId, definition.actingUser)
      const found = role === null ? null : deps.shelfSkill?.({ companyId, userId: definition.actingUser, role }, definition.run.procedure.item, definition.run.procedure.fingerprint)
      return !!found && found.readable && found.kept
    },

    /** The job's name for the member (`nameFor`: 「定期の仕事」 unless they read every place the newest version names), or null when they may not see the job. */
    nameOf(member: Member, jobId: string): string | null {
      const found = visibleJob(member, jobId)
      return found ? nameFor(member, found.handle, found.job) : null
    },

    /** Pause the job for a reason the server found (in the caller's transaction) and tell every owner / admin (`job_paused`). */
    pauseBySystem(companyId: string, jobId: string, reason: 'OWNER_LEFT' | 'OWNER_RIGHTS_CHANGED'): void {
      const job = jobsOf(companyId).find(jobId)
      if (job) pauseFor(companyId, [job], reason, JOB_ACTOR.id)
    },

    /** An occurrence notice's words for the member now, or null when they may not see the job (owner/admin, or its responsible person). */
    occurrenceNotice(member: Member, jobId: string, occurrenceId: string): { name: string; dueSlot: string; outcomeCode: string | null } | null {
      const found = visibleJob(member, jobId)
      if (!found) return null
      const occ = found.handle.jobs.occurrence(occurrenceId)
      if (!occ || occ.jobId !== jobId || !eventShown(found.handle, member, occ)) return null
      return { name: nameFor(member, found.handle, found.job), dueSlot: shownSlot(occ), outcomeCode: occ.outcomeCode }
    },

    /** Whether the member may see this occurrence of a job they see (⑥: an event one only while they read its record). */
    occurrenceShown(member: Member, occ: JobOccurrenceRow): boolean {
      return eventShown(companyData.forCompany(member.companyId), member, occ)
    },

    /**
     * 「上限を超えたので、いくつかの出来事を見送りました」 (`job_events_skipped`, stage 4a)'s job name for the member now, or
     * null: only its approved version's responsible person, while they see the job.
     */
    eventsSkippedNotice(member: Member, jobId: string): { name: string } | null {
      const found = visibleJob(member, jobId)
      if (!found || responsibleOf(found.handle, found.job) !== member.userId) return null
      return { name: nameFor(member, found.handle, found.job) }
    },

    /**
     * 「止まっています」 (`job_chain_stopped`, owner decision ①)'s words for the member now: the job's name and the cause as
     * they may read it — only while they see the job and that very stop (`at`) still stands; else null.
     */
    chainStopNotice(member: Member, jobId: string, at: string): { name: string; why: string } | null {
      const found = visibleJob(member, jobId)
      if (!found || found.handle.jobs.eventCursor(jobId)?.chainStop?.at !== at) return null
      const chain = chainOf(member, found.handle, found.job, readerOf(member, found.handle)).chainStopped
      return chain ? { name: nameFor(member, found.handle, found.job), why: chain.why } : null
    },

    /**
     * `POST /me/jobs/:jobId/watch { version, recordId }` (owner decision ①): the responsible person chooses the next
     * watched やること themselves. A new version that differs from the approved one only in its start record, approved and
     * accepted by that one press (the trigger is part of what they accept; nobody else's consent is involved) — the
     * record checked as any start record (they read it, a やること, not 「AI の番」). Only the approved version's
     * responsible person, only on the version shown (`version`), and not while a newer draft waits for approval.
     */
    async rewatch(member: Member, jobId: string, body: unknown, reads: readonly number[] = SCHEMA_1_ONLY): Promise<Outcome<JobView>> {
      const found = visibleJob(member, jobId)
      if (!found) return NOT_FOUND()
      const b = isObject(body) && Object.keys(body).every(k => k === 'version' || k === 'recordId') ? body : null
      if (!b || typeof b.version !== 'number' || !Number.isInteger(b.version) || typeof b.recordId !== 'string' || !RECORD_ID_RE.test(b.recordId)) {
        return BAD_BODY('{ version, recordId }')
      }
      const { handle, job } = found
      if (!controls(handle, job, member.userId)) return NOT_RESPONSIBLE_TO_REWATCH()
      if (job.state === 'retired') return RETIRED()
      if (job.approvedVersion !== b.version) return FINGERPRINT_CHANGED()
      if (job.latestVersion !== job.approvedVersion) return DRAFT_WAITING()
      const approved = handle.jobs.version(jobId, job.approvedVersion) as JobVersionRow
      const definition = definitionOf(approved)
      if (definition === null) return SCHEMA_UNKNOWN()
      if (!reads.includes(approved.schema)) return NEEDS_NEWER_SCREEN()
      if (!isRecordTrigger(definition.trigger)) return NOT_EVENT_JOB()
      const parsed = parseJobDefinition({ ...definition, trigger: { ...definition.trigger, startRecord: b.recordId } })
      if (!parsed.ok) return BAD_DEFINITION(parsed.problems)
      const next = parsed.definition
      const problems = triggerProblems(handle, next, member)
      if (problems.length > 0) return BAD_DEFINITION(problems)
      const result = transactions.run((): Outcome<void> => {
        const rights = withinRights(handle, next)
        if (!rights.ok) return rights
        const current = handle.jobs.find(jobId) as JobRow
        if (current.latestVersion !== b.version || current.approvedVersion !== b.version) return FINGERPRINT_CHANGED()
        const at = clock.now()
        const canonical = jobDefinitionCanonical(next)
        const row = versionRow(jobId, current.latestVersion + 1, next, canonical, member.userId, at)
        handle.jobs.addVersion(row, at)
        handle.jobs.approve(jobId, row.version, row.fingerprint, member.userId, at, current.state)
        handle.jobs.accept(jobId, row.version, row.consentFingerprint, member.userId, at, current.acceptedPlace)
        // A new start record: the watch starts over there, the stop is gone.
        handle.jobs.startEventCursor(jobId, b.recordId as string, at)
        return ok(undefined)
      })
      if (!result.ok) return result
      return ok(view(member, handle, handle.jobs.find(jobId) as JobRow, true, reads))
    },

    /**
     * 「受け取りが要ります」's words for the member now (jobs.md "The acceptance notice"), or null: shown only
     * while that version is still the approved one, the member is its responsible person, and they have not
     * accepted its consent yet — a notice that no longer asks anything is not shown.
     */
    acceptNotice(member: Member, jobId: string, version: number): { name: string; contentChanged: boolean; choosesPlace: boolean } | null {
      const found = visibleJob(member, jobId)
      if (!found || found.job.approvedVersion !== version || found.job.state === 'retired') return null
      const v = found.handle.jobs.version(jobId, version)
      if (!v || v.actingUserId !== member.userId || consentAccepted(found.handle, found.job)) return null
      // They had accepted an earlier version as its responsible person: what changed is the content, not who.
      const before = found.job.acceptedVersion === null ? null : found.handle.jobs.version(jobId, found.job.acceptedVersion)
      return {
        name: nameFor(member, found.handle, found.job), contentChanged: before !== null && before.actingUserId === member.userId,
        // The place outside is chosen in the app's 「受け取る」 (a build before it cannot: the notice says to update).
        choosesPlace: definitionOf(v)?.grant.deliverTo !== undefined,
      }
    },

    /** The job's name for a notice the member may read now (owner/admin only), or null. */
    noticeJob(member: Member, jobId: string): { name: string } | null {
      if (!hasFullAccess(member.role) || !isJobId(jobId)) return null
      const job = jobsOf(member.companyId).find(jobId)
      return job ? { name: job.name } : null
    },
  }
}

export type JobService = ReturnType<typeof createJobService>
