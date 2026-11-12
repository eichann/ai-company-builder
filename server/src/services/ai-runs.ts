/**
 * Execution runs of 「AI の番」 (stage 2 S10b, `.claude/rules/records.md`
 * "Execution runs"; owner decision 2026-11-01). The AI never runs on the
 * server: the member's app runs it and this service only stores and checks.
 *
 * - **Claim** (one per record × step at a time): an app instance claims the
 *   run for a while (`AI_RUN_CLAIM_TTL_MS`) and renews it while running. Each
 *   claim raises the run's **generation**; the AI's record token is bound to
 *   a run and a generation, and once the run is claimed again every call with
 *   the older generation is refused (`fence`, used by record-ai-tokens).
 * - **Idempotency key per outside operation** (`keyed`): the first call with a
 *   key runs and its result is kept (what it made, never the bodies); the same
 *   key again answers what it made without running anything. A key is never
 *   reused for another request (the request's fingerprint).
 * - **「結果が分からない」**: an operation whose answer was lost (a 5xx, an
 *   outside write `sent-unknown`, or still in flight when the claim was taken
 *   over) is `unknown`; while one is, the run cannot be resumed — a person
 *   reconciles it first (`reconcile`).
 * - **Failures go to their own place** (`finish`): temporary → retried later
 *   (a few times, then a person), missing permission → waiting for setup,
 *   bad input → waiting for a person, unknown result → waiting for
 *   reconciliation. Never silently back to 「AI の番」: the last three wait for
 *   a person's 「もう一度」 (`retry`).
 * - **What a run works on** (`run.subject`, B PR 2): `POST /ai-run-claims` always makes a record's run, and a PC
 *   job's claim (`claimOccurrence`, B PR 5a) an occurrence's — one claim core (`claimSubject`); what
 *   belongs to records (the list the app reads, binding a record token, the built-in steps' route
 *   scope) is reached only by a `record` run. Every state change is kept in `ai_run_events` (`event`).
 */
import {
  AI_RUN_CLAIM_TTL_MS, AI_RUN_FAILURE_CLASSES, AI_RUN_PERSON_STATES, AI_RUN_STATE_LABELS, AI_RUN_STEP_RE, AI_RUN_TEMPORARY_LIMIT,
  DEVICE_ID_RE, FAILURE_CODE_RE, OPERATION_KEY_RE, failureDestination, parseAiRunProcedure, retryDelayMs, type AiRunFailureClass, type AiRunProcedure,
} from '../../shared/core/ai-runs'
import { parseClientVersion } from '../../shared/core/client-version'
import { aiTurnRouteAllowed } from '../../shared/core/ai-turn-routes'
import { aiTurnRouteScopeApplies } from '../lib/client-version'
import { notInStep } from './not-in-step'
import type { PluginStepProcedurePin } from '../../shared/core/plugins'
import { RECORD_ID_RE } from '../../shared/core/records'
import { JOB_PC_STEP, isOccurrenceId } from '../../shared/core/jobs'
import type { AiRunView } from '../../shared/types/ai-runs'
import type { AgentStopPolicy, AgentStopToolKind } from '../../shared/types/agent-stop'
import type { AiRunEventRow, AiRunOperationRow, AiRunRepository, AiRunRow } from '../ports/ai-runs'
import type { RunSubject, RunSubjects } from '../ports/run-subjects'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { Transactions } from '../ports/transactions'
import type { Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface AiRunDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  transactions: Transactions
  /** sha256 (hex): a request's fingerprint. */
  tokenDigest: TokenDigest
  /**
   * What a run works on (ports/run-subjects.ts): whether its step is the member's 「AI の番」, what it
   * is pinned to, and what its step does after it ends. Records only today (services/run-subjects.ts).
   */
  subjects: RunSubjects<Refusal>
  /** The emergency stop in force for this member (everyone's stops and their own: agent-stops.ts `policyFor`). */
  aiStops: (member: Member) => AgentStopPolicy
}

/** Who sends an outside operation within a run: the holder of a run-bound record token. */
export interface RunBoundCaller {
  companyId: string
  userId: string
  runId: string
  generation: number
}

/** An HTTP answer as the route built it (status + JSON body). */
export interface KeyedAnswer { status: number; body: unknown }

const RUN_NOT_FOUND = { error: '実行の記録が見つかりません', code: 'RUN_NOT_FOUND' }
export const RUN_SUPERSEDED = {
  error: 'この実行はほかの PC が引き受け直したか、もう終わっています。ここからの続きは書き込めません。', code: 'RUN_SUPERSEDED',
}
const RUN_CLAIMED = { error: 'ほかの PC が進めています', code: 'RUN_CLAIMED' }
const RUN_NEEDS_RECONCILE = { error: '外への操作の結果が分からないものがあります。確かめてから続きを進めます。', code: 'RUN_NEEDS_RECONCILE' }
const RUN_WAITING = { error: '人の確認を待っています。「もう一度」を押すと AI が続きを進めます。', code: 'RUN_WAITING' }
/**
 * The emergency stop and runs with nobody present (agent-stop.md "Runs with no person present").
 * A claim is refused by the whole AI and by each kind an unattended run can reach — a plugin step's
 * files in its deliverable folder (`write`), `web_research` (`web`), outside services through
 * connectors and plugin operations (`mcp-external`). Not `command`: no unattended run has a shell
 * (ai-turns.md). A running run's token is refused by the whole AI only (`runStopped`).
 * 503: a released app reads a claim's 5xx as 「今は無理」 (claims.ts → `unavailable`, tried again
 * later), where a 4xx would mark the record taken at that version; a record call's 5xx is a tool failure.
 */
