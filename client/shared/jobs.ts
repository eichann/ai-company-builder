import { JOB_SET_WATCH_SCHEMA, isSetTrigger, parseJobDefinition, jobSetFeedbackFits, knownJobDefinition, occurrenceTaskId, type JobDefinition, type JobOccurrenceState, type JobSetFeedbackKind, type JobPauseReason, type JobPlacement, type JobRetryBlock, type JobState, type JobTrigger } from '../../shared/core/jobs'
import type { JobSetReportView, JobWaiting } from '../../shared/types/jobs'

/**
 * Settings → 「定期の仕事」 (jobs.md "The screens", PR 4): the scheduled jobs the member is the responsible
 * person of, read with their session in main (IPC `jobs:*`) — what waits for their 「受け取る」 and their
 * own pause / resume. The server decides every rule (who accepts, which pause is theirs to lift).
 */

/**
 * The definition shapes **this app** shows and accepts in 「定期の仕事」 (stage 4b-0.5, owner memo 「段4b 設計メモ」 §5-1): what
 * every job request announces (`X-ACB-Job-Schemas`, `electron/features/jobs/ipc.ts`), never the shared parser's
 * `JOB_SCHEMAS` — a later core may read a shape (4b-1's `schema: 3`) before this app can show it, and the server must
 * then neither hand it its definition nor take its 受け取る. Each one's words are checked by
 * `client/tests/job-screen-schemas.test.ts`. `3` since stage 4b-2 (an event run by this PC's AI), in the same build
 * that runs it (fail closed, the event claim's locks: `electron/features/ai-turns/job-runs.ts`).
 * `4` since member proposals' PR C (a member's proposal: schema 1's words, its card and 「受け取る」 in this app; `jobs.md`
 * "Member proposals" "The app (PR C)"). `5` since 4b-4 PR6b (a set watch: this build runs it — PR5's runner, which names
 * `matched_record` —, shows its 受け取る words — PR6 — and lets the member propose one, jobs.md "A set watch from the app").
 */
export const APP_JOB_SCHEMAS: readonly number[] = [1, 2, 3, 4, 5]

/**
 * A definition this app shows: a shape the core knows and this app announces; anything else is shown as hidden. A set watch
 * (schema 5, 4b-4 PR6) is read by its trigger's kind — the core's `knownJobDefinition` answers time and record triggers only
 * — and only once this app announces 5: its 受け取る words are here since PR6, the announcement is made in the build that
 * runs it (PR5's runner; until then the server answers such a version without its definition, `needsUpdate`).
 */
export function appReadsJobDefinition(d: unknown, schemas: readonly number[] = APP_JOB_SCHEMAS): JobDefinition | null {
  const known = knownJobDefinition(d) ?? (isSetWatchDefinition(d) && parseJobDefinition(d).ok ? d : null)
  return known !== null && schemas.includes(known.schema) ? known : null
}

/** A schema-5 definition (a set watch): the shape the set watch's words take. */
export function isSetWatchDefinition(d: unknown): d is JobDefinition {
  return !!d && typeof d === 'object' && (d as { schema?: unknown }).schema === JOB_SET_WATCH_SCHEMA && isSetTrigger((d as { trigger?: unknown }).trigger)
}

/** The server answers jobs without who the member is to them (a build before PR 4): nothing can be shown honestly. */
export const JOBS_SERVER_TOO_OLD_TEXT = 'サーバーの更新が必要です。会社のサーバーが新しくなると、ここに定期の仕事が出ます。'

export const JOBS_OFFLINE_TEXT = 'サーバーに接続できないため、いまは定期の仕事を読み込めません（オフラインの可能性があります）。'

