// A scheduled job's run on this PC (定期の仕事, placement `a`, B PR 5a-2, .claude/rules/jobs.md "The app's
// runner"): main's part, beside the record AI turns' (claims.ts), which hands it its claim / hold / finish
// machinery. The run itself is the same hidden consultation in the main window (useAiTurnRunner).
//   - turns: `GET /me/job-turns`, the occurrences this app can run (its check kinds), remembered for the claim;
//   - claim: the server's run (`POST /job-run-claims`, naming the checks this app runs), then the check — new
//     files in the grant's path, or the meetings the server found — before any AI: nothing found → the run
//     finishes `nothing` and no message is sent; then the pinned Skill read (a company Skill from the pinned
//     tree, a shelf Skill fetched and verified by its version) and the first message;
//   - event occurrences (stage 4b-2, schema 3): listed and claimed only by naming the kind `event` and the check
//     `source_record`; the server checks the record (no check here); the first message starts from that record;
//   - before the AI starts, the server confirms the run once more (a renew); refused or not answered → nothing starts;
//   - while it runs: the grant's tool ceiling and write area for that consultation only, its `job_report`,
//     a stop just before the approved minutes run out, and a stop when the server takes the run away — or cannot be
//     reached to confirm it (fail closed: claims.ts `hold`'s guard, `JOB_CONFIRM_MAX_AGE_MS`);
//   - settle: done with the reported title (the server makes the one やること), else a failure the server
//     sends where it belongs.
import path from 'node:path'
import { readdir, realpath, stat } from 'node:fs/promises'
import { JOB_EVENT_CHECK_KINDS, JOB_PC_CHECK_KINDS, JOB_SET_CHECK_KIND, isOccurrenceId, parseJobDecisionFile, parseJobRunResult, type JobDecision, type JobGrant, type JobRunResult } from '../../../../shared/core/jobs'
import { jobPathProblem } from '../../../../shared/core/jobs'
import { diskKey } from '../../../../shared/core/paths'
import {
  JOB_PC_STEP, jobFirstMessage, jobToolAccess, jobWriteArea, parseJobTurn, parseJobTurns,
  type JobFound, type JobToolAccess, type JobWriteArea, type QueuedJobTurn,
} from '../../../shared/ai-turn-steps/job'
import type { AiTurnClaimResult, AiTurnSettleResult } from '../../../shared/ai-turns'
import {
  CLAUDE_IN_RUN_GATE, SET_WATCH_UPDATES_FILE, SET_WATCH_UPDATES_FILE_MAX, parseSetReportInput, parseUpdateProposals, quotesNotInMinutes,
  runFolderName, setJobResult, setWatchFirstMessage, type DecisionGate,
} from '../../../shared/ai-turn-steps/set-watch'
import type { PinnedCopy, RunFolder, SetRunRecord, SetWatchFs } from './set-watch-run'

/** One instant on both clocks (stage 4b-2): what a job run's age is measured from (claims.ts). */
export interface ClockStamp { mono: number; wall: number }
/** An opaque hold (claims.ts `hold`'s answer): a job's run asks about **its** hold, never another claim's of the same run. */
export type HoldHandle = object

type Session = (companyId: string, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; data: unknown; code?: string } | null>
type Failure = { class: 'temporary' | 'bad-input' | 'permission' | 'unknown-result'; code: string }

export interface JobRunDeps {
  /** claims.ts's own: the member's session call, holding a run (registry + renewal) and finishing it. */
  session: Session
  /**
   * `guard.confirmedAt`: when the claim was sent — the run fails closed from there (stage 4b-2). The answer is this hold,
   * which `holds` and `confirm` take: an older claim never counts a newer claim's hold of the same run as its own.
   */
  hold: (companyId: string, key: string, conversationId: string, run: { id: string; generation: number }, onLost: () => void, guard: { confirmedAt: ClockStamp }) => HoldHandle
  /** Renew the held run now: true only when the server confirmed this hold within the deadline (stage 4b-2, before the AI starts). */
  confirm: (companyId: string, key: string, handle: HoldHandle) => Promise<boolean>
  /** Now, on both clocks the hold's guard is timed on. */
  clockStamp: () => ClockStamp
  finishRun: (companyId: string, key: string, failure: Failure | null, extra?: { jobResult: JobRunResult | Record<string, unknown> }) => Promise<{ status: number; code?: string } | null>
  /** Whether this app still holds that run through this very hold (registered for the consultation's tokens, not taken away, not claimed again). */
  holds: (companyId: string, key: string, handle: HoldHandle) => boolean
  deviceId: string
  /** A company Skill's SKILL.md at the pinned tree in the company folder (claims.ts's `readProcedure`); null = not here. */
  readCompanySkill: (companyId: string, skill: string, tree: string, companyRoot: string | null) => Promise<string | null>
  /** A shelf Skill's SKILL.md at the pinned version, fetched and checked against it; null = not readable. */
  readShelfSkill: (companyId: string, item: string, skill: string, version: string) => Promise<string | null>
  /**
   * The identity of the last fetch of the place's repository now (`gitFetchMark`: `FETCH_HEAD`, rewritten by every
   * fetch); null when it cannot be told (a working folder, the place not here, an error).
   */
  fetchMark: (companyRoot: string | null, place: string) => Promise<string | null>
  /**
   * Before a `new_files` claim: whether this PC has what the server has, and the commit the check looks up to
   * (null in a working folder: no git). `mark`: the fetch identity taken once the server had listed the occurrence
   * (it lists only occurrences whose time has come) — a fetch since then, told by that identity changing and never by
   * any clock, holds everything up to the window's end. null: the place is not on this PC; `not-synced`: not yet.
   */
  checkPoint: (companyRoot: string | null, place: string, mark: string | null) => Promise<{ commit: string | null } | null | 'not-synced'>
  /**
   * Files (company paths) added under `place`: after `sinceCommit` up to `upto` in the shared folder (by date after
   * `since` when no commit is known), in [since, until) by time in a working folder — the server's instants, read
   * through `offset` (the server's clock minus this PC's, measured at the claim). null when this PC cannot tell.
   */
  newFiles: (companyRoot: string | null, place: string, window: { since: string; until: string; sinceCommit: string | null; upto: string | null; offset: ClockOffset | null }) => Promise<string[] | null | 'not-synced'>
  /** Stop the consultation's AI now (main's chat turns), saying why in its reply. */
  stopTurn: (conversationId: string) => void
  /**
   * A set watch's file work on this PC (4b-4 PR5, `set-watch-run.ts`): the pinned copy, the run folder, the images, the PC
   * record. Absent: set watches are not run here (their turns are not asked for, their claims never made).
   */
  setWatch?: SetWatchFs
  /** What judges a set watch (§5-0): Claude inside the run, unless a test hands another. */
  gate?: DecisionGate
  now?: () => number
  log?: Pick<Console, 'warn'>
}

