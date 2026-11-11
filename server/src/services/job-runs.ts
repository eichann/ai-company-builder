/**
 * A PC job's runs (定期の仕事, placement `a`, B PR 5a, `.claude/rules/jobs.md` "The PC's claim"). The AI runs
 * only on the responsible person's PC; the server lists what is theirs to claim, keeps the run (the same
 * execution-run core as 「AI の番」, `services/ai-runs.ts`, subject kind `occurrence`) and checks the job's
 * grant at every call of the run's token (design memo §4-2).
 *
 * - **Whose turn** (`GET /me/job-turns`, the claim's `resolve`): an occurrence of a placement-`a` job, `due` (or
 *   `running` with its run claimable again), not expired, the company's jobs not stopped, the job `active`,
 *   the occurrence's version still the approved one and accepted, the caller **that version's responsible
 *   person** (anyone else, another company's id or a server job's occurrence: the one 404 `JOB_NOT_FOUND`), their
 *   rights still covering every place it names, not absent that day, and a shelf Skill's pinned version still
 *   there, and (B PR 5a-2) its check among those the claiming app says it runs (`JOB_CHECK_NOT_SUPPORTED`). The
 *   claim's answer carries the meetings a `new_meetings` check finds (`meetingsFor`), the only minutes its run
 *   may read. The claim's refusals that tell something changed also write it (the rights lost → the job paused
 *   `OWNER_RIGHTS_CHANGED` + `job_paused` and the occurrence held, as the server's runner does; absent →
 *   skipped and told; another version approved → held); the list only leaves such an occurrence out.
 * - **The run takes the occurrence** (`claimed`, in the claim's transaction): `due` → `running` with the run.
 * - **Every call** (`routeRefusal`, asked by the record-token guard for every route of the run's token, whatever
 *   build calls): the run still holds the occurrence, the job still runnable as above, the responsible person's
 *   rights now (lost → paused + told + held, and refused), and the route within the pinned grant
 *   (`jobRunRouteAllowed`: never a create, an action, a plugin's call or a connector's read). 403 `NOT_IN_STEP`,
 *   naming nothing.
 * - **The finish** (`finishing`, in the finish's transaction): done → `nothing` (`jobResult: 'nothing'`) or the one
 *   やること (owner-only for the responsible person, id from the occurrence, operation key `create_task`) and
 *   `done` — re-checked first: a job no longer runnable makes nothing and holds the occurrence; a run that went
 *   to a person (`waiting_person` / `waiting_setup`) → `needs_person` `RUN_FAILED`, told. A temporary failure or
 *   an unknown outside result leaves it `running`: the run's own semantics (retried later, reconciled). The
 *   やること is checked first (`beforeFinish`): refused (records off…) → the run ended, `needs_person`, told.
 * - **The approved minutes are a hard deadline** from the run's first claim (`pcRunDeadlineMs`, never moved by a
 *   renew or a re-claim): after it a call, the finish, a re-claim or the clock ends the run and makes the
 *   occurrence `needs_person` `TIME_LIMIT`, told. A pause or the company's stop holds a running occurrence and
 *   ends its run (`holdDue` → `endPcRun`), so nothing comes back after a resume.
 */
import {
  JOB_ACTOR, JOB_PC_STEP, isOccurrenceId, jobRunRouteAllowed, occurrenceTaskId, parseJobRunResult,
  type JobDefinition, type JobOccurrenceState, type JobOutcomeCode,
} from '../../shared/core/jobs'
import type { JobMeetingView, JobTurnView } from '../../shared/types/jobs'
import type { Clock } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow, JobVersionRow } from '../ports/jobs'
import type { RunSubjectLiveRun, RunSubjectMember, RunSubjects } from '../ports/run-subjects'
import type { Transactions } from '../ports/transactions'
import type { Member } from './access'
import { endPcRun, pcRunDeadlineMs, type JobOccurrences } from './job-occurrences'
import type { JobService } from './jobs'
import { notInStep } from './not-in-step'
import { ok, refuse, type Outcome, type Refusal } from './outcome'
import type { ServiceCreateInput, ServiceRecordWriter } from './record-engine'