const STOPS_UNATTENDED_RUN: readonly AgentStopToolKind[] = ['write', 'web', 'mcp-external']
/** The emergency stop in force covers a run with nobody present (the claim's check; a job's 「もう一度」 asks it too). */
export function unattendedRunStopped(stop: AgentStopPolicy): boolean {
  return stop.all || stop.tools.some(kind => STOPS_UNATTENDED_RUN.includes(kind))
}
export const AI_RUN_STOPPED = {
  error: '管理者が AI の利用を一時停止しています。再開されるまで AI の番は進みません。', code: 'AI_STOPPED',
}
const CONTROL = /[\u0000-\u001f\u007f]/ // eslint-disable-line no-control-regex

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v)

/** The request as one text (method, path, body with sorted keys): what a key is bound to. */
function requestText(method: string, path: string, body: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
  return `${method} ${path}\n${JSON.stringify(canonical(body) ?? null)}`
}

/** What an answer made (`ref`) and whether it is known to have had an effect. */
function outcomeOf(answer: KeyedAnswer): { state: 'done' | 'unknown' | 'none'; ref: { kind: string; id: string } | null } {
  if (answer.status >= 500) return { state: 'unknown', ref: null }
  if (answer.status < 200 || answer.status >= 300) return { state: 'none', ref: null }
  const data = isObj(answer.body) && isObj(answer.body.data) ? answer.body.data : {}
  const idOf = (v: unknown) => (isObj(v) && typeof v.id === 'string' ? v.id : null)
  const op = idOf(data.operation)
  if (op) {
    const state = (data.operation as Record<string, unknown>).state
    // A plugin's outside write: failed = known not applied; sent-unknown = may have been applied.
    if (state === 'failed') return { state: 'none', ref: null }
    return { state: state === 'sent-unknown' ? 'unknown' : 'done', ref: { kind: 'plugin-operation', id: op } }
  }
  const put = isObj(data.drivePut) ? data.drivePut : null
  if (put && typeof put.id === 'string') {
    // A Google Drive put (google-drive.md): unknown = sent, answer lost, not found yet.
    return { state: put.state === 'unknown' || put.state === 'sending' ? 'unknown' : 'done', ref: { kind: 'drive-put', id: put.id } }
  }
  for (const [field, kind] of [['approval', 'approval'], ['draft', 'outbound'], ['record', 'record']] as const) {
    const id = idOf(data[field])
    if (id) return { state: 'done', ref: { kind, id } }
  }
  return { state: 'done', ref: null }
}