/**
 * The server's clock minus this PC's, as a range: the server stamped its claim answer (`run.updatedAt`) somewhere
 * between the request leaving and its answer arriving here, so the true difference lies in [min, max].
 */
export interface ClockOffset { min: number; max: number }

/**
 * A working folder's check (files by their modification time, which this PC's clock stamped) runs only while this
 * PC's clock is known to be within this of the server's: further off, it may also have been set differently when
 * the files were written, and a missed file would end the occurrence as `nothing` — so the run is given back
 * (`temporary` `CLOCK_NOT_TRUSTED`: retried, then a person is told) instead.
 */
export const JOB_CLOCK_TOLERANCE_MS = 5 * 60_000

/** A place not synced yet: asked again after this (the app syncs by itself meanwhile); no start is counted. */
export const NOT_SYNCED_RETRY_MS = 30_000
/** An earlier occurrence of the job still runs (409 `JOB_EARLIER_RUNNING`, jobs.md "Never side by side"): asked again after this. */
export const EARLIER_RUNNING_RETRY_MS = 60_000

/** A record whose completion's answer was lost is asked about again only after this. */
export const RECONCILE_AGAIN_MS = 10 * 60_000

/** A set watch's run that could not keep its record on this PC: nothing was sent, and the AI is told to end (B2 ③). */
export const SET_RECORD_NOT_KEPT = 'この PC に結果を書き残せなかったため、完了を送っていません。これで終えてください（あとでもう一度動きます）。'

/** What the AI is told when its report could not make the やること (the run was taken away or finished meanwhile). */
export const JOB_REPORT_REFUSED = '仕事が止められていたか、時間が来ていたため、やることは作られませんでした。作ったとは言わず、そのとおり伝えてください。'

/** How long before the approved minutes run out the app stops its AI (the server refuses every call after them). */
export const JOB_STOP_BEFORE_MS = 60_000

/**
 * Fail closed (stage 4b-2, owner memo 「段4b 設計メモ」 §6 / D12, jobs.md "The app's runner" "Fail closed"): a job's run has
 * nobody watching, so its AI goes on only while the server keeps confirming it may. A renew is answered within
 * `JOB_RENEW_TIMEOUT_MS` or its answer does not count (a late success never extends the run); the AI stops once the last
 * confirmation was sent more than `JOB_CONFIRM_MAX_AGE_MS` ago — offline, the server unreachable or hung, renews failing
 * with 5xx. Renewed every minute (`AI_RUN_RENEW_EVERY_MS`), so two renews may fail in a row; well inside the server's
 * 5-minute lease, after which it refuses the run's token anyway. The deadline is 30 s (owner decision 2026-11-22), shorter
 * than the renew interval, so one renew is over before the next is due; a hold never sends a second renew while its first
 * is still out (`claims.ts` `renewOnce`), and a confirmation only ever moves forward.
 */
export const JOB_RENEW_TIMEOUT_MS = 30_000
/** How often a held run is renewed (the server's lease lasts 5 minutes). */
export const AI_RUN_RENEW_EVERY_MS = 60_000
/** The occurrence kinds this app runs (stage 4b-2): time slots and events (`?kinds=` on the list, `kinds` on an event's claim). */
const JOB_KINDS_RUN = ['time', 'event'] as const
export const JOB_CONFIRM_MAX_AGE_MS = 3 * 60_000

/**
 * A renew's answer that says the run may not go on: 401 (signed out), 403 (refused), 404 (no such run for this member:
 * a record they no longer read, an older server that froze the shape — the rollback floor), 409 (taken over, ended, a
 * condition failed: `JOB_EVENT_ENDED`, `RUN_SUPERSEDED`). A 5xx or no answer is "not confirmed", left to the window.
 */
export function jobRunGoneOnRenew(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 409
}

/**
 * The refusals of a run-bound token's call that say the run is over (stage 4b-2): any 401; a 403 / 404 / 409 / 503 only
 * with one of these codes — the gate (`NOT_IN_STEP`: also every refused condition at the call), the fence
 * (`RUN_SUPERSEDED`), the run missing, an event that ended, the emergency stop. Other refusals of a call are the tool's
 * own answer and the run goes on (a Drive overwrite refused `DRIVE_FILE_CHANGED_SINCE` 409 → "put a new file"; a record
 * not found 404).
 */
const RUN_GONE_CODES = new Set(['NOT_IN_STEP', 'RUN_SUPERSEDED', 'RUN_NOT_FOUND', 'JOB_EVENT_ENDED', 'JOB_NOT_FOUND', 'RECORD_TOKEN_INVALID', 'AI_STOPPED', 'ACB_STOPPED'])
export function jobRunGoneOnCall(status: number, code: string | undefined): boolean {
  if (status === 401) return true
  return (status === 403 || status === 404 || status === 409 || status === 503) && code !== undefined && RUN_GONE_CODES.has(code)
}

interface Held {
  companyId: string
  occurrenceId: string
  runId: string
  access: JobToolAccess
  area: JobWriteArea
  /** The report's finish: `done` (the server made the やること), `refused` (it did not), null (no report yet). */
  reported: 'done' | 'refused' | null
  timedOut: boolean
  lost: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** This claim's hold (claims.ts); null until held. */
  hold: HoldHandle | null
  /** A set watch's run (4b-4 PR5); absent for every other job. */
  set?: HeldSet
}

/** What main holds for a set watch's run (4b-4 PR5). */
interface HeldSet {
  companyRoot: string | null
  meetingId: string
  generation: number
  place: string
  folder: string
  copy: PinnedCopy
  decision: JobDecision
  /** The day a run folder is named by when the AI gives none (the event's day on this PC). */
  day: string
  /** The folder made for this claim (null until `proposal_folder`). */
  run: RunFolder | null
  /** The minutes of the pinned meeting this run read (`minutes_read`): what its quotes are checked against (I7). */
  minutes: string | null
  /** The minutes' documents' versions that read answered (`docVersion`); null = not read, or not said (シナリオ集 T7). */
  minutesDocVersion: string | null
  /** The AI was told once that its update proposals' file is not the shape: a second report ends with none counted. */
  updatesWarned: boolean
  /** The record could not be kept on this PC: nothing is sent, the run is given back. */
  recordFailed: boolean
  /** The run's tool calls, one at a time. */
  queue: Promise<void>
}