export interface JobRunDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  jobs: Pick<JobService, 'runnerRefusal' | 'pauseBySystem' | 'pinnedSkillKept' | 'nameOf'>
  notices: Pick<JobOccurrences, 'writeNotice' | 'tell'>
  writer: Pick<ServiceRecordWriter, 'check' | 'create'>
  /**
   * The meetings the member attended with a time in [since, until), oldest first (`minutes.attendedSince`:
   * people-only lists, what they read now). Absent: none (a `new_meetings` check then finds nothing).
   */
  meetings?: (member: Member, since: string, until: string, limit: number) => JobMeetingView[]
}

/** At most this many meetings a `new_meetings` check hands one run (the oldest first; the next occurrence takes the rest). */
export const JOB_MEETINGS_PER_RUN = 10

const NOT_FOUND = () => refuse('not-found', '定期の仕事が見つかりません。', { code: 'JOB_NOT_FOUND' })
const conflict = (code: string, error: string) => refuse('conflict', error, { code })
const GONE = () => conflict('JOB_TURN_GONE', 'この回はもう動かせません。')
const REFUSALS: Record<string, () => Refusal> = {
  EXPIRED: () => conflict('JOB_TURN_EXPIRED', 'この回は期限が過ぎました。'),
  COMPANY_STOPPED: () => conflict('JOB_STOPPED', '定期の仕事はすべて止められています。'),
  JOB_PAUSED: () => conflict('JOB_PAUSED', 'この定期の仕事は止まっています。'),
  JOB_VERSION_CHANGED: () => conflict('JOB_VERSION_CHANGED', '別の版が承認されたため、この回は動かせません。'),
  NOT_ACCEPTED: () => conflict('JOB_NOT_ACCEPTED', '受け取る前の定期の仕事は動かせません。'),
  OWNER_RIGHTS_CHANGED: () => conflict('JOB_GRANT_EXCEEDS', '責任者の今の権限では、この仕事の範囲に足りません。範囲か責任者を見直してください。'),
  OWNER_ABSENT: () => conflict('JOB_OWNER_ABSENT', '不在の日のため、この回は見送りました。'),
  SKILL_MISSING: () => conflict('JOB_SKILL_MISSING', '手順の Skill が、承認された版のまま見つかりません。'),
  TIME_LIMIT: () => conflict('JOB_TIME_LIMIT', '承認された時間を過ぎたため、この回は AI を止めました。人が確かめる必要があります。'),
}
/** The claiming app cannot run this occurrence's check (an older app, or one that does not know a newer check). */
const CHECK_NOT_SUPPORTED = () => conflict('JOB_CHECK_NOT_SUPPORTED', 'このアプリでは、この定期の仕事を動かせません。アプリを新しくしてください。')
/** How many of a company's waiting occurrences the turn list looks at (at most one `due` per job). */
const TURN_SCAN_LIMIT = 10_000

const definitionOf = (v: JobVersionRow): JobDefinition => JSON.parse(v.definition) as JobDefinition

/** Why an occurrence is not the caller's to run now (a short reason; `null`: it is). */
type Why = keyof typeof REFUSALS | 'GONE'

interface Found { handle: CompanyData; occ: JobOccurrenceRow; job: JobRow; version: JobVersionRow; definition: JobDefinition }