export function createAiRunService(deps: AiRunDeps) {
  const { companyData, clock, ids, transactions, subjects } = deps
  const repo = (companyId: string): AiRunRepository => companyData.forCompany(companyId).aiRuns
  const nowIso = (ms: number) => new Date(ms).toISOString()

  function view(r: AiRunRepository, run: AiRunRow): AiRunView {
    const operations = r.operations(run.id)
    return {
      // `recordId` is the contract's (released apps match on it): a record run's id, nothing for another kind.
      id: run.id, recordId: run.subject.kind === 'record' ? run.subject.id : '', subject: { kind: run.subject.kind, id: run.subject.id }, step: run.step, state: run.state, label: AI_RUN_STATE_LABELS[run.state], generation: run.generation,
      deviceId: run.deviceId, conversationId: run.conversationId, claimExpiresAt: run.claimExpiresAt,
      failure: run.failureClass ? { class: run.failureClass, code: run.failureCode } : null,
      retryAt: run.retryAt, attempts: run.attempts, pluginVersion: run.pluginVersion, stepsVersion: run.stepsVersion,
      procedure: parseAiRunProcedure(run.procedure),
      needsPerson: AI_RUN_PERSON_STATES.includes(run.state),
      operations: operations.map(o => ({
        key: o.key, kind: o.kind, state: o.state, ref: o.refKind && o.refId ? { kind: o.refKind, id: o.refId } : null, updatedAt: o.updatedAt,
      })),
      createdAt: run.createdAt, updatedAt: run.updatedAt,
    }
  }

  /**
   * Which procedure a claim runs (records.md "Which procedure"): the step, the app build that
   * sent the claim (its X-ACB-Client-Version, kept only when it parses) and the plugins turned
   * on for the company now — read here, never taken from the app.
   */
  function procedureOf(companyId: string, step: string, appBuild: string | null | undefined, pin: PluginStepProcedurePin | null, job?: AiRunProcedure['job']): AiRunProcedure {
    const plugins = companyData.forCompany(companyId).plugins.installs()
      .filter(i => i.enabled).map(i => ({ id: i.pluginId, version: i.version })).sort((a, b) => a.id.localeCompare(b.id))
    return { step, app: parseClientVersion(appBuild)?.raw.slice(0, 120) ?? null, plugins, ...(pin ? { pin } : {}), ...(job ? { job } : {}) }
  }

  /** A subject's in-transaction refusal: thrown to roll the transaction back, then answered. */
  class SubjectRefused extends Error {
    constructor(readonly refusal: Refusal) { super('refused by the run subject'); this.name = 'SubjectRefused' }
  }
  function subjectRefusal<T>(work: () => Outcome<T>): Outcome<T> {
    try { return work() } catch (e) { if (e instanceof SubjectRefused) return e.refusal; throw e }
  }
  const liveRun = (run: AiRunRow) => ({ id: run.id, subject: run.subject, step: run.step, userId: run.userId, state: run.state })

  /** The member's own run (anyone else's, another company's or a missing one: the same 404). */
  function ownRun(member: Member, runId: string): { r: AiRunRepository; run: AiRunRow } | Refusal {
    const r = repo(member.companyId)
    const run = typeof runId === 'string' && runId.length <= 100 ? r.byId(runId) : null
    if (!run || run.userId !== member.userId) return refuse('not-found', RUN_NOT_FOUND.error, { code: RUN_NOT_FOUND.code })
    return { r, run }
  }

  const unsettled = (ops: AiRunOperationRow[]) => ops.filter(o => o.state === 'unknown' || o.state === 'in_progress')

  /** Operations still in flight when a claim ends are unknown from now on (their answer may never come). */
  function inFlightToUnknown(r: AiRunRepository, run: AiRunRow, at: string): void {
    for (const o of r.operations(run.id)) if (o.state === 'in_progress') r.updateOperation(run.id, o.key, ['in_progress'], { state: 'unknown' }, at)
  }

  function save(r: AiRunRepository, before: AiRunRow, after: AiRunRow): boolean {
    return r.update(after, { generation: before.generation, state: before.state })
  }

  /** Fencing: a run-bound token's calls go through only while its generation is the run's and the run is claimed. */
  function fence(companyId: string, userId: string, runId: string, generation: number): boolean {
    const run = repo(companyId).byId(runId)
    return run !== null && run.userId === userId && run.state === 'running' && run.generation === generation
  }

  /** What a person's 「もう一度」 leaves: claimable, the failure forgotten; the run's operations (idempotency keys) stay. */
  const givenBack = (run: AiRunRow, at: string): AiRunRow => ({
    ...run, state: 'open', deviceId: null, claimExpiresAt: null, attempts: 0, failureClass: null, failureCode: null, retryAt: null, updatedAt: at,
  })

  function claimStopped(member: Member): Refusal | null {
    if (!unattendedRunStopped(deps.aiStops(member))) return null
    return refuse('unavailable', AI_RUN_STOPPED.error, { code: AI_RUN_STOPPED.code })
  }

  function generationOf(body: unknown): number | null {
    const g = isObj(body) ? body.generation : undefined
    return typeof g === 'number' && Number.isInteger(g) && g >= 1 ? g : null
  }

  /**
   * A state change of the run, in the same synchronous stretch (or transaction) as the change itself
   * (`ai_run_events`): short codes only.
   */
  function event(r: AiRunRepository, run: AiRunRow, e: Pick<AiRunEventRow, 'event' | 'code'> & { stateAfter?: AiRunRow['state'] | null }, at: string): void {
    r.appendEvent({ runId: run.id, event: e.event, generation: run.generation, stateAfter: e.stateAfter === undefined ? run.state : e.stateAfter, code: e.code, at })
  }

  /**
   * The emergency stop refused something of this run: kept once per generation, not once per call — the app
   * asks again every pass (claims) and on every tool call (tokens), so a long stop would grow the table.
   */
  function stoppedOnce(r: AiRunRepository, run: AiRunRow, at: string): void {
    const last = r.lastEvent(run.id)
    if (last?.event === 'refused_stopped' && last.generation === run.generation) return
    event(r, run, { event: 'refused_stopped', code: AI_RUN_STOPPED.code, stateAfter: null }, at)
  }

  /**
   * The claim of one subject's step (a record's, or a job occurrence's): one app instance wins; a re-claim
   * raises the generation. Refused (503 `AI_STOPPED`) while the emergency stop covers the member
   * (`STOPS_UNATTENDED_RUN`), before anything is read; whose turn it is and what it is pinned to is the
   * subject's (`subjects.resolve`), and the subject takes the run in the same transaction (`claimed`).
   */
  async function claimSubject(
    member: Member, subject: RunSubject, step: string, deviceId: string, conversationId: string, appBuild: string | null | undefined,
    reported: { pluginVersion: string | null; stepsVersion: string | null },
  ): Promise<Outcome<{ run: AiRunView; created: boolean }>> {
    // Before the turn check and the pin: a stopped AI's claim reads no record, makes and pins nothing.
    const stopped = claimStopped(member)
    if (stopped) {
      // The member's own open run of that step, if one waits to be resumed, keeps that it was refused.
      const r = repo(member.companyId)
      const waiting = r.openRun(subject, step)
      if (waiting && waiting.userId === member.userId) stoppedOnce(r, waiting, clock.now())
      return stopped
    }
    // Whose turn, and the procedure the work runs (pinned at its first run; the operator's stop refuses there).
    // A core step answers at once: its turn check and the write below stay in one synchronous stretch, as before.
    const answer = subjects.resolve(member, subject, step)
    const resolved = answer instanceof Promise ? await answer : answer
    if (!resolved.ok) return resolved
    const { pin, job } = resolved.value

    const r = repo(member.companyId)
    const nowMs = clock.nowMs()
    const at = nowIso(nowMs)
    const expires = nowIso(nowMs + AI_RUN_CLAIM_TTL_MS)
    const versions = { ...reported, procedure: JSON.stringify(procedureOf(member.companyId, step, appBuild, pin, job)) }
    const taken = (run: AiRunRow) => {
      const refused = subjects.claimed?.(member, liveRun(run), subject) ?? null
      if (refused) throw new SubjectRefused(refused)
    }
    return subjectRefusal(() => transactions.run((): Outcome<{ run: AiRunView; created: boolean }> => {
      // One run per record (ai-turns.md "One claim per record"): another step's live claim on the same
      // record — a core step and a business plugin's, say — refuses this one. The answer names neither
      // that run nor its step (it may be another member's).
      if (r.liveOtherStep(subject, step, at)) return refuse('conflict', RUN_CLAIMED.error, { code: RUN_CLAIMED.code })
      const open = r.openRun(subject, step)
      if (!open) {
        const run: AiRunRow = {
          id: ids.newId(), subject, step, userId: member.userId, state: 'running', generation: 1, deviceId, conversationId,
          claimExpiresAt: expires, failureClass: null, failureCode: null, retryAt: null, attempts: 0, ...versions,
          createdAt: at, updatedAt: at, closedAt: null,
        }
        r.insert(run)
        event(r, run, { event: 'claimed', code: null }, at)
        taken(run)
        return ok({ run: view(r, run), created: true })
      }
      const live = open.state === 'running' && open.claimExpiresAt !== null && Date.parse(open.claimExpiresAt) > nowMs
      if (live && open.deviceId !== deviceId) return refuse('conflict', RUN_CLAIMED.error, { code: RUN_CLAIMED.code, run: view(r, open) })
      if (open.state === 'waiting_reconcile') return refuse('conflict', RUN_NEEDS_RECONCILE.error, { code: RUN_NEEDS_RECONCILE.code, run: view(r, open) })
      if (open.state === 'waiting_setup' || open.state === 'waiting_person'
        || (open.state === 'retry_later' && open.retryAt !== null && Date.parse(open.retryAt) > nowMs)) {
        return refuse('conflict', RUN_WAITING.error, { code: RUN_WAITING.code, run: view(r, open) })
      }
      // Taking it over: whatever the previous holder had in flight is unknown, and blocks resuming.
      inFlightToUnknown(r, open, at)
      if (unsettled(r.operations(open.id)).length > 0) {
        const waiting: AiRunRow = { ...open, state: 'waiting_reconcile', deviceId: null, claimExpiresAt: null, failureClass: 'unknown-result', failureCode: 'RESULT_UNKNOWN', updatedAt: at }
        if (save(r, open, waiting)) event(r, waiting, { event: 'claimed', code: 'RESULT_UNKNOWN' }, at)
        return refuse('conflict', RUN_NEEDS_RECONCILE.error, { code: RUN_NEEDS_RECONCILE.code, run: view(r, waiting) })
      }
      const run: AiRunRow = {
        ...open, userId: member.userId, state: 'running', generation: open.generation + 1, deviceId, conversationId,
        claimExpiresAt: expires, retryAt: null, ...versions, updatedAt: at,
      }
      if (!save(r, open, run)) return refuse('conflict', RUN_CLAIMED.error, { code: RUN_CLAIMED.code })
      event(r, run, { event: 'claimed', code: null }, at)
      taken(run)
      return ok({ run: view(r, run), created: false })
    }))
  }

  /** A person says whether an operation of unknown result happened; with nothing unknown left, a run waiting for it is `open`. */
  function reconcileRun(r: AiRunRepository, run: AiRunRow, key: string, done: boolean, byUserId: string): Outcome<{ run: AiRunView }> {
    const op = OPERATION_KEY_RE.test(key) ? r.operation(run.id, key) : null
    if (!op) return refuse('not-found', '操作が見つかりません', { code: 'OPERATION_NOT_FOUND' })
    const at = clock.now()
    return transactions.run((): Outcome<{ run: AiRunView }> => {
      if (!r.updateOperation(run.id, key, ['unknown'], { state: done ? 'done' : 'not_done', reconciledBy: byUserId }, at)) {
        return refuse('conflict', 'この操作は結果の確かめを待っていません', { code: 'OPERATION_NOT_UNKNOWN' })
      }
      let current = run
      if (run.state === 'waiting_reconcile' && unsettled(r.operations(run.id)).length === 0) {
        const next: AiRunRow = { ...run, state: 'open', failureClass: null, failureCode: null, updatedAt: at }
        if (save(r, run, next)) current = next
      }
      event(r, current, { event: 'reconciled', code: done ? 'DONE' : 'NOT_DONE' }, at)
      return ok({ run: view(r, current) })
    })
  }

  return {
    /**
     * POST …/ai-run-claims — one app instance wins; a re-claim raises the generation.
     * Whether the step is the member's 「AI の番」 and what it is pinned to is the subject's
     * (`subjects.resolve`: a core step, or a business plugin's step `<pluginId>__<step>` at its
     * state, running the procedure its work is pinned to).
     * Refused (503 `AI_STOPPED`) while the emergency stop covers the member (`STOPS_UNATTENDED_RUN`).
     */
    async claim(member: Member, body: unknown, appBuild?: string | null): Promise<Outcome<{ run: AiRunView; created: boolean }>> {
      if (!isObj(body)) return refuse('bad-request', 'Body must be a JSON object')
      const { recordId, step, deviceId, conversationId, pluginVersion, stepsVersion } = body
      if (typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return refuse('bad-request', 'recordId is a record id')
      if (typeof step !== 'string' || !AI_RUN_STEP_RE.test(step)) return refuse('bad-request', 'step is a short name')
      if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return refuse('bad-request', 'deviceId is 8–100 letters, digits, _ or -')
      if (!shortText(conversationId, 200)) return refuse('bad-request', 'conversationId is required (1–200 characters)')
      for (const v of [pluginVersion, stepsVersion]) {
        if (v !== undefined && !shortText(v, 60)) return refuse('bad-request', 'pluginVersion / stepsVersion are short texts')
      }
      // The claim of the app's 「AI の番」 is always a record's (B PR 2): the body's shape never changes.
      return claimSubject(member, { kind: 'record', id: recordId }, step, deviceId, conversationId as string, appBuild, {
        pluginVersion: (pluginVersion as string | undefined) ?? null, stepsVersion: (stepsVersion as string | undefined) ?? null,
      })
    },

    /**
     * POST …/job-run-claims { occurrenceId, deviceId, conversationId, checks } (B PR 5a): the responsible person's
     * app claims a PC job's occurrence — the same run core as a record's claim (the emergency stop's 503 first,
     * generations, one open run per subject, fencing), with step `job-procedure`. Whether it is theirs to run
     * now is the occurrence's resolver (services/job-runs.ts), which also refuses one whose check kind is not
     * among `checks` (B PR 5a-2: what this app can run; absent = none).
     */
    async claimOccurrence(member: Member, body: unknown, appBuild?: string | null): Promise<Outcome<{ run: AiRunView; created: boolean }>> {
      if (!isObj(body)) return refuse('bad-request', 'Body must be a JSON object')
      const { occurrenceId, deviceId, conversationId, checks, checkedCommit } = body
      if (!Object.keys(body).every(k => ['occurrenceId', 'deviceId', 'conversationId', 'checks', 'checkedCommit'].includes(k))) return refuse('bad-request', 'Body is { occurrenceId, deviceId, conversationId, checks, checkedCommit? }')
      if (checkedCommit !== undefined && (typeof checkedCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(checkedCommit))) return refuse('bad-request', 'checkedCommit is a commit id')
      if (!isOccurrenceId(occurrenceId)) return refuse('bad-request', 'occurrenceId is an occurrence id')
      if (checks !== undefined && (!Array.isArray(checks) || checks.length > 10 || !checks.every(k => typeof k === 'string' && /^[a-z_]{1,40}$/.test(k)))) return refuse('bad-request', 'checks is a list of check kinds')
      if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return refuse('bad-request', 'deviceId is 8–100 letters, digits, _ or -')
      if (!shortText(conversationId, 200)) return refuse('bad-request', 'conversationId is required (1–200 characters)')
      return claimSubject(member, { kind: 'occurrence', id: occurrenceId, checks: (checks as string[] | undefined) ?? [], ...(typeof checkedCommit === 'string' ? { checkedCommit } : {}) }, JOB_PC_STEP, deviceId, conversationId, appBuild, { pluginVersion: null, stepsVersion: null })
    },

    /** POST …/ai-runs/:runId/renew { generation } — the holder extends its claim. */
    renew(member: Member, runId: string, body: unknown): Outcome<{ run: AiRunView }> {
      const own = ownRun(member, runId)
      if ('ok' in own) return own
      const generation = generationOf(body)
      if (generation === null) return refuse('bad-request', 'generation is a whole number ≥ 1')
      const { r, run } = own
      if (run.state !== 'running' || run.generation !== generation) return refuse('conflict', RUN_SUPERSEDED.error, { code: RUN_SUPERSEDED.code })
      // Not refused while stopped: the run's token is (`runStopped`). A lease left to run out would let another
      // PC or step claim the record the moment the stop is released, while this PC still holds the run.
      const at = clock.nowMs()
      const next: AiRunRow = { ...run, claimExpiresAt: nowIso(at + AI_RUN_CLAIM_TTL_MS), updatedAt: nowIso(at) }
      if (!save(r, run, next)) return refuse('conflict', RUN_SUPERSEDED.error, { code: RUN_SUPERSEDED.code })
      return ok({ run: view(r, next) })
    },

    /** POST …/ai-runs/:runId/finish — done, or failed with a class that decides where it goes. */
    finish(member: Member, runId: string, body: unknown): Outcome<{ run: AiRunView }> {
      const own = ownRun(member, runId)
      if ('ok' in own) return own
      const generation = generationOf(body)
      if (generation === null) return refuse('bad-request', 'generation is a whole number ≥ 1')
      const b = body as Record<string, unknown>
      if (b.outcome !== 'done' && b.outcome !== 'failed') return refuse('bad-request', 'outcome is done or failed')
      let cls: AiRunFailureClass | null = null
      let code: string | null = null
      if (b.outcome === 'failed') {
        const f = b.failure
        if (!isObj(f) || !AI_RUN_FAILURE_CLASSES.includes(f.class as AiRunFailureClass)) {
          return refuse('bad-request', `failure.class is one of ${AI_RUN_FAILURE_CLASSES.join(', ')}`)
        }
        if (f.code !== undefined && (typeof f.code !== 'string' || !FAILURE_CODE_RE.test(f.code))) return refuse('bad-request', 'failure.code is a short code (A-Z, 0-9, _)')
        cls = f.class as AiRunFailureClass
        code = (f.code as string | undefined) ?? null
      }
      const { r, run } = own
      // What a PC job's run hands back (B PR 5a) is for that kind of run only.
      if (b.jobResult !== undefined && run.subject.kind === 'record') return refuse('bad-request', 'jobResult is for a job’s run only')
      if (run.state !== 'running' || run.generation !== generation) return refuse('conflict', RUN_SUPERSEDED.error, { code: RUN_SUPERSEDED.code })
      // The subject may refuse it first (a PC job's run past its approved minutes: it ends the run itself).
      const before = subjects.beforeFinish?.(member, liveRun(run), b) ?? null
      if (before) return before
      const nowMs = clock.nowMs()
      const at = nowIso(nowMs)
      const finished = subjectRefusal(() => transactions.run((): Outcome<{ run: AiRunView }> => {
        inFlightToUnknown(r, run, at)
        const released = { ...run, deviceId: null, claimExpiresAt: null, updatedAt: at }
        let next: AiRunRow
        if (unsettled(r.operations(run.id)).length > 0) {
          // Whatever the app says, an outside result nobody knows blocks the run until a person reconciles it.
          next = { ...released, state: 'waiting_reconcile', failureClass: 'unknown-result', failureCode: code ?? 'RESULT_UNKNOWN' }
        } else if (cls === null) {
          next = { ...released, state: 'done', failureClass: null, failureCode: null, retryAt: null, closedAt: at }
        } else if (cls === 'temporary') {
          const attempts = run.attempts + 1
          next = attempts >= AI_RUN_TEMPORARY_LIMIT
            ? { ...released, state: 'waiting_person', attempts, failureClass: 'temporary', failureCode: 'REPEATED_TEMPORARY', retryAt: null }
            : { ...released, state: 'retry_later', attempts, failureClass: 'temporary', failureCode: code, retryAt: nowIso(nowMs + retryDelayMs(attempts)) }
        } else {
          next = { ...released, state: failureDestination(cls), failureClass: cls, failureCode: code, retryAt: null }
        }
        if (!save(r, run, next)) return refuse('conflict', RUN_SUPERSEDED.error, { code: RUN_SUPERSEDED.code })
        event(r, next, { event: 'finished', code: next.failureCode }, at)
        // The subject's part, all or nothing with the finish (a job's occurrence and its one やること).
        const refused = subjects.finishing?.(member, liveRun(next), b) ?? null
        if (refused) throw new SubjectRefused(refused)
        return ok({ run: view(r, next) })
      }))
      if (finished.ok && finished.value.run.state === 'done') {
        try { subjects.afterDone(member, { id: run.id, subject: run.subject, step: run.step, createdAt: run.createdAt }) } catch { /* asked again by the next meeting */ }
      }
      if (finished.ok && cls !== null) {
        try { subjects.afterFailed(member, { id: run.id, subject: run.subject, step: run.step, createdAt: run.createdAt }) } catch { /* the 30-minute rule catches up */ }
      }
      return finished
    },

    /** POST …/ai-runs/:runId/retry — 「もう一度」: a person gives a stopped run back to the AI. */
    retry(member: Member, runId: string): Outcome<{ run: AiRunView }> {
      const own = ownRun(member, runId)
      if ('ok' in own) return own
      const { r, run } = own
      const nowMs = clock.nowMs()
      if (run.state === 'done') return refuse('conflict', 'この実行はもう終わっています', { code: 'RUN_DONE' })
      if (run.state === 'open') return ok({ run: view(r, run) })
      if (run.state === 'running' && run.claimExpiresAt !== null && Date.parse(run.claimExpiresAt) > nowMs) {
        return refuse('conflict', RUN_CLAIMED.error, { code: RUN_CLAIMED.code })
      }
      if (unsettled(r.operations(run.id)).length > 0) return refuse('conflict', RUN_NEEDS_RECONCILE.error, { code: RUN_NEEDS_RECONCILE.code, run: view(r, run) })
      const next = givenBack(run, nowIso(nowMs))
      return transactions.run((): Outcome<{ run: AiRunView }> => {
        if (!save(r, run, next)) return refuse('conflict', RUN_CLAIMED.error, { code: RUN_CLAIMED.code })
        event(r, next, { event: 'given_back', code: 'RETRY' }, next.updatedAt)
        return ok({ run: view(r, next) })
      })
    },

    /**
     * A person asked for the record's step anew (［AI に読ませる］, minutes.md): that is the answer the
     * stopped run waits for, whoever's run it was (another attendee may press; `retry` is the run's
     * own member only). A run someone is on, or one with an unknown outside result, stays as it is.
     */
    askedAgain(companyId: string, recordId: string, step: string): void {
      const r = repo(companyId)
      const run = r.openRun({ kind: 'record', id: recordId }, step)
      if (!run || !(['waiting_person', 'waiting_setup', 'retry_later'] as AiRunRow['state'][]).includes(run.state)) return
      const next = givenBack(run, clock.now())
      transactions.run(() => { if (save(r, run, next)) event(r, next, { event: 'given_back', code: 'ASKED_AGAIN' }, next.updatedAt) })
    },

    /**
     * POST …/ai-runs/:runId/operations/:key/reconcile { done } — a person says
     * whether an operation of unknown result happened (looked in the outside
     * system). done: the key answers as done from now on; not done: the key may
     * run again. With nothing unknown left, a run waiting for this may go on.
     */
    reconcile(member: Member, runId: string, key: string, body: unknown): Outcome<{ run: AiRunView }> {
      const own = ownRun(member, runId)
      if ('ok' in own) return own
      if (!isObj(body) || typeof body.done !== 'boolean') return refuse('bad-request', 'done is true or false')
      return reconcileRun(own.r, own.run, key, body.done, member.userId)
    },

    /**
     * The same reconciliation for a run that is not the caller's own (B PR 5b: an owner / admin says, for a job's
     * occurrence they send back with 「もう一度」, whether its run's outside operation happened). Who may is the
     * calling service's rule (services/job-retry.ts); the run is found in the company's handle only.
     */
    reconcileFor(companyId: string, runId: string, key: string, done: boolean, byUserId: string): Outcome<{ run: AiRunView }> {
      const r = repo(companyId)
      const run = r.byId(runId)
      if (!run) return refuse('not-found', '操作が見つかりません', { code: 'OPERATION_NOT_FOUND' })
      return reconcileRun(r, run, key, done, byUserId)
    },

    /** GET …/ai-runs — the member's open runs of records only: the app's 「AI の番」 knows no other kind. */
    list(member: Member): Outcome<{ runs: AiRunView[] }> {
      const r = repo(member.companyId)
      return ok({ runs: r.openOf(member.userId).filter(run => run.subject.kind === 'record').map(run => view(r, run)) })
    },

    get(member: Member, runId: string): Outcome<{ run: AiRunView }> {
      const own = ownRun(member, runId)
      if ('ok' in own) return own
      return ok({ run: view(own.r, own.run) })
    },

    /**
     * Binding a record token to a run (POST /me/record-tokens { run }): the
     * member's own run, claimed now at this generation, for this consultation.
     */
    bindable(member: Member, run: unknown, conversationId: string): Outcome<{ runId: string; generation: number }> {
      if (!isObj(run) || typeof run.id !== 'string') return refuse('bad-request', 'run is { id, generation }')
      const generation = generationOf(run)
      if (generation === null) return refuse('bad-request', 'run.generation is a whole number ≥ 1')
      const own = ownRun(member, run.id)
      if ('ok' in own) return own
      // A record token works on records: a record's run binds one, and of the other kinds only a run whose
      // every call the subject scopes (a PC job's, B PR 5a: `routeRefusal`); another is a missing run here.
      if (own.run.subject.kind !== 'record' && !subjects.bindsTokens?.(liveRun(own.run))) return refuse('not-found', RUN_NOT_FOUND.error, { code: RUN_NOT_FOUND.code })
      if (own.run.state !== 'running' || own.run.generation !== generation || own.run.conversationId !== conversationId) {
        return refuse('conflict', RUN_SUPERSEDED.error, { code: RUN_SUPERSEDED.code })
      }
      return ok({ runId: own.run.id, generation })
    },

    fence,

    /**
     * The whole AI is stopped for this member (the company's or theirs): a run-bound token reaches nothing
     * (record-ai-tokens). The run keeps that it was refused, once per generation (not once per call).
     */
    runStopped(member: Member, run?: { id: string; generation: number }): boolean {
      if (!deps.aiStops(member).all) return false
      if (run) {
        const r = repo(member.companyId)
        const row = r.byId(run.id)
        if (row) stoppedOnce(r, row, clock.now())
      }
      return true
    },

    /**
     * The server's scope of a built-in step's token (ai-turns.md, `shared/core/ai-turn-routes.ts`):
     * a record token bound to a run of a built-in step may use only that step's routes; anything
     * else is 403 `NOT_IN_STEP` before the handler. `build` is the calling app's self-reported
     * X-ACB-Client-Version: a build older than `AI_TURN_ROUTE_SCOPE_COMMIT_DATE` (or none) is not
     * scoped, so released apps keep working. A business plugin's step (the C4 gate) and a missing
     * run (the token check fences it) are not decided here.
     */
    routeRefusal(member: Member, runId: string, route: string, params: Readonly<Record<string, string | undefined>>, build: string | null | undefined): Refusal | null {
      const run = repo(member.companyId).byId(runId)
      // Only a record's run is the built-in steps' (and only for them is the released apps' version gate):
      // a run of any other kind reaches only what its subject allows now (a PC job's grant, checked at every
      // call, B PR 5a; any other: nothing), whatever build calls.
      if (run && run.userId === member.userId && run.subject.kind !== 'record') {
        return subjects.routeRefusal ? subjects.routeRefusal(member, liveRun(run), route, params) : notInStep()
      }
      if (!aiTurnRouteScopeApplies(build)) return null
      if (!run || run.userId !== member.userId) return null
      return aiTurnRouteAllowed(run.step, route, params) ? null : notInStep()
    },

    /**
     * An outside operation within a run, by its idempotency key (header
     * `Idempotency-Key`). Runs `exec` at most once per key with an effect:
     * a key already done answers what it made; one in flight or of unknown
     * result is refused; a refused request (no effect) frees the key.
     */
    async keyed(caller: RunBoundCaller, key: string | undefined, request: { method: string; path: string; body: unknown }, kind: string, exec: () => Promise<KeyedAnswer>): Promise<KeyedAnswer> {
      const refusal = (status: number, error: string, code: string): KeyedAnswer => ({ status, body: { error, code } })
      if (!key) return refusal(400, '実行の中の外への操作には Idempotency-Key が必要です', 'OPERATION_KEY_REQUIRED')
      if (!OPERATION_KEY_RE.test(key)) return refusal(400, 'Idempotency-Key is 1–100 letters, digits, . _ : -', 'OPERATION_KEY_INVALID')
      const fingerprint = deps.tokenDigest.digest(requestText(request.method, request.path, request.body))
      const r = repo(caller.companyId)
      const at = clock.now()
      const started = transactions.run((): KeyedAnswer | null => {
        if (!fence(caller.companyId, caller.userId, caller.runId, caller.generation)) return refusal(409, RUN_SUPERSEDED.error, RUN_SUPERSEDED.code)
        const existing = r.operation(caller.runId, key)
        if (existing) {
          if (existing.fingerprint !== fingerprint) return refusal(409, 'この Idempotency-Key は別の操作に使われています', 'OPERATION_KEY_REUSED')
          if (existing.state === 'done') {
            const ref = existing.refKind && existing.refId ? { kind: existing.refKind, id: existing.refId } : null
            return { status: 200, body: { success: true, data: { replayed: true, operationKey: key, ref } } }
          }
          if (existing.state === 'in_progress') return refusal(409, 'この操作はまだ答えを待っています', 'OPERATION_IN_PROGRESS')
          if (existing.state === 'unknown') return refusal(409, RUN_NEEDS_RECONCILE.error, 'OPERATION_RESULT_UNKNOWN')
          // not_done (a person said it did not happen): it may run again.
          r.updateOperation(caller.runId, key, ['not_done'], { state: 'in_progress', generation: caller.generation, reconciledBy: null }, at)
          return null
        }
        const inserted = r.insertOperation({
          runId: caller.runId, key, fingerprint, kind, state: 'in_progress', generation: caller.generation, refKind: null, refId: null,
          status: null, reconciledBy: null, createdAt: at, updatedAt: at,
        })
        return inserted ? null : refusal(409, 'この操作はまだ答えを待っています', 'OPERATION_IN_PROGRESS')
      })
      if (started) return started
      let answer: KeyedAnswer
      try {
        answer = await exec()
      } catch (err) {
        // The effect may have happened before the failure.
        r.updateOperation(caller.runId, key, ['in_progress'], { state: 'unknown' }, clock.now())
        throw err
      }
      const outcome = outcomeOf(answer)
      const done = clock.now()
      // A late answer also settles an operation a re-claim marked unknown.
      if (outcome.state === 'none') {
        if (!r.deleteOperation(caller.runId, key, 'in_progress')) r.updateOperation(caller.runId, key, ['unknown'], { state: 'not_done', status: answer.status }, done)
      } else {
        r.updateOperation(caller.runId, key, ['in_progress', 'unknown'], {
          state: outcome.state, status: answer.status, refKind: outcome.ref?.kind ?? null, refId: outcome.ref?.id ?? null,
        }, done)
      }
      return answer
    },
  }
}

export type AiRunService = ReturnType<typeof createAiRunService>