export function createJobRuns(deps: JobRunDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const keyOf = (companyId: string, occurrenceId: string) => `${companyId}\n${occurrenceId}`
  /** The member's turns as last listed, per company. */
  const listed = new Map<string, Map<string, QueuedJobTurn>>()
  /**
   * The fetch identity (`fetchMark`) taken at an occurrence's first `new_files` check, after the server listed it, by
   * company and occurrence: the check counts as synced only once it has changed (a fetch since). No clock is read —
   * a PC's clock set back or forward can neither make an old fetch pass nor keep a new one waiting. Forgotten once
   * the occurrence is off the list.
   */
  const fetchMarks = new Map<string, string>()
  /** Off this app's list (finished, taken, given up): its mark is forgotten too, so a later listing starts anew. */
  const unlist = (companyId: string, occurrenceId: string) => {
    listed.get(companyId)?.delete(occurrenceId)
    fetchMarks.delete(keyOf(companyId, occurrenceId))
  }
  /** Runs this app holds, by consultation. */
  const byConversation = new Map<string, Held>()
  const byOccurrence = new Map<string, string>()

  function forget(conversationId: string) {
    const h = byConversation.get(conversationId)
    if (!h) return
    if (h.timer) clearTimeout(h.timer)
    byConversation.delete(conversationId)
    byOccurrence.delete(keyOf(h.companyId, h.occurrenceId))
  }

  async function findings(turn: QueuedJobTurn, companyRoot: string | null, point: { commit: string | null } | null, offset: ClockOffset | null): Promise<JobFound | null | 'not-synced' | 'clock'> {
    if (turn.check.kind === 'new_meetings') return { kind: 'meetings', meetings: turn.meetings ?? [] }
    // An event occurrence (stage 4b-2): the server checked its record at the claim (and does at every call); nothing is
    // looked at here. Never `nothing` (an event run may not finish so: the server's conditions decide it is not needed).
    if (turn.check.kind === 'source_record') return turn.kind === 'event' && turn.source ? { kind: 'record', recordId: turn.source.recordId } : null
    // A set watch (4b-4 PR5): the server checked the record and its meeting at the claim (and does at every call).
    if (turn.check.kind === JOB_SET_CHECK_KIND) return turn.set && turn.source?.meetingId ? { kind: 'record', recordId: turn.source.recordId } : null
    if (turn.check.kind === 'new_files') {
      if (point === null) return null
      // A working folder (no commit): files by this PC's clock, so it must be known to agree with the server's —
      // unknown or too far off, no check is made (never `nothing` on a clock's say-so).
      if (point.commit === null && !clockTrusted(offset)) return 'clock'
      // The window ends at the occurrence's own time (an older server: the server's now); a re-claim looks up to its
      // first commit.
      const until = turn.checkUntil ?? new Date(now() + (offset?.min ?? 0)).toISOString()
      const window = { since: turn.checkSince, until, sinceCommit: turn.sinceCommit ?? null, upto: turn.checkedCommit ?? point.commit, offset }
      const files = await deps.newFiles(companyRoot, turn.check.path, window).catch(() => null)
      return files === null || files === 'not-synced' ? files : { kind: 'files', files }
    }
    return null
  }

  /** The run is still this app's: not taken away (renew 409) and still registered for the consultation's tokens. */
  const live = (h: Held) => !h.lost && h.hold !== null && deps.holds(h.companyId, h.occurrenceId, h.hold)

  /** Copies an earlier launch left (the app quit mid-run) are nobody's now: removed once, before this launch makes any. */
  let leftCopies: Promise<void> | null = null
  /** Companies whose lost answers are being looked at now; when each record was last asked about (not again for a while). */
  const reconciling = new Set<string>()
  const askedAt = new Map<string, number>()

  /**
   * A set watch before its AI (4b-4 PR5, B2): the department folders here (4-T11), the gate (§5-0: failed → `gate_failed`, never
   * Claude instead), the pinned copy of both Skills (I9; not here → tried later), and the run's Skill's reasons from the copy (the
   * same `decision.json` the server pinned).
   */
  async function prepareSet(companyId: string, occurrenceId: string, generation: number, turn: QueuedJobTurn, companyRoot: string | null): Promise<{ set: HeldSet; procedure: string } | 'not-here' | 'procedure' | 'gate-failed'> {
    const fs = deps.setWatch
    const p = turn.procedure
    const meetingId = turn.source?.meetingId
    if (!fs || p.source !== 'department_skill' || !meetingId) return 'procedure'
    const write = turn.grant.writes.area === 'deliverable' ? { place: turn.grant.writes.place, folder: turn.grant.writes.folder } : null
    const places = [...new Set([p.place, ...(turn.grant.reads.skills ?? []).map(s => s.place), ...(write ? [write.place] : [])])]
    for (const place of places) if (!(await fs.departmentHere(companyRoot, place))) return 'not-here'
    const judged = await (deps.gate ?? CLAUDE_IN_RUN_GATE).judge().catch(() => 'failed' as const)
    if (judged !== 'in_run') return 'gate-failed'
    const copy = await fs.makeCopy(companyId, occurrenceId, generation, companyRoot, [p, ...(turn.grant.reads.skills ?? [])])
    if (!copy) return 'procedure'
    const procedure = await fs.readCopyFile(copy, 0, 'SKILL.md')
    const decisionText = await fs.readCopyFile(copy, 0, 'decision.json')
    const decision = decisionText === null ? null : parseJobDecisionFile(decisionText)
    if (procedure === null || decision === null) {
      await fs.removeCopy(copy)
      return 'procedure'
    }
    const due = new Date(Date.parse(turn.dueAt))
    const day = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
    return {
      procedure,
      set: { companyRoot, meetingId, generation, place: write?.place ?? p.place, folder: write?.folder ?? '', copy, decision, day, run: null, minutes: null, minutesDocVersion: null, updatesWarned: false, recordFailed: false, queue: Promise.resolve() },
    }
  }

  /**
   * A set watch's area (B2): writes only in the run folder made for this claim (none before it is made: `run` is read live, so the
   * guard built at the turn's start sees the folder once `proposal_folder` made it); reads the grant's places, the whole
   * `<place>/.personal/<folder>/` (earlier proposals, read only), and the pinned copy outside the company folder.
   */
  function setWriteArea(set: HeldSet, grant: JobGrant): JobWriteArea {
    const base = `${set.place}/.personal/${set.folder}`
    if (grant.writes.area !== 'deliverable') return { nowhere: true, reads: [...grant.reads.paths], readOutside: set.copy.dir }
    return {
      place: set.place, folder: set.folder, reads: [...grant.reads.paths, base], readOutside: set.copy.dir,
      get run() { return set.run?.name ?? null },
    }
  }

  /**
   * The PC records whose completion's answer was lost (B2 ④): the server's run says which generation finished it. Another
   * generation (a re-claim, another PC) → `not_adopted`; this one done → `sent`. Known gap: a 「もう一度」 pressed after the lost
   * answer closes this generation as done too — the server does not say which finish it took yet.
   */
  async function reconcileSending(companyId: string): Promise<void> {
    const fs = deps.setWatch
    if (!fs) return
    // Not the same records every pass: one asked within `RECONCILE_AGAIN_MS` waits (five stuck ones never hold the rest back).
    const due = (await fs.sendingRecords(companyId, 200).catch(() => [] as SetRunRecord[]))
      .filter(rec => !byOccurrence.has(keyOf(companyId, rec.occurrenceId)) && now() - (askedAt.get(`${companyId}\n${rec.runId}.${rec.generation}`) ?? -Infinity) >= RECONCILE_AGAIN_MS)
      .slice(0, 5)
    for (const rec of due) {
      askedAt.set(`${companyId}\n${rec.runId}.${rec.generation}`, now())
      const r = await deps.session(companyId, 'GET', `/ai-runs/${encodeURIComponent(rec.runId)}`).catch(() => null)
      if (!r || r.status !== 200) continue
      const data = r.data as { run?: { state?: unknown; generation?: unknown } } | undefined
      const run = data?.run
      if (!run || typeof run.generation !== 'number') continue
      // Another generation finished or holds it → not this record's; done at this generation → sent; given back or waiting for
      // a person at this generation → this completion never landed (`refused`). Running / waiting to be reconciled: not yet known.
      const state = run.generation > rec.generation ? 'not_adopted'
        : run.generation === rec.generation && run.state === 'done' ? 'sent'
        : run.generation === rec.generation && ['open', 'retry_later', 'waiting_person', 'waiting_setup'].includes(String(run.state)) ? 'refused'
        : null
      if (state) await fs.writeRecord(companyId, { ...rec, state }).catch(() => false)
    }
  }

  return {
    /** The occurrences this app can run now; not readable (offline, an older server) → the last list. */
    async turns(companyId: string): Promise<QueuedJobTurn[]> {
      if (deps.setWatch) await (leftCopies ??= deps.setWatch.removeLeftCopies())
      // Stage 4b-2: this app runs event occurrences too (`?kinds=` — absent, a server lists time slots only; a server
      // before stage 4-0 ignores it and lists time slots).
      // 4b-4 PR5: a set watch's turn is listed only to an app naming its check (`?checks=matched_record`), and only an app that
      // runs it here (its file work given) names it.
      const r = await deps.session(companyId, 'GET', `/me/job-turns?kinds=${JOB_KINDS_RUN.join(',')}${deps.setWatch ? `&checks=${JOB_SET_CHECK_KIND}` : ''}`)
      // Lost answers are looked at only while the server answers, never in the listing's way (one pass at a time).
      if (r?.status === 200 && deps.setWatch && !reconciling.has(companyId)) {
        reconciling.add(companyId)
        void reconcileSending(companyId).finally(() => reconciling.delete(companyId))
      }
      const turns = r?.status === 200 ? parseJobTurns(r.data) : null
      if (turns === null) return [...(listed.get(companyId)?.values() ?? [])]
      const ids = new Set(turns.map(t => t.occurrenceId))
      for (const id of listed.get(companyId)?.keys() ?? []) if (!ids.has(id)) fetchMarks.delete(keyOf(companyId, id))
      listed.set(companyId, new Map(turns.map(t => [t.occurrenceId, t])))
      return turns
    },

    /** Whether the runner's id is a job occurrence this app listed (claims.ts routes the claim here). */
    isJob(companyId: string, id: string): boolean {
      return isOccurrenceId(id) && !!listed.get(companyId)?.has(id)
    },

    /**
     * Claim the occurrence's run for this consultation, run the check, read the pinned procedure. The common
     * refusals (window, agent, emergency stop, stop policy) are claims.ts's, made before this is asked.
     */
    async claim(companyId: string, occurrenceId: string, conversationId: string, companyRoot: string | null): Promise<AiTurnClaimResult> {
      const listedTurn = listed.get(companyId)?.get(occurrenceId)
      if (!listedTurn) return { claimed: false, reason: 'not-allowed' }
      // New files: this PC must have what the server has before anything is claimed (else tried later), and the
      // claim names the commit the check looks up to (the next occurrence starts after it).
      let point: { commit: string | null } | null = null
      if (listedTurn.check.kind === 'new_files') {
        // The mark is taken once, at the first check — after the server listed the occurrence, so a fetch after it
        // holds everything up to the window's end. That first check is therefore never synced: it waits for a fetch.
        const key = keyOf(companyId, occurrenceId)
        if (!fetchMarks.has(key)) {
          const mark = await deps.fetchMark(companyRoot, listedTurn.check.path).catch(() => null)
          if (mark !== null) fetchMarks.set(key, mark)
        }
        const p = await deps.checkPoint(companyRoot, listedTurn.check.path, fetchMarks.get(key) ?? null).catch(() => null)
        if (p === 'not-synced') return { claimed: false, reason: 'unavailable', retryAfterMs: NOT_SYNCED_RETRY_MS }
        point = p
      }
      const sentAt = now()
      const sentAtStamp = deps.clockStamp()
      // An event occurrence's claim names the kind and its check (the two locks of jobs.md "Old apps never run it"); a time
      // slot's claim stays as every earlier app sent it (only a server that listed an event ever gets `kinds`).
      const event = listedTurn.kind === 'event'
      // A set watch is claimed only by an app that runs it here (its check named: the server's lock, jobs.md "The set watch").
      if (listedTurn.set && !deps.setWatch) return { claimed: false, reason: 'not-allowed' }
      const answer = await deps.session(companyId, 'POST', '/job-run-claims', {
        occurrenceId, deviceId: deps.deviceId, conversationId, checks: [...JOB_PC_CHECK_KINDS, ...(event ? JOB_EVENT_CHECK_KINDS : []), ...(listedTurn.set ? [JOB_SET_CHECK_KIND] : [])],
        ...(event ? { kinds: [...JOB_KINDS_RUN] } : {}), ...(point?.commit ? { checkedCommit: point.commit } : {}),
      })
      if (!answer || answer.status >= 500) return { claimed: false, reason: 'unavailable' }
      // Waiting behind an earlier occurrence of the job: not taken — asked again a little later (it stays listed).
      if (answer.status === 409 && answer.code === 'JOB_EARLIER_RUNNING') return { claimed: false, reason: 'unavailable', retryAfterMs: EARLIER_RUNNING_RETRY_MS }
      const data = answer.status < 300 ? answer.data as { run?: { id?: unknown; generation?: unknown; createdAt?: unknown; updatedAt?: unknown }; turn?: unknown } | undefined : undefined
      const run = data?.run
      // The turn as the claim answered it (the meetings found are only there): the server's, not the list's.
      const turn = parseJobTurn(data?.turn)
      if (!run || typeof run.id !== 'string' || typeof run.generation !== 'number') {
        unlist(companyId, occurrenceId)
        return { claimed: false, reason: 'taken' }
      }
      const key = keyOf(companyId, occurrenceId)
      const claimedAt = now()
      // The server's clock against this PC's, from the claim's own stamp (made between sending and the answer).
      const serverMs = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null)
      const serverNow = serverMs(run.updatedAt)
      const offset: ClockOffset | null = serverNow !== null ? { min: serverNow - claimedAt, max: serverNow - sentAt } : null
      const held: Held = { companyId, occurrenceId, runId: run.id, access: { allowsRecordTool: () => false, builtinTools: [] }, area: { nowhere: true, reads: [] }, reported: null, timedOut: false, lost: false, timer: null, hold: null }
      // Taken away by the server (a pause, the company's stop, the time limit, another PC, a condition of an event that
      // failed), or not confirmed by it for too long (fail closed): the AI stops here too.
      held.hold = deps.hold(companyId, occurrenceId, conversationId, { id: run.id, generation: run.generation }, () => {
        held.lost = true
        if (byConversation.get(conversationId) === held) deps.stopTurn(conversationId)
      }, { confirmedAt: sentAtStamp })
      const giveUp = async (failure: Failure): Promise<AiTurnClaimResult> => {
        // Only this claim's own hold is given back (a later claim's hold of the same run is not this one's to finish).
        if (live(held)) await deps.finishRun(companyId, occurrenceId, failure)
        return { claimed: false, reason: 'unavailable' }
      }
      if (!turn || turn.occurrenceId !== occurrenceId || turn.kind !== listedTurn.kind || turn.set !== listedTurn.set) return giveUp({ class: 'bad-input', code: 'TURN_NOT_READABLE' })
      // The check, before any AI (D6).
      const found = await findings(turn, companyRoot, point, offset)
      if (found === null) return giveUp({ class: 'bad-input', code: 'CHECK_NOT_POSSIBLE' })
      // This PC's clock not known to agree with the server's: tried again later (a person is told if it stays so).
      if (found === 'clock') return giveUp({ class: 'temporary', code: 'CLOCK_NOT_TRUSTED' })
      // Not synced since the window's end: a colleague's file may not be here yet — never `nothing` on a guess.
      if (found === 'not-synced') {
        if (live(held)) await deps.finishRun(companyId, occurrenceId, { class: 'temporary', code: 'NOT_SYNCED' })
        return { claimed: false, reason: 'unavailable', retryAfterMs: NOT_SYNCED_RETRY_MS }
      }
      if (found.kind !== 'record' && (found.kind === 'files' ? found.files.length : found.meetings.length) === 0) {
        if (!live(held)) return { claimed: false, reason: 'unavailable' }
        const r = await deps.finishRun(companyId, occurrenceId, null, { jobResult: 'nothing' })
        if (!r || r.status >= 300) log.warn(`[jobs] finish (nothing): answered ${r?.status ?? 'nothing'}`)
        unlist(companyId, occurrenceId)
        return { claimed: false, reason: 'taken' }
      }
      // A set watch (4b-4 PR5): the checks before starting, the judging gate, the pinned copy and its reasons.
      let set: HeldSet | null = null
      let procedure: string | null
      if (turn.set) {
        const prepared = await prepareSet(companyId, occurrenceId, run.generation, turn, companyRoot)
        if (prepared === 'not-here') return giveUp({ class: 'bad-input', code: 'DEPARTMENT_NOT_HERE' })
        if (prepared === 'procedure') return giveUp({ class: 'temporary', code: 'PROCEDURE_NOT_HERE' })
        if (prepared === 'gate-failed') {
          // The gate could not judge (§5-0): no draft, no file check, never Claude instead — `gate_failed` alone, after the
          // PC record (B2 ③ before ④).
          if (!live(held)) return { claimed: false, reason: 'unavailable' }
          const record: SetRunRecord = { v: 1, occurrenceId, runId: run.id, generation: run.generation, state: 'sending', folder: null, decision: 'gate_failed', at: new Date(now()).toISOString() }
          if (!(await deps.setWatch!.writeRecord(companyId, record))) return giveUp({ class: 'temporary', code: 'PC_RECORD_NOT_KEPT' })
          const r = await deps.finishRun(companyId, occurrenceId, null, { jobResult: { decision: 'gate_failed' } })
          if (r) await deps.setWatch!.writeRecord(companyId, { ...record, state: r.status < 300 ? 'sent' : 'refused' })
          unlist(companyId, occurrenceId)
          return { claimed: false, reason: 'taken' }
        }
        set = prepared.set
        procedure = prepared.procedure
      } else {
        const p = turn.procedure
        procedure = p.source === 'company_skill'
          ? await deps.readCompanySkill(companyId, p.skill, p.fingerprint, companyRoot).catch(() => null)
          : p.source === 'shelf_skill' ? await deps.readShelfSkill(companyId, p.item, p.skill, p.fingerprint).catch(() => null) : null
      }
      // Not on this PC yet (not synced, the shelf unreachable): tried again later.
      if (procedure === null) return giveUp({ class: 'temporary', code: 'PROCEDURE_NOT_HERE' })
      const dropSet = () => { if (set) void deps.setWatch?.removeCopy(set.copy) }
      // The approved minutes count from the run's first claim, on the server's clock; on this PC's clock that is
      // shifted by how far the two differ — taken at the request's departure (`offset.max`), so the answer's travel
      // time never moves the end later.
      const started = serverMs(run.createdAt)
      const skew = offset !== null ? -offset.max : 0
      const deadlineMs = (started ?? claimedAt - skew) + skew + turn.grant.limits.minutes * 60_000
      const left = deadlineMs - JOB_STOP_BEFORE_MS - now()
      if (left <= 0) { dropSet(); return giveUp({ class: 'bad-input', code: 'TIME_LIMIT' }) }
      held.access = jobToolAccess(turn.grant, turn.check, turn.deliverTo)
      held.area = set ? setWriteArea(set, turn.grant) : jobWriteArea(turn.grant)
      if (set) held.set = set
      held.timer = setTimeout(() => {
        held.timedOut = true
        if (byConversation.get(conversationId) === held) deps.stopTurn(conversationId)
      }, left)
      held.timer.unref?.()
      // Taken away while the check or the procedure was being read: nothing starts (the run is the server's again).
      if (!live(held)) {
        clearTimeout(held.timer)
        dropSet()
        return { claimed: false, reason: 'unavailable' }
      }
      // The last check right before the AI starts (stage 4b-2): the server confirms the run once more — a renew, which
      // also checks an event's conditions. Refused → the run is lost (nothing starts); not answered → given back, tried
      // later (never started on an old confirmation).
      if (!(await deps.confirm(companyId, occurrenceId, held.hold as HoldHandle)) || !live(held)) {
        clearTimeout(held.timer)
        dropSet()
        if (live(held)) return giveUp({ class: 'temporary', code: 'NOT_CONFIRMED' })
        return { claimed: false, reason: 'unavailable' }
      }
      // The stop time came while the server was being asked (its timer could stop nothing yet): never started after the
      // cutoff — finished as the time limit, as when too little was left before the claim.
      if (held.timedOut || deadlineMs - JOB_STOP_BEFORE_MS - now() <= 0) {
        clearTimeout(held.timer)
        dropSet()
        return giveUp({ class: 'bad-input', code: 'TIME_LIMIT' })
      }
      byConversation.set(conversationId, held)
      byOccurrence.set(key, conversationId)
      const deadline = new Date(deadlineMs - JOB_STOP_BEFORE_MS)
      const deadlineText = `${deadline.getHours()}:${String(deadline.getMinutes()).padStart(2, '0')}`
      if (set && turn.source?.meetingId) {
        return {
          claimed: true, version: null,
          message: setWatchFirstMessage({
            name: turn.name, recordId: turn.source.recordId, meetingId: turn.source.meetingId, procedure, copyDir: set.copy.dir,
            skills: set.copy.skills, reasons: set.decision.reasons, base: `${set.place}/.personal/${set.folder}`, deadline: deadlineText,
          }),
        }
      }
      return {
        claimed: true, version: null,
        message: jobFirstMessage({ name: turn.name, found, procedure, grant: turn.grant, deadline: `${deadline.getHours()}:${String(deadline.getMinutes()).padStart(2, '0')}`, deliverTo: turn.deliverTo, madeBefore: turn.madeBefore, madeBeforeTotal: turn.madeBeforeTotal }),
      }
    },

    /** The ceiling of a job run's consultation this app holds (the chat server asks it); null for anything else. */
    toolsOf(conversationId: string, step: string): JobToolAccess | null {
      const h = byConversation.get(conversationId)
      // No live run (taken away, released): no ceiling, so the chat server refuses the turn — never an ordinary one.
      // Past its stop time (also when the stop came before the turn was tracked, so it stopped nothing): no ceiling, and
      // the chat server's re-check after tracking stops the turn (review of 4b-2).
      return h && step === JOB_PC_STEP && live(h) && !h.timedOut ? h.access : null
    },

    /** Where a job run's consultation may write; null when it is not one. */
    writeAreaOf(conversationId: string): JobWriteArea | null {
      return byConversation.get(conversationId)?.area ?? null
    },

    /**
     * The run's `job_report` (only for a consultation this app holds a job run for): the run is finished right
     * there with the title, so the AI's answer is the server's — the やること made, or refused (the run was taken
     * away meanwhile: a pause, the stop, the time), which the tool says plainly so the AI never claims it.
     */
    reporter(conversationId: string): ((result: unknown) => Promise<string | null>) | null {
      const h = byConversation.get(conversationId)
      // A set watch's run reports through its own tools (`setTools`), never this one.
      if (!h || h.set) return null
      return async (result: unknown) => {
        const parsed = parseJobRunResult(result)
        if (parsed === null || parsed === 'nothing') return 'title は1行・80文字まで、summary は300文字までにしてください。'
        if (h.reported !== null) return h.reported === 'done' ? null : JOB_REPORT_REFUSED
        const r = h.lost ? null : await deps.finishRun(h.companyId, h.occurrenceId, null, { jobResult: parsed })
        h.reported = r && r.status < 300 ? 'done' : 'refused'
        if (h.timer) clearTimeout(h.timer)
        return h.reported === 'done' ? null : JOB_REPORT_REFUSED
      }
    },

    /**
     * A set watch's run (4b-4 PR5): its `proposal_folder` and `job_report`, only for the consultation main holds the run for; null
     * for any other (`set-watch-tools.ts` makes the tools).
     */
    setHandlers(conversationId: string): SetHandlers | null {
      const h = byConversation.get(conversationId)
      const set = h?.set
      if (!h || !set) return null
      const fs = deps.setWatch as SetWatchFs
      const base = (state: SetRunRecord['state']): SetRunRecord => ({ v: 1, occurrenceId: h.occurrenceId, runId: h.runId, generation: set.generation, state, folder: set.run?.rel ?? null, at: new Date(now()).toISOString() })
      // One call at a time (two at once could make two folders, or finish twice).
      const serial = <T>(work: () => Promise<T>): Promise<T> => {
        const next = set.queue.then(work, work)
        set.queue = next.then(() => undefined, () => undefined)
        return next
      }
      return {
        folder: (company: string, meetingDate?: string) => serial(async () => {
          if (h.reported !== null || !live(h)) return { error: JOB_REPORT_REFUSED }
          if (!('place' in h.area)) return { error: 'この定期の仕事では、ファイルを保存できません。提案書は作らず、job_report で decline を渡して終えてください。' }
          // One folder per claim: asked again, the same one.
          if (set.run) return { folder: set.run.rel }
          const day = meetingDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(meetingDate) ? meetingDate : set.day
          const name = runFolderName(day, company)
          if (!name) return { error: 'meetingDate は YYYY-MM-DD にしてください。' }
          const made = await fs.makeRunFolder(set.companyRoot, set.place, set.folder, name, { occurrenceId: h.occurrenceId, runId: h.runId, generation: set.generation })
          if (!made) return { error: 'この実行のフォルダを作れませんでした。ファイルは作らず、job_report も呼ばずに、そのまま終えてください（あとでもう一度動きます）。' }
          set.run = made
          // 「途中」 until a report: a run that stops here leaves this record (B2, 6-2).
          await fs.writeRecord(h.companyId, base('working')).catch(() => false)
          return { folder: made.rel }
        }),
        report: (input: unknown) => serial(async () => {
          if (h.reported !== null) return h.reported === 'done' ? null : JOB_REPORT_REFUSED
          if (!live(h)) { h.reported = 'refused'; return JOB_REPORT_REFUSED }
          if (set.recordFailed) return SET_RECORD_NOT_KEPT
          const parsed = parseSetReportInput(input, set.decision)
          if ('error' in parsed) return parsed.error
          // ① the quotes against the minutes this run read (I7).
          const missing = quotesNotInMinutes(parsed.evidence, set.minutes)
          if (missing.length > 0) {
            return set.minutes === null
              ? 'evidence を付けるときは、先に minutes_read でこの会議の議事録を読んでください。'
              : `evidence の quote ${missing.length}件が議事録に見つかりません。議事録の文を、言い換えずにそのまま写してください。`
          }
          const decision = parsed.report.decision
          if (decision !== 'decline' && !set.run) return 'proposal_folder でこの実行のフォルダを作り、そこにファイルを置いてから job_report を呼んでください。'
          // ② the draft's files there, and its images copied.
          let images: string[] = []
          if (decision !== 'decline') {
            const run = set.run as RunFolder
            const absent = await fs.missingDraftFiles(run)
            if (absent.length > 0) return `この実行のフォルダに ${absent.join('・')} がありません。作ってから、もう一度 job_report を呼んでください。`
            const copied = await fs.copyDraftImages(run, set.copy)
            if (copied === null) return 'この実行のフォルダの assets に画像を置けませんでした。assets というファイルやリンクを作らずに、もう一度 job_report を呼んでください。'
            images = copied
          }
          // The update proposals (§G, S9): counted by the app from the one file, only when it is the fixed shape. Told once to fix
          // a file that is not; asked again, the run ends with none counted (never a broken file counted).
          let updates = 0
          let updatesFile: SetRunRecord['updatesFile'] = 'none'
          if (set.run) {
            const text = await fs.readRunFile(set.run, SET_WATCH_UPDATES_FILE, SET_WATCH_UPDATES_FILE_MAX)
            if (text !== null) {
              const proposals = text === 'invalid' ? { problem: 'ふつうのファイルで、64KB までにしてください。' } : parseUpdateProposals(text, set.meetingId, set.minutes)
              if ('problem' in proposals) {
                if (!set.updatesWarned) {
                  set.updatesWarned = true
                  return `${SET_WATCH_UPDATES_FILE} の形が正しくありません（${proposals.problem}）。直すか消してから、もう一度 job_report を呼んでください。直せないときは、そのままもう一度呼ぶと、更新案なしとして終えます。`
                }
                updatesFile = 'invalid'
              } else {
                updates = proposals.items.length
                updatesFile = 'valid'
              }
            }
          }
          // ③ the PC record, kept and read back — or nothing is sent.
          const record: SetRunRecord = {
            ...base('sending'), decision, reason: parsed.report.reason, confidence: parsed.report.confidence,
            unconfirmed: [...parsed.report.unconfirmed], updates, updatesFile, evidence: parsed.evidence, images,
            minutesDocVersion: set.minutesDocVersion,
          }
          if (!(await fs.writeRecord(h.companyId, record))) {
            set.recordFailed = true
            return SET_RECORD_NOT_KEPT
          }
          // Taken away while the files were checked: nothing is sent, and the record says so (never left `sending`).
          if (!live(h)) {
            h.reported = 'refused'
            await fs.writeRecord(h.companyId, { ...record, state: 'refused' }).catch(() => false)
            return JOB_REPORT_REFUSED
          }
          // ④ then the completion: fixed kinds only (no quote, company or folder).
          const r = await deps.finishRun(h.companyId, h.occurrenceId, null, { jobResult: setJobResult(parsed, updates) })
          h.reported = r && r.status < 300 ? 'done' : 'refused'
          // A lost answer (no answer at all) stays `sending`: asked about later (`reconcileSending`).
          if (r) await fs.writeRecord(h.companyId, { ...record, state: r.status < 300 ? 'sent' : 'refused' }).catch(() => false)
          if (h.timer) clearTimeout(h.timer)
          await fs.removeCopy(set.copy)
          return h.reported === 'done' ? null : JOB_REPORT_REFUSED
        }),
      }
    },

    /** The minutes a job run's consultation read (`minutes_read`): a set watch keeps its pinned meeting's to check quotes (I7). */
    minutesRead(conversationId: string, recordId: string, text: string, docVersion: string | null = null): void {
      const set = byConversation.get(conversationId)?.set
      if (!set || recordId !== set.meetingId || typeof text !== 'string') return
      set.minutes = text
      // The version of the documents this run read (T7: 「案を作った後に議事録が直されています」 compares it); not said → null.
      set.minutesDocVersion = typeof docVersion === 'string' && docVersion.length > 0 && docVersion.length <= 200 ? docVersion : null
    },

    /** After the turn: done with the reported title, or a failure (the server decides where it goes). */
    async settle(companyId: string, occurrenceId: string): Promise<AiTurnSettleResult> {
      const conversationId = byOccurrence.get(keyOf(companyId, occurrenceId))
      const h = conversationId ? byConversation.get(conversationId) : undefined
      if (!h || !conversationId) return { outcome: 'unknown' }
      forget(conversationId)
      unlist(companyId, occurrenceId)
      if (h.set) void deps.setWatch?.removeCopy(h.set.copy)
      // A set watch whose record could not be kept: nothing was sent — given back, tried again later (B2 ③).
      if (h.set?.recordFailed && h.reported === null && !h.lost) {
        await deps.finishRun(companyId, occurrenceId, { class: 'temporary', code: 'PC_RECORD_NOT_KEPT' })
        return { outcome: 'put-back' }
      }
      // Finished at its report: done when the server made the やること; refused (paused, stopped, the time) → the
      // person looks and the consultation stays open.
      if (h.reported !== null) return { outcome: h.reported === 'done' ? 'done' : 'failed' }
      if (h.lost) {
        await deps.finishRun(companyId, occurrenceId, { class: 'temporary', code: 'RUN_LOST' })
        return { outcome: 'failed' }
      }
      // Stopped at its time limit without a report: a person looks (needs_person); otherwise tried again later.
      await deps.finishRun(companyId, occurrenceId, h.timedOut ? { class: 'bad-input', code: 'TIME_LIMIT' } : { class: 'temporary', code: 'UNFINISHED' })
      return { outcome: h.timedOut ? 'failed' : 'put-back' }
    },
  }
}