/** One job the member is responsible for, as the app shows it. */
export interface MyJob {
  id: string
  /** The approved version's name (else the newest's); 「定期の仕事」 when a place it names is not the member's to read (the server's rule). */
  name: string
  state: JobState
  waiting: JobWaiting
  pausedReason: JobPauseReason | null
  trigger: JobTrigger | null
  /** `a`: on the responsible person's PC — does not run before PR 5. */
  placement: JobPlacement | null
  nextSlot: string | null
  /**
   * The approved version waiting for the member's 「受け取る」, or null. `definition` null: it names a place
   * the member cannot read now (the server would refuse the acceptance too). `why`: `accept` — not accepted
   * yet; `place` — accepted, but the deliverable place they chose can no longer be used (a Drive folder pick
   * past its 90 days): 「受け取る」 again chooses it anew.
   */
  toAccept: { version: number; fingerprint: string | null; definition: JobDefinition | null; why: 'accept' | 'place' } | null
  /**
   * The deliverable place outside (the server's `deliverTo`): its kind's words, whether one was chosen and is
   * usable now; its name and when the pick ends (only the responsible person's own). null: none.
   */
  deliverTo: { label: string; chosen: boolean; usable: boolean; name: string | null; expiresAt: string | null } | null
  /** The member runs it (the approved version names them): they may pause it, and resume their own pause. */
  controls: boolean
  /**
   * Stage 4a ①: an event job whose chain of watched records stopped — why, as the server words it for the member. null:
   * it goes on, or it is not an event job. The member (its responsible person) chooses the next watched やること.
   */
  chainStopped: { why: string } | null
  /** The approved version's number (the one 「選び直す」 acts on), or null. */
  approvedVersion: number | null
}

/** `jobs:watchChoices`: the member's open やること (title only), the first page of what matches. */
export type WatchChoicesResult = { success: true; choices: Array<{ id: string; title: string }>; total: number } | JobsFailure

export type JobsFailure = { success: false; offline: boolean; code: string | null; error: string }

/** `jobs:mine`. */
export type MyJobsResult = { success: true; jobs: MyJob[] } | JobsFailure
/** `jobs:accept` / `jobs:pause` / `jobs:resume`. */
export type JobActionResult = { success: true } | JobsFailure

/**
 * What opening a job's notice in the bell does (they are about a job, not a record): 「受け取りが要ります」 opens
 * this section (it goes to the responsible person alone); an occurrence's notice (`job_expired` …) also
 * reaches the job's creator, who may run nothing here, so it opens nothing — its text says what happened.
 * null: not a job's notice.
 */
export function jobNoticeTarget(kind: string): 'jobs' | 'none' | null {
  // A stopped chain (stage 4a): the responsible person chooses the next watched やること there.
  if (kind === 'job_accept_needed' || kind === 'job_chain_stopped') return 'jobs'
  // A set watch's 見送る (4b-4 PR6): its ［作ってもらう］ is in 「定期の仕事」's 「会議のあとの AI の判断」 (no やること was made).
  if (kind === 'job_set_declined') return 'jobs'
  // A member's proposal returned (member proposals): the proposer sees its state in their list of proposals there.
  if (kind === 'job_proposal_returned') return 'jobs'
  // A proposal waiting for an owner / admin: decided in the admin console, nothing to press here.
  if (kind === 'job_proposal') return 'none'
  // `company_restored` (deployment.md "After a restore"): about the jobs and the AI stopped; its text says what to check.
  if (kind === 'job_expired' || kind === 'job_skipped' || kind === 'job_failed' || kind === 'job_paused' || kind === 'company_restored') return 'none'
  // A browser operation's site changed shape (agent-browser.md "The strict read's notice"): its text says what to check.
  if (kind === 'browser_shape_changed') return 'none'
  return null
}

/**
 * One occurrence of an event job this PC's AI ran for the member (stage 4b-2, owner memo 「段4b 設計メモ」 §4-3 / D11; `GET
 * /me/job-occurrences`, the server's `MyJobOccurrenceView`): what the server returns and nothing derived — `retry` and
 * `unknownOperations` only where the member's rights cover them (the server leaves them out otherwise). `name` is the
 * name of the version they ran (「定期の仕事」 when it names a place they cannot read now).
 */
export interface MyJobOccurrence {
  id: string
  jobId: string
  name: string
  dueSlot: string
  /** null: a state this app does not know (a later server's). */
  state: JobOccurrenceState | null
  outcomeCode: string | null
  /** `why`: a `JobRetryBlock`, or `UNKNOWN` for a reason this app does not know (`jobRetryBlockText` says it in generic words). */
  retry: { allowed: true } | { allowed: false; why: JobRetryBlock | 'UNKNOWN' } | null
  unknownOperations: Array<{ key: string; kind: string }>
  madeBefore: Array<{ kind: string; count: number }>
  /**
   * A set watch's judgement (4b-4 PR3's `report`), on the member's own view only while the occurrence is theirs to see: the
   * fixed kinds as answered (one with a decision this app does not know is left out), never a quote or a title.
   * Absent: not a set watch, no judgement yet, an older server.
   */
  report?: JobSetReportView
}