export function createJobRuns(deps: JobRunDeps) {
  const { companyData, transactions, clock } = deps
  /** The members a finish told (pushed once its transaction is over: `afterDone` / `afterFailed`). */
  const toTell = new Map<string, { companyId: string; userIds: string[] }>()

  /**
   * The occurrence when it is a PC job's and the member is its version's responsible person; null for anything
   * else (another member's, another company's, a server job's, an id that is no occurrence): the one 404.
   */
  function own(member: RunSubjectMember, occurrenceId: string): Found | null {
    if (!isOccurrenceId(occurrenceId)) return null
    const handle = companyData.forCompany(member.companyId)
    const occ = handle.jobs.occurrence(occurrenceId)
    if (!occ) return null
    const job = handle.jobs.find(occ.jobId)
    const version = handle.jobs.version(occ.jobId, occ.jobVersion)
    if (!job || !version || version.actingUserId !== member.userId) return null
    const definition = definitionOf(version)
    if (definition.placement !== 'a' || definition.run.kind !== 'procedure') return null
    return { handle, occ, job, version, definition }
  }

  /** Whether the job may still run this occurrence's version now (the claim, every call and the finish ask). */
  function runnable(f: Found): Why | null {
    if (f.handle.jobs.stopped()) return 'COMPANY_STOPPED'
    if (f.job.state !== 'active') return 'JOB_PAUSED'
    if (f.job.approvedVersion !== f.occ.jobVersion) return 'JOB_VERSION_CHANGED'
    if (f.job.acceptedConsent === null || f.job.acceptedConsent !== f.version.consentFingerprint) return 'NOT_ACCEPTED'
    // The responsible person's rights now, with the pinned version (rules, groups, 所属, private folders, role).
    if (deps.jobs.runnerRefusal(f.handle.companyId, f.version) !== null) return 'OWNER_RIGHTS_CHANGED'
    return null
  }

  /** A running occurrence's run is past its hard deadline (first claim + the approved minutes, `pcRunDeadlineMs`). */
  function overdue(f: Found, nowMs: number): boolean {
    const run = f.occ.state === 'running' && f.occ.runId ? f.handle.aiRuns.byId(f.occ.runId) : null
    return run !== null && nowMs >= pcRunDeadlineMs(run, f.definition)
  }

  /** Whose turn: everything a claim needs, without changing anything. */
  function whyNot(f: Found, nowMs: number): Why | null {
    if (f.occ.state !== 'due' && f.occ.state !== 'running') return 'GONE'
    if (overdue(f, nowMs)) return 'TIME_LIMIT'
    if (nowMs >= Date.parse(f.occ.expiresAt)) return 'EXPIRED'
    const why = runnable(f)
    if (why) return why
    const day = f.occ.dueSlot.slice(0, 10)
    // D5: nobody runs it for them — and an absent person's own PC does not either (as the server's runner).
    if (f.occ.state === 'due' && f.handle.tasks.absencesFrom(day).some(a => a.userId === f.definition.actingUser && a.from <= day && day <= a.until)) return 'OWNER_ABSENT'
    if (!deps.jobs.pinnedSkillKept(f.handle.companyId, f.version)) return 'SKILL_MISSING'
    return null
  }

  /** Move the occurrence and say why, in its own transaction (or the caller's); the members told. */
  function end(f: Found, from: JobOccurrenceState[], to: JobOccurrenceState, code: JobOutcomeCode, notice: 'job_skipped' | 'job_failed' | null): string[] {
    if (!f.handle.jobs.moveOccurrence(f.occ.id, from, to, { outcomeCode: code }, clock.now())) return []
    return notice ? deps.notices.writeNotice(f.handle.companyId, notice, f.occ) : []
  }

  /**
   * What the server writes when a claim or a call finds the job no longer runnable as pinned (as its own
   * runner does, jobs.md "The runner"): the rights lost → the occurrence held and the job paused, owners /
   * admins told (`job_paused`); absent → skipped and told; another version approved → held; past the run's
   * hard deadline → `needs_person` `TIME_LIMIT`, told. A running occurrence's run is ended with it (`endPcRun`).
   */
  function record(f: Found, why: Why): void {
    let told: string[] = []
    transactions.run(() => {
      const at = clock.now()
      if (why === 'OWNER_RIGHTS_CHANGED') {
        end(f, ['due', 'running'], 'held', 'OWNER_RIGHTS_CHANGED', null)
        if (f.occ.state === 'running') endPcRun(f.handle, f.occ.runId, 'OWNER_RIGHTS_CHANGED', at)
        deps.jobs.pauseBySystem(f.handle.companyId, f.job.id, 'OWNER_RIGHTS_CHANGED')
      } else if (why === 'TIME_LIMIT') {
        if (f.handle.jobs.moveOccurrence(f.occ.id, ['running'], 'needs_person', { outcomeCode: 'TIME_LIMIT' }, at)) {
          told = deps.notices.writeNotice(f.handle.companyId, 'job_failed', f.occ)
          endPcRun(f.handle, f.occ.runId, 'TIME_LIMIT', at)
        }
      } else if (why === 'OWNER_ABSENT') told = end(f, ['due'], 'skipped', 'OWNER_ABSENT', 'job_skipped')
      else if (why === 'JOB_VERSION_CHANGED') end(f, ['due'], 'held', 'JOB_VERSION_CHANGED', null)
    })
    deps.notices.tell(f.handle.companyId, told)
  }

  /** The previous occurrence that ran (done or nothing): new files are looked for since its time, else since approval. */
  function checkSince(f: Found): string {
    const before = f.handle.jobs.occurrences(f.job.id, 50).find(o => o.dueSlot < f.occ.dueSlot && (o.state === 'done' || o.state === 'nothing'))
    return before?.dueAt ?? f.version.approvedAt ?? f.version.createdAt
  }

  /**
   * The meetings a `new_meetings` check finds for this occurrence (B PR 5a-2): the responsible person's own,
   * attended since `checkSince` and until now, whose title holds one of the check's words when it names any.
   * The run may read these meetings' minutes and no other (`routeRefusal`).
   */
  function meetingsFor(f: Found, member: Member, nowMs: number): JobMeetingView[] {
    const check = f.definition.check
    if (check.kind !== 'new_meetings' || !deps.meetings) return []
    const words = check.titleWords.map(w => w.normalize('NFKC').toLowerCase())
    return deps.meetings(member, checkSince(f), new Date(nowMs).toISOString(), 200)
      .filter(m => words.length === 0 || words.some(w => m.title.normalize('NFKC').toLowerCase().includes(w)))
      .slice(0, JOB_MEETINGS_PER_RUN)
  }

  /** The one やること of a finish (owner-only for the responsible person: what the job read and wrote reaches nobody else). */
  function taskInput(f: Found, runId: string, result: { title: string; summary: string | null }): ServiceCreateInput {
    return {
      type: 'task', id: occurrenceTaskId(f.occ.id), title: result.title, ...(result.summary ? { summary: result.summary.slice(0, 300) } : {}),
      personalOwner: f.definition.actingUser, fields: { assignee: f.definition.actingUser },
      actor: { ...JOB_ACTOR, runId }, note: '定期の仕事から作りました',
      // D9: no notice of its own — the やること in 「あなたの番」 is the notice.
      quiet: true,
    }
  }

  /** The run holding this occurrence now, or null (ended meanwhile, another run). */
  function held(member: RunSubjectMember, run: RunSubjectLiveRun): Found | null {
    const f = own(member, run.subject.id)
    return f && f.occ.state === 'running' && f.occ.runId === run.id ? f : null
  }

  function turnView(member: Member, f: Found): JobTurnView {
    const d = f.definition
    if (d.run.kind !== 'procedure') throw new Error('not a PC job')
    return {
      occurrenceId: f.occ.id, jobId: f.job.id, jobVersion: f.occ.jobVersion, fingerprint: f.version.fingerprint,
      name: deps.jobs.nameOf(member, f.job.id) ?? '定期の仕事', dueSlot: f.occ.dueSlot, dueAt: f.occ.dueAt, expiresAt: f.occ.expiresAt,
      state: f.occ.state as 'due' | 'running', check: d.check, checkSince: checkSince(f), procedure: d.run.procedure, grant: d.grant,
    }
  }

  const subjects: RunSubjects<Refusal> = {
    resolve(member, subject, step) {
      if (subject.kind !== 'occurrence' || step !== JOB_PC_STEP) return NOT_FOUND()
      const f = own(member, subject.id)
      if (!f) return NOT_FOUND()
      // An app that cannot run this check never claims it (B PR 5a-2); nothing is written for it.
      if (!subject.checks?.includes(f.definition.check.kind)) return CHECK_NOT_SUPPORTED()
      const why = whyNot(f, clock.nowMs())
      if (why === 'GONE') return GONE()
      if (why) {
        record(f, why)
        return REFUSALS[why]()
      }
      return ok({ pin: null, job: { id: f.job.id, version: f.occ.jobVersion, fingerprint: f.version.fingerprint } })
    },

    claimed(member, run) {
      const f = own(member, run.subject.id)
      if (!f) return NOT_FOUND()
      // A re-claim keeps its own occurrence; a due one becomes this run's. Anything else: someone else's now.
      if (f.occ.state === 'running' && f.occ.runId === run.id) return null
      if (!f.handle.jobs.moveOccurrence(f.occ.id, ['due'], 'running', { runId: run.id, outcomeCode: null }, clock.now())) return GONE()
      return null
    },

    beforeFinish(member, run, body) {
      if (run.step !== JOB_PC_STEP) return null
      const f = held(member, run)
      if (!f) return null
      // Past the hard deadline: the run ends, the occurrence needs a person, and the finish makes nothing.
      if (overdue(f, clock.nowMs())) {
        record(f, 'TIME_LIMIT')
        return REFUSALS.TIME_LIMIT()
      }
      // The one やること checked before anything is written (as the server's runner does): refused → the run
      // ended, `needs_person` with that code, told — never left running.
      const result = body.outcome === 'done' ? parseJobRunResult(body.jobResult) : null
      if (result === null || result === 'nothing' || !f.definition.grant.creates.includes('task') || runnable(f)) return null
      const refused = deps.writer.check(f.handle.companyId, taskInput(f, run.id, result))
      if (!refused) return null
      const code: JobOutcomeCode = refused.reason === 'records-off' ? 'RECORDS_OFF' : 'TASK_NOT_CREATED'
      let told: string[] = []
      transactions.run(() => {
        told = end(f, ['running'], 'needs_person', code, 'job_failed')
        endPcRun(f.handle, run.id, code, clock.now())
      })
      deps.notices.tell(f.handle.companyId, told)
      return refuse('conflict', 'やることを作れませんでした。人が確かめる必要があります。', { code: code === 'RECORDS_OFF' ? 'RECORDS_DISABLED' : 'JOB_TASK_NOT_CREATED' })
    },

    finishing(member, run, body) {
      if (run.step !== JOB_PC_STEP) return null
      // Ended meanwhile (held by a pause found at a call, expired): the run's finish is all that is left.
      const f = held(member, run)
      if (!f) return null
      if (run.state === 'waiting_person' || run.state === 'waiting_setup') {
        const told = end(f, ['running'], 'needs_person', 'RUN_FAILED', 'job_failed')
        toTell.set(run.id, { companyId: f.handle.companyId, userIds: told })
        return null
      }
      if (run.state !== 'done') return null
      const result = parseJobRunResult(body.jobResult)
      if (result === null) return refuse('bad-request', 'jobResult is "nothing" or { title, summary? }', { code: 'JOB_RESULT_REQUIRED' })
      // Checked again: what changed while it ran makes nothing (the occurrence is held with its reason).
      const why = runnable(f)
      if (why) {
        end(f, ['running'], 'held', why as JobOutcomeCode, null)
        if (why === 'OWNER_RIGHTS_CHANGED') deps.jobs.pauseBySystem(f.handle.companyId, f.job.id, 'OWNER_RIGHTS_CHANGED')
        return null
      }
      const at = clock.now()
      if (result === 'nothing') {
        f.handle.jobs.moveOccurrence(f.occ.id, ['running'], 'nothing', { outcomeCode: null }, at)
        return null
      }
      if (!f.definition.grant.creates.includes('task')) return refuse('bad-request', 'この定期の仕事はやることを作れません。', { code: 'JOB_TASK_NOT_GRANTED' })
      // The one やること: its id from the occurrence (one by construction) and the run's key `create_task`.
      const runs = f.handle.aiRuns
      const key = 'create_task'
      if (!runs.operation(run.id, key)) {
        runs.insertOperation({
          runId: run.id, key, fingerprint: `${f.job.id}:${f.version.version}:${f.version.fingerprint}`, kind: 'record-create', state: 'in_progress',
          generation: 1, refKind: null, refId: null, status: null, reconciledBy: null, createdAt: at, updatedAt: at,
        })
      }
      // Checked before the transaction (`beforeFinish`); a refusal here is a race: the whole finish rolls back.
      const made = deps.writer.create(f.handle.companyId, taskInput(f, run.id, result))
      if (!made.ok) return refuse('conflict', 'やることを作れませんでした。', { code: made.reason === 'records-off' ? 'RECORDS_DISABLED' : 'JOB_TASK_NOT_CREATED' })
      runs.updateOperation(run.id, key, ['in_progress'], { state: 'done', refKind: 'record', refId: made.record.id }, at)
      if (!f.handle.jobs.moveOccurrence(f.occ.id, ['running'], 'done', { outcomeCode: null }, at)) return GONE()
      return null
    },

    routeRefusal(member, run, route, params) {
      if (run.step !== JOB_PC_STEP) return notInStep()
      const f = held(member, run)
      if (!f) return notInStep()
      // Past the hard deadline (a renewed lease does not move it): the run ends and nothing more goes through.
      if (overdue(f, clock.nowMs())) {
        record(f, 'TIME_LIMIT')
        return notInStep()
      }
      const why = runnable(f)
      if (why) {
        if (why === 'OWNER_RIGHTS_CHANGED') record(f, why)
        return notInStep()
      }
      // The minutes route only for a meeting this occurrence's check finds now (the grant names the route too).
      const meetingFound = () => typeof params.recordId === 'string' && meetingsFor(f, member, clock.nowMs()).some(m => m.id === params.recordId)
      return jobRunRouteAllowed(f.definition.grant, route, meetingFound) ? null : notInStep()
    },

    bindsTokens(run: RunSubjectLiveRun) {
      return run.subject.kind === 'occurrence' && run.step === JOB_PC_STEP
    },

    afterDone(_member, run) { flush(run.id) },
    afterFailed(_member, run) { flush(run.id) },
  }

  function flush(runId: string) {
    const pending = toTell.get(runId)
    if (!pending) return
    toTell.delete(runId)
    deps.notices.tell(pending.companyId, pending.userIds)
  }

  return {
    subjects,

    /**
     * `GET /me/job-turns`: the caller's occurrences of PC jobs they may claim now (newest due last), each with
     * what the app needs to run it — the check, since when new files count, the pinned procedure and the
     * grant. Nothing is changed here; an occurrence that is not theirs to run now is left out.
     */
    turns(member: Member): Outcome<{ turns: JobTurnView[] }> {
      const handle = companyData.forCompany(member.companyId)
      const nowMs = clock.nowMs()
      const turns: JobTurnView[] = []
      for (const occ of [...handle.jobs.dueOccurrences(TURN_SCAN_LIMIT), ...handle.jobs.runningOccurrences(TURN_SCAN_LIMIT)]) {
        const f = own(member, occ.id)
        if (!f || whyNot(f, nowMs) !== null) continue
        // A running one only while its run may be claimed again (lease over, given back, retried later).
        if (f.occ.state === 'running') {
          const r = f.occ.runId ? handle.aiRuns.byId(f.occ.runId) : null
          const live = r?.state === 'running' && r.claimExpiresAt !== null && Date.parse(r.claimExpiresAt) > nowMs
          const waits = r !== null && (r.state === 'waiting_person' || r.state === 'waiting_setup' || r.state === 'waiting_reconcile' || (r.state === 'retry_later' && r.retryAt !== null && Date.parse(r.retryAt) > nowMs))
          if (!r || live || waits) continue
        }
        turns.push(turnView(member, f))
      }
      turns.sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      return ok({ turns })
    },

    /** The turn of the occurrence a claim just took (the claim's answer, with the meetings its check found), or null. */
    turnOf(member: Member, occurrenceId: string): JobTurnView | null {
      const f = own(member, occurrenceId)
      if (!f) return null
      const turn = turnView(member, f)
      return f.definition.check.kind === 'new_meetings' ? { ...turn, meetings: meetingsFor(f, member, clock.nowMs()) } : turn
    },
  }
}

export type JobRuns = ReturnType<typeof createJobRuns>