export type JobRuns = ReturnType<typeof createJobRuns>

/** A set watch run's two tools, as main answers them (`set-watch-tools.ts`). */
export interface SetHandlers {
  folder(company: string, meetingDate?: string): Promise<{ folder: string } | { error: string }>
  /** null: the completion was sent and taken; else the sentence the AI acts on. */
  report(input: unknown): Promise<string | null>
}

/** At most this many files a check lists (the rest is not needed to know there is something). */
const NEW_FILES_MAX = 200
const SKIP = new Set(['.git', '.backups', '.workspace', '.personal', 'node_modules'])

/** Whether this PC's clock is known to be within `JOB_CLOCK_TOLERANCE_MS` of the server's (its whole range). */
export function clockTrusted(offset: ClockOffset | null): offset is ClockOffset {
  // NaN and ±Infinity fail the comparisons below by themselves.
  return offset !== null && offset.min <= offset.max && Math.max(Math.abs(offset.min), Math.abs(offset.max)) <= JOB_CLOCK_TOLERANCE_MS
}

/**
 * Files changed under `place` in [since, until) — the server's instants — in a working folder (no shared company
 * folder), by their modification time. This PC's clock stamped that time, so it is read on the server's clock through
 * `offset` and a file counts whenever it may fall in the window (the measured range widens it: never missed for the
 * request's travel time; one on the edge may be seen by two occurrences). The start is moved back by a further
 * `JOB_CLOCK_TOLERANCE_MS`: a file stamped while this PC's clock was off by less than that, and corrected since, is
 * shown to two occurrences rather than to none. `root` is the working folder (validated by the caller); null when the
 * place is not on this PC or the clocks are not known to agree (`clockTrusted`).
 */