/**
 * What the app offers on a set watch's judgement (owner memo 「4b-4 挟む部分」 H-10, S2 / S11): ［確かめて完了］ on its やること
 * (進める / 人に聞く / 判断できなかった, and 見送る with update proposals — never done for the member, S11 #2), ［まだ早かった］ where the
 * server takes `too_early` and the member did not say 仕上げた — also once recorded, while its やること is still open (a press whose
 * correction was kept but whose やること was not taken away can be pressed again: the server answers `recorded: false`), ［作ってもらう］ where it takes `made_anyway` (見送る) and — with no correction to record — after a
 * judgement that failed (S2 J5). Decided from the answered kinds only; the server checks each press again.
 */
export interface SetWatchOffer {
  confirmDone: boolean
  tooEarly: boolean
  makeAnyway: boolean
  /** ［作ってもらう］ also records `made_anyway` (only after 見送る: nothing corrects a gate that failed). */
  makeAnywayRecords: boolean
}

export function setWatchOffer(report: JobSetReportView): SetWatchOffer {
  const fits = (k: JobSetFeedbackKind) => jobSetFeedbackFits(k, report.decision)
  const sent = (k: JobSetFeedbackKind) => report.feedback.includes(k)
  // Every judgement makes the やること but a 見送る with no update proposals (PR3b's `setWatchMakesTask`).
  const madeTask = report.decision !== 'decline' || (report.updates ?? 0) > 0
  return {
    confirmDone: madeTask,
    tooEarly: fits('too_early') && !sent('went_ahead'),
    makeAnyway: (fits('made_anyway') && !sent('made_anyway')) || report.decision === 'gate_failed',
    makeAnywayRecords: fits('made_anyway'),
  }
}

/** The set watch's occurrence whose やること this is (its id is the occurrence's, `occurrenceTaskId`), with a judgement; else null. */
export function setWatchOccurrenceOf(occurrences: readonly MyJobOccurrence[], taskId: string): (MyJobOccurrence & { report: JobSetReportView }) | null {
  for (const o of occurrences) {
    if (!o.report) continue
    let id: string
    try { id = occurrenceTaskId(o.id) } catch { continue }
    if (id === taskId) return o as MyJobOccurrence & { report: JobSetReportView }
  }
  return null
}

/** Ids of a やること an occurrence made (`task-` + the occurrence's 32 hex): only these can be a set watch's. */
export const OCCURRENCE_TASK_ID_RE = /^task-[0-9a-f]{32}$/

/**
 * 「議事録が直された」 (memo S1 T7, S11 #8): the minutes' `docVersion` the run read against the one now. `edited` only when both
 * are known and differ; `unknown` when the run's is known but today's cannot be read — never said as unchanged; `none` when the
 * run kept none (a build before PR5's run record: nothing is said).
 */
export function minutesEditedMark(versions: JobRunMinutesVersions | null | undefined): 'edited' | 'same' | 'unknown' | 'none' {
  if (!versions || versions.read === null) return 'none'
  if (versions.now === null) return 'unknown'
  return versions.read === versions.now ? 'same' : 'edited'
}

/**
 * What PR5's runner keeps of a set watch's run on this PC (the smallest interface PR6 needs, filled by PR5): the minutes'
 * `docVersion` the run read, and the one now (null: not known).
 */
export interface JobRunMinutesVersions {
  read: string | null
  now: string | null
}

/** `jobs:feedback`: a correction of a set watch's judgement (`recorded: false` = it was there already). */
export type JobFeedbackResult = { success: true; recorded: boolean } | JobsFailure

/** `jobs:occurrences`. `supported: false`: a server before stage 4b-1 (nothing to show, said as nothing). */
export type MyJobOccurrencesResult = { success: true; supported: boolean; occurrences: MyJobOccurrence[] } | JobsFailure

/** 「後始末」's question for an outside operation whose result nobody knows, in plain words. */
export const JOB_RECONCILE_ASK = 'が作られたか分かりません。あなたの「送るもの」や置き先で確かめて、どちらかを押してください。押しても、この回は動き出しません。'