export async function newFilesByTime(root: string, place: string, since: string, until: string, offset: ClockOffset | null): Promise<string[] | null> {
  if (!clockTrusted(offset)) return null
  const found = await placeOnDisk(root, place)
  if (found === null) return null
  const start = found.real
  // On this PC's clock: a file stamped m was written at a server time within [m + min, m + max].
  const sinceMs = Date.parse(since) - offset.max - JOB_CLOCK_TOLERANCE_MS
  const untilMs = Date.parse(until) - offset.min
  const out: string[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= NEW_FILES_MAX || depth > 10) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= NEW_FILES_MAX) return
      if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(full, childRel, depth + 1)
      else if (entry.isFile()) {
        const s = await stat(full).catch(() => null)
        if (s && s.mtimeMs >= sinceMs && s.mtimeMs < untilMs) out.push(childRel)
      }
    }
  }
  await walk(start, place, 0)
  return out
}

type Git = (cwd: string, args: string[]) => Promise<string>
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The place's repository (the company's, or a private folder's clone above it), found by its on-disk spelling. */
async function repoOf(root: string, place: string): Promise<{ repo: string; relInRepo: string; repoPrefix: string } | null> {
  const found = await placeOnDisk(root, place)
  if (!found) return null
  // Walk up from where the place really is, so an NFD or case spelling on disk never misses a clone's `.git`.
  let repo = found.root
  for (let dir = found.real; dir.length > found.root.length; dir = path.dirname(dir)) {
    if (await stat(path.join(dir, '.git')).catch(() => null)) { repo = dir; break }
  }
  return {
    repo,
    relInRepo: path.relative(repo, found.real).split(path.sep).join('/') || '.',
    repoPrefix: path.relative(found.root, repo).split(path.sep).join('/').normalize('NFC'),
  }
}

/** No `FETCH_HEAD` yet (never fetched): any fetch after this mark changes it. */
const NEVER_FETCHED = 'none'

/**
 * `FETCH_HEAD`'s identity in the repository: device, inode, size and its times to the nanosecond. git rewrites the
 * file on every fetch — also one that brings nothing new —, so any fetch changes it; it is only ever compared for
 * equality, never against a clock. `NEVER_FETCHED` when there is none; null when it cannot be read.
 */
async function fetchHeadMark(git: Git, repo: string): Promise<string | null> {
  const fetchHead = await git(repo, ['rev-parse', '--git-path', 'FETCH_HEAD']).then(p => p.trim()).catch(() => null)
  if (!fetchHead) return null
  try {
    const s = await stat(path.resolve(repo, fetchHead), { bigint: true })
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? NEVER_FETCHED : null
  }
}

/** The place's repository's fetch identity now (`fetchHeadMark`); null when the place is not on this PC or unreadable. */
export async function gitFetchMark(git: Git, root: string, place: string): Promise<string | null> {
  const r = await repoOf(root, place)
  return r ? fetchHeadMark(git, r.repo) : null
}

/**
 * Before a `new_files` check in the shared folder is claimed: this PC has what the server has — fetched since `mark`
 * was taken (after the server listed the occurrence): `FETCH_HEAD`'s identity differs from it — no clock is read, so
 * a PC clock set back or forward can neither make an old fetch pass nor hold a new one back; no mark (unknown) is
 * never synced — **and** the server's tip in `HEAD` (`merge-base --is-ancestor`: a fetch-only path or a sync stopped
 * on a conflict leaves it out) — and the commit it will look up to (`HEAD`). `not-synced`: tried later, never
 * `nothing` on a guess. null: the place is not on this PC (not downloaded, a link).
 */
export async function gitCheckPoint(git: Git, root: string, place: string, mark: string | null): Promise<{ commit: string } | null | 'not-synced'> {
  const r = await repoOf(root, place)
  if (!r) return null
  const current = await fetchHeadMark(git, r.repo)
  if (mark === null || current === null || current === NEVER_FETCHED || current === mark) return 'not-synced'
  const tip = await git(r.repo, ['rev-parse', '--verify', '-q', '@{upstream}']).then(t => t.trim()).catch(() => null)
    ?? await git(r.repo, ['rev-parse', '--verify', '-q', 'FETCH_HEAD']).then(t => t.trim()).catch(() => null)
  if (!tip) return 'not-synced'
  const merged = await git(r.repo, ['merge-base', '--is-ancestor', tip, 'HEAD']).then(() => true, () => false)
  if (!merged) return 'not-synced'
  const head = await git(r.repo, ['rev-parse', '--verify', 'HEAD']).then(t => t.trim()).catch(() => null)
  return head && COMMIT_RE.test(head) ? { commit: head } : null
}

/**
 * Files added under `place` in the shared company folder, by what is reachable, never by commit dates (an old-dated
 * commit that reaches the server late is still new): added in `sinceCommit..upto` (the previous occurrence's commit
 * up to this one's). Without a known `sinceCommit` (the first occurrence, another repository): added up to `upto`
 * after `since`. null when the place is not on this PC; `not-synced` when `upto` is not here.
 */
export async function newFilesByGit(git: Git, root: string, place: string, window: { since: string; sinceCommit: string | null; upto: string }): Promise<string[] | null | 'not-synced'> {
  const r = await repoOf(root, place)
  if (!r || !COMMIT_RE.test(window.upto)) return null
  const has = (c: string) => git(r.repo, ['cat-file', '-e', `${c}^{commit}`]).then(() => true, () => false)
  if (!(await has(window.upto))) return 'not-synced'
  const from = window.sinceCommit && COMMIT_RE.test(window.sinceCommit) && await has(window.sinceCommit)
    && await git(r.repo, ['merge-base', '--is-ancestor', window.sinceCommit, window.upto]).then(() => true, () => false)
    ? window.sinceCommit : null
  const range = from ? [`${from}..${window.upto}`] : [`--since=${new Date(Date.parse(window.since)).toISOString()}`, window.upto]
  const outText = await git(r.repo, ['log', ...range, '--diff-filter=A', '--name-only', '--format=', '-z', '--', r.relInRepo]).catch(() => null)
  if (outText === null) return null
  const files = [...new Set(outText.split('\0').map(x => x.trim()).filter(Boolean))]
  return files.slice(0, NEW_FILES_MAX).map(f => (r.repoPrefix ? `${r.repoPrefix}/${f}` : f))
}

/**
 * The place as a folder on this PC, or null: a valid company path, a folder, and **no link on the way** — its real
 * location is exactly the place inside the company folder's real location (a link committed at the place, or above
 * it, could otherwise list another company's files or reach another repository). Compared as the disk folds names
 * (`diskKey`).
 */
async function placeOnDisk(root: string, place: string): Promise<{ root: string; real: string } | null> {
  if (jobPathProblem(place) !== null) return null
  const realRoot = await realpath(root).catch(() => null)
  if (!realRoot) return null
  const target = path.join(realRoot, ...place.split('/'))
  const real = await realpath(target).catch(() => null)
  if (!real || diskKey(real) !== diskKey(target)) return null
  return (await stat(real).catch(() => null))?.isDirectory() ? { root: realRoot, real } : null
}
