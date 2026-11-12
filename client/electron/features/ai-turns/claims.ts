// 「AI の番」 run automatically (stage 2 S10, .claude/rules/ai-turns.md): main's
// part. The run is a hidden consultation in the main window; here main only
//   - claims the record before the AI starts: the type's first AI action
//     (its step's `claim`, ai-turn-steps/; meeting: start_reading) with a record token of that consultation, at the
//     version the app saw — the server's compare-and-set lets one PC win;
//   - looks at the record after the turn and puts an unfinished one back to
//     「AI の番」 (`retry`, the member's own action, with the session).
// It never writes history and never starts an AI itself.
//
// Execution runs (S10b, .claude/rules/ai-turns.md "Execution runs"): before
// anything, main claims the record's step on the server (`POST /ai-run-claims`,
// this app instance's id) — one PC wins, and a re-claim by another PC after the
// claim expired raises the generation so this PC's later calls are refused. The
// run goes into the registry, which binds every record token of the
// consultation to it (records/api.ts); main renews the claim every minute while
// the AI works and finishes it after the turn, with the failure's class (never
// silently back to 「AI の番」: the server decides where it goes).

import type { AgentId } from '../../../shared/agents/registry'
import { agentCan } from '../../../shared/agents/registry'
import { aiTurnStepForRecord } from '../../../shared/ai-turn-steps/registry'
import { claimStates } from '../../../shared/ai-turn-steps/types'
import { readAutoTurnSettings, readOwnAutoRun, type AiTurnClaimResult, type AiTurnSettleResult, type AutoTurnSettings } from '../../../shared/ai-turns'
import type { RecordsApi } from '../../records/api'
import type { RunRegistry } from '../../records/runs'
import { isOccurrenceId, type JobRunResult } from '../../../../shared/core/jobs'
import { createJobRuns, type JobRunDeps } from './job-runs'
// lane C ▼
import {
  isPluginRunStep, parsePluginStepTurns, parsePluginStepsOn, parseProcedurePin, pluginStepFirstMessage, pluginStepToolAccess,
  type PluginStepProcedurePin, type PluginStepToolAccess, type QueuedPluginStep,
} from '../../../shared/ai-turn-steps/plugin'
// lane C ▲

export interface AiTurnClaimsDeps {
  baseUrl: () => string
  cookies: () => string[]
  records: Pick<RecordsApi, 'openTurn'>
  /** The member's chosen AI now (config): only an agent with record actions takes an AI turn. */
  agent: () => AgentId
  /** The main window is open (a closed window runs nothing). */
  windowOpen: () => boolean
  /** The emergency stop allows AI (agent-stop.md). */
  aiAllowed: () => boolean
  /**
   * The company's stop policy is confirmed by the server recently (agent-stop.ts
   * `stopPolicyConfirmed`): an AI turn has no person present, so it never starts on a policy this
   * app cannot confirm (owner decision 2026-11-09).
   */
  stopPolicyConfirmed: (companyId: string) => Promise<boolean>
  /** Which consultation runs which execution run (shared with the records API). */
  runs: RunRegistry
  /** This app instance (random per launch): the server's claim holder. */
  deviceId: string
  /**
   * The record moved on since the app's notice (another PC finished it, a person acted): the
   * notices are read again, so this PC stops showing it as waiting for the AI.
   */
  recordMovedOn?: (companyId: string) => void
  /** How often a running claim is renewed (default 60 s; the server's claim lasts 5 minutes). */
  renewEveryMs?: number
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  // lane C ▼
  /**
   * A business plugin's step's procedure (plugin-steps.md): the text of the pinned plugin
   * version's file (`<userData>/plugins/<id>@<version>/<file>`, kept by C2), or of the company
   * Skill's SKILL.md at the pinned tree in the member's company folder. null = not on this PC.
   */
  readProcedure?: (companyId: string, pin: PluginStepProcedurePin, file: string, companyRoot: string | null) => Promise<string | null>
  // lane C ▲
  /**
   * A scheduled job's run on this PC (jobs.md "The app's runner", job-runs.ts): reading a shelf Skill's
   * pinned version, the new files under a place, and stopping a consultation's AI. Absent: no job runs.
   */
  jobs?: Pick<JobRunDeps, 'readShelfSkill' | 'checkPoint' | 'newFiles' | 'stopTurn'>
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const CONVERSATION = /^[A-Za-z0-9-]{8,100}$/

export function createAiTurnClaims(deps: AiTurnClaimsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  /** Runs this app instance holds: record → its run, generation, consultation and renewal timer. */
  const held = new Map<string, { runId: string; generation: number; conversationId: string; timer: ReturnType<typeof setInterval> }>()
  const heldKey = (companyId: string, recordId: string) => `${companyId}\n${recordId}`
  // lane C ▼
  /** The member's records at a plugin's ai_turn step, as last listed (company → record → turn). */
  const pluginTurns = new Map<string, Map<string, QueuedPluginStep>>()
  /**
   * Plugin step runs this app holds: record → the state it started at and when (settle: moved on =
   * done; a person's step run by itself: done when its やること for the record came — what it made).
   */
  const pluginStarts = new Map<string, { state: string; at: string; auto: boolean }>()
  /** The tool ceiling and deliverable folder of each plugin step's consultation (the chat server asks them). */
  const pluginTools = new Map<string, { step: string; access: PluginStepToolAccess; deliverableFolder: string }>()
  // lane C ▲

  function release(companyId: string, recordId: string) {
    const h = held.get(heldKey(companyId, recordId))
    if (!h) return null
    clearInterval(h.timer)
    held.delete(heldKey(companyId, recordId))
    deps.runs.clear(companyId, h.conversationId)
    pluginTools.delete(h.conversationId)
    return h
  }

  /** Finish the run on the server: done, or failed with its class (the server decides where it goes). A job's done carries its result. */
  async function finishRun(companyId: string, recordId: string, failure: { class: 'temporary' | 'bad-input' | 'permission' | 'unknown-result'; code: string } | null, extra?: { jobResult: JobRunResult }) {
    const h = release(companyId, recordId)
    if (!h) return null
    const r = await session(companyId, 'POST', `/ai-runs/${encodeURIComponent(h.runId)}/finish`,
      { generation: h.generation, outcome: failure ? 'failed' : 'done', ...(failure ? { failure } : {}), ...(!failure && extra ? extra : {}) })
    if (!r || r.status >= 300) log.warn(`[ai-turns] finish run: answered ${r?.status ?? 'nothing'}`)
    return r
  }

  async function session(companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: unknown; code?: string } | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const json = await res.json().catch(() => null) as { data?: unknown; code?: unknown } | null
      // A refusal's code (short, A–Z and _ only): what some callers decide on (a job's claim, jobs.md).
      const code = typeof json?.code === 'string' && /^[A-Z_]{1,60}$/.test(json.code) ? json.code : undefined
      return { status: res.status, data: json?.data, ...(code ? { code } : {}) }
    } catch {
      return null
    }
  }

  async function recordOf(companyId: string, recordId: string): Promise<{ state: string; version: number; type: string | null; title: string | null } | null> {
    const r = await session(companyId, 'GET', `/records/item/${encodeURIComponent(recordId)}`)
    const record = (r?.status === 200 ? (r.data as { record?: { state?: unknown; version?: unknown; type?: unknown; title?: unknown } } | undefined)?.record : undefined)
    return record && typeof record.state === 'string' && typeof record.version === 'number'
      ? { state: record.state, version: record.version, type: typeof record.type === 'string' ? record.type : null, title: typeof record.title === 'string' && record.title.trim() ? record.title : null } : null
  }

  /** The settle's answer, with the record's title as last read (the run may have named it: the runner renames the consultation). */
  function settled(outcome: AiTurnSettleResult['outcome'], record: { title: string | null } | null): AiTurnSettleResult {
    return record?.title ? { outcome, title: record.title } : { outcome }
  }

  /** Hold a claimed run: register it for the consultation's tokens and renew it while running. */
  function hold(companyId: string, recordId: string, conversationId: string, run: { id: string; generation: number }, onLost?: () => void) {
    release(companyId, recordId)
    deps.runs.set(companyId, conversationId, { id: run.id, generation: run.generation })
    const timer = setInterval(() => {
      void session(companyId, 'POST', `/ai-runs/${encodeURIComponent(run.id)}/renew`, { generation: run.generation }).then(r => {
        // Taken over by another PC (or ended): this PC's tokens are refused from now on; stop renewing.
        // A job's run also stops its AI (a pause, the company's stop, its time limit: jobs.md).
        if (r && r.status === 409 && held.get(heldKey(companyId, recordId))?.runId === run.id) {
          release(companyId, recordId)
          onLost?.()
        }
      })
    }, deps.renewEveryMs ?? 60_000)
    timer.unref?.()
    held.set(heldKey(companyId, recordId), { runId: run.id, generation: run.generation, conversationId, timer })
  }

  // lane C ▼
  /** Whether a やること linked to the record (its まとまり), with its preparation, was made or changed since `at`: what a step run by itself hands over. */
  async function madeSince(companyId: string, recordId: string, at: string): Promise<boolean> {
    const r = await session(companyId, 'POST', '/records/query', { type: 'task', link: { name: 'bundle', id: recordId }, limit: 20 })
    const records = r?.status === 200 ? (r.data as { records?: unknown } | undefined)?.records : undefined
    if (!Array.isArray(records)) return false
    const since = Date.parse(at)
    // What the run made: a やること carrying its preparation (確かめる点), changed since the claim.
    return records.some(x => {
      const r = typeof x === 'object' && x !== null ? x as { updatedAt?: unknown; fields?: { prep_summary?: unknown } } : null
      return !!r && typeof r.updatedAt === 'string' && Date.parse(r.updatedAt) >= since
        && typeof r.fields?.prep_summary === 'string' && r.fields.prep_summary.trim() !== ''
    })
  }

  /**
   * A business plugin's step (plugin-steps.md): the server's run of `<pluginId>__<step>` is the
   * claim (the step has no claim action); the claim's pin names the procedure, read on this PC
   * (the package C2 keeps, or the company Skill at the pinned tree); the step's tools — narrowed
   * by the pinned version on the server — are the consultation's ceiling.
   */
  async function claimPluginStep(companyId: string, turn: QueuedPluginStep, conversationId: string, companyRoot: string | null): Promise<AiTurnClaimResult> {
    const { recordId } = turn
    const now = await recordOf(companyId, recordId)
    if (!now) return { claimed: false, reason: 'unavailable' }
    const claimed = await session(companyId, 'POST', '/ai-run-claims', { recordId, step: turn.runStep, deviceId: deps.deviceId, conversationId })
    if (!claimed || claimed.status >= 500) return { claimed: false, reason: 'unavailable' }
    const run = claimed.status < 300 ? (claimed.data as { run?: { id?: unknown; generation?: unknown; updatedAt?: unknown; procedure?: { pin?: unknown } | null } } | undefined)?.run : undefined
    if (!run || typeof run.id !== 'string' || typeof run.generation !== 'number') return { claimed: false, reason: 'taken' }
    hold(companyId, recordId, conversationId, { id: run.id, generation: run.generation })
    const giveBack = async (code: string): Promise<AiTurnClaimResult> => {
      await finishRun(companyId, recordId, { class: 'temporary', code })
      return { claimed: false, reason: 'unavailable' }
    }
    const pin = parseProcedurePin(run.procedure?.pin)
    const on = await session(companyId, 'GET', `/me/plugin-steps/records/${encodeURIComponent(recordId)}`)
    const step = on?.status === 200 ? parsePluginStepsOn(on.data)?.find(s => s.pluginId === turn.pluginId && s.step === turn.step) : undefined
    if (!pin || !step || !now.type) return giveBack('STEP_NOT_READABLE')
    const text = await (deps.readProcedure?.(companyId, pin, step.procedure, companyRoot) ?? Promise.resolve(null)).catch(() => null)
    // Not on this PC yet (the package not fetched, the Skill not synced): tried again later.
    if (text === null) return giveBack('PROCEDURE_NOT_HERE')
    // A person's step only runs by itself when the company chose so: then nothing that reaches outside.
    const auto = turn.auto && step.start === 'person'
    if (turn.auto !== auto) return giveBack('STEP_NOT_READABLE')
    const deliverableFolder = step.deliverableFolder ?? turn.deliverableFolder
    // The server's time of the claim (what the record's times are compared with), else this PC's.
    const at = typeof run.updatedAt === 'string' && !Number.isNaN(Date.parse(run.updatedAt)) ? run.updatedAt : new Date().toISOString()
    pluginStarts.set(heldKey(companyId, recordId), { state: now.state, at, auto })
    pluginTools.set(conversationId, { step: turn.runStep, access: pluginStepToolAccess(step, now.type, { automatic: auto }), deliverableFolder })
    return {
      claimed: true, version: now.version,
      message: pluginStepFirstMessage({ label: step.label, recordId, version: now.version, procedure: text, source: pin.source, deliverableFolder, auto }),
    }
  }
  // lane C ▲

  /**
   * 「自動で進める」 for this member: their own switch within the company's (`GET
   * /me/work-switches`, shared/core/work-switches.ts — the AI's turn runs on the assignee's PC),
   * with the company's limits (`autoRun` of S6's task settings). Not readable → off; a server
   * without the member's switch (404, older) → the company's switch as before.
   */
  async function autoTurnSettings(companyId: string): Promise<AutoTurnSettings> {
    if (!COMPANY.test(companyId)) return readAutoTurnSettings(undefined)
    const [r, mine] = await Promise.all([session(companyId, 'GET', '/task-settings'), session(companyId, 'GET', '/me/work-switches')])
    const view = r?.status === 200 ? r.data as { settings?: { autoRun?: unknown } } | undefined : undefined
    const company = readAutoTurnSettings(view?.settings?.autoRun)
    if (mine?.status === 404) return company
    return { ...company, enabled: company.enabled && readOwnAutoRun(mine?.status === 200 ? mine.data : undefined) }
  }

  // A scheduled job's run (job-runs.ts): this module's claim, hold and finish, with what only main knows.
  const jobs = deps.jobs ? createJobRuns({
    session, hold, finishRun, deviceId: deps.deviceId, log,
    holds: (companyId, key, runId) => held.get(heldKey(companyId, key))?.runId === runId,
    readCompanySkill: (companyId, skill, tree, companyRoot) =>
      deps.readProcedure?.(companyId, { source: 'company_skill', skill, fingerprint: tree }, 'SKILL.md', companyRoot) ?? Promise.resolve(null),
    ...deps.jobs,
  }) : null

  return {
    /** The member's scheduled jobs' occurrences this app can run now (`GET /me/job-turns`); none without job support. */
    async jobTurns(companyId: string) {
      return jobs && COMPANY.test(companyId) ? jobs.turns(companyId) : []
    },
    /** A job run's tool ceiling for its consultation (the chat server asks it with step `job-procedure`). */
    jobTools(conversationId: string, step: string) {
      return jobs?.toolsOf(conversationId, step) ?? null
    },
    /** Where a job run's consultation may write; null for any other consultation. */
    jobWriteArea(conversationId: string) {
      return jobs?.writeAreaOf(conversationId) ?? null
    },
    /** A job run's `job_report` for its consultation; null for any other. */
    jobReporter(conversationId: string) {
      return jobs?.reporter(conversationId) ?? null
    },

    // lane C ▼
    /**
     * The member's records waiting at a business plugin's `start: ai_turn` step (`GET
     * /me/plugin-step-turns`), remembered for the claim. Not readable (offline, an older server):
     * the last list.
     */
    async pluginTurns(companyId: string): Promise<QueuedPluginStep[]> {
      if (!COMPANY.test(companyId)) return []
      const r = await session(companyId, 'GET', '/me/plugin-step-turns')
      const turns = r?.status === 200 ? parsePluginStepTurns(r.data) : null
      if (turns === null) return [...(pluginTurns.get(companyId)?.values() ?? [])]
      pluginTurns.set(companyId, new Map(turns.map(t => [t.recordId, t])))
      return turns
    },

    /**
     * The tool ceiling of a plugin step's consultation this app claimed (the chat server's
     * least-privilege filter); null for any other consultation or step.
     */
    pluginStepTools(conversationId: string, step: string): PluginStepToolAccess | null {
      const known = pluginTools.get(conversationId)
      return known && isPluginRunStep(step) && known.step === step ? known.access : null
    },

    /** The deliverable folder of a plugin step's run this app holds (its writes go only there); null for any other consultation. */
    pluginStepWriteArea(conversationId: string): string | null {
      return pluginTools.get(conversationId)?.deliverableFolder ?? null
    },
    // lane C ▲

    /** 「自動で進める」 for this member (`autoTurnSettings`). */
    settings: autoTurnSettings,

    /** The runner asks before it starts anything: the stop policy is confirmed (else it waits and says why). */
    stopPolicyConfirmed(companyId: string): Promise<boolean> {
      return COMPANY.test(companyId) ? deps.stopPolicyConfirmed(companyId).catch(() => false) : Promise.resolve(false)
    },

    /**
     * Take the record's AI turn for this consultation, or learn that another PC (or person) was
     * first. The version comes from the record read now: the notice's may be old (an earlier run
     * was put back), and claiming at it would be refused every time.
     */
    async claim(companyId: string, recordId: string, noticeVersion: number, conversationId: string, companyRoot?: string | null): Promise<AiTurnClaimResult> {
      // A scheduled job's occurrence: the same refusals first (no person present), then its own claim.
      if (isOccurrenceId(recordId)) {
        if (!jobs || !COMPANY.test(companyId) || !CONVERSATION.test(conversationId) || !jobs.isJob(companyId, recordId)) return { claimed: false, reason: 'not-allowed' }
        if (!deps.windowOpen() || !deps.aiAllowed() || !agentCan(deps.agent(), 'recordActions')) return { claimed: false, reason: 'not-allowed' }
        if (!(await deps.stopPolicyConfirmed(companyId).catch(() => false))) return { claimed: false, reason: 'not-allowed' }
        // A job has no person who asked: only while the member's 「自動で進める」 is on (read now, off when unreadable).
        if (!(await autoTurnSettings(companyId)).enabled) return { claimed: false, reason: 'not-allowed' }
        return jobs.claim(companyId, recordId, conversationId, companyRoot ?? null)
      }
      const pluginTurn = pluginTurns.get(companyId)?.get(recordId) ?? null
      const kind = pluginTurn ? null : aiTurnStepForRecord(recordId)
      if (!COMPANY.test(companyId) || (!kind && !pluginTurn) || !Number.isInteger(noticeVersion) || noticeVersion < 1 || !CONVERSATION.test(conversationId)) {
        return { claimed: false, reason: 'not-allowed' }
      }
      const agent = deps.agent()
      if (!deps.windowOpen() || !deps.aiAllowed() || !agentCan(agent, 'recordActions')) return { claimed: false, reason: 'not-allowed' }
      // No person present: not without a stop policy the server confirmed (before any server call).
      if (!(await deps.stopPolicyConfirmed(companyId).catch(() => false))) return { claimed: false, reason: 'not-allowed' }
      if (pluginTurn) return claimPluginStep(companyId, pluginTurn, conversationId, companyRoot ?? null)
      if (!kind) return { claimed: false, reason: 'not-allowed' }
      const now = await recordOf(companyId, recordId)
      // The record's state now picks the step (a meeting's reading, or its まとまり's part).
      const step = aiTurnStepForRecord(recordId, now?.state) ?? kind
      // No longer waiting for the AI (another PC read it, a person skipped it): nothing to claim.
      if (now && !claimStates(step).includes(now.state)) {
        deps.recordMovedOn?.(companyId)
        return { claimed: false, reason: 'taken' }
      }
      const expectedVersion = now?.version ?? noticeVersion
      // The server's execution run first: one PC holds it (another PC, a run waiting for a person
      // or for reconciliation → taken; the server is the authority).
      const claimed = await session(companyId, 'POST', '/ai-run-claims', { recordId, step: step.step, deviceId: deps.deviceId, conversationId })
      if (!claimed || claimed.status >= 500) return { claimed: false, reason: 'unavailable' }
      const run = claimed.status < 300 ? (claimed.data as { run?: { id?: unknown; generation?: unknown } } | undefined)?.run : undefined
      if (!run || typeof run.id !== 'string' || typeof run.generation !== 'number') return { claimed: false, reason: 'taken' }
      hold(companyId, recordId, conversationId, { id: run.id, generation: run.generation })

      const access = await deps.records.openTurn(companyId, { conversationId, agent, scope: 'act' })
      if (!access) {
        await finishRun(companyId, recordId, { class: 'temporary', code: 'OFFLINE' })
        return { claimed: false, reason: 'unavailable' }
      }
      try {
        if (access.scope !== 'act') {
          await finishRun(companyId, recordId, { class: 'permission', code: 'READ_ONLY_TOKEN' })
          return { claimed: false, reason: 'not-allowed' }
        }
        // No start mark in the type (an interaction in 届いた): the server's run is the claim.
        if (step.claim.action === null) return { claimed: true, version: now?.version ?? null }
        const started = await access.call('POST', `/item/${encodeURIComponent(recordId)}/actions/${encodeURIComponent(step.claim.action)}`, { expectedVersion }) as { record?: { version?: unknown } } | undefined
        const version = started?.record?.version
        return { claimed: true, version: typeof version === 'number' ? version : null }
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'VERSION_CONFLICT' || code === 'BAD_STATE') deps.recordMovedOn?.(companyId)
        // Not started: the run is given back for later (VERSION_CONFLICT — the member or another PC was first —,
        // offline); the server's claim keeps a second PC from starting it meanwhile.
        await finishRun(companyId, recordId, { class: 'temporary', code: typeof code === 'string' && /^[A-Z0-9_]{1,60}$/.test(code) ? code : 'NOT_STARTED' })
        if (code === 'OFFLINE' || code === 'SERVER_ERROR') return { claimed: false, reason: 'unavailable' }
        return { claimed: false, reason: 'taken' }
      } finally {
        await access.close()
      }
    },

    /**
     * 「もう一度」: give a run the server holds for a person (waiting for setup / a person, or
     * retried later) back to the AI. One with an unknown outside result stays until reconciled.
     */
    async retry(companyId: string, recordId: string): Promise<{ ok: boolean }> {
      // A job's occurrence: nothing to give back here (its 「もう一度」 is the server's, 5b); the server lists it again when it may run.
      if (isOccurrenceId(recordId)) return { ok: true }
      if (!COMPANY.test(companyId) || (!aiTurnStepForRecord(recordId) && !pluginTurns.get(companyId)?.has(recordId))) return { ok: false }
      const list = await session(companyId, 'GET', '/ai-runs')
      const runs = list?.status === 200 ? (list.data as { runs?: Array<{ id?: unknown; recordId?: unknown }> } | undefined)?.runs ?? [] : []
      const run = runs.find(r => r.recordId === recordId && typeof r.id === 'string')
      if (!run) return { ok: true }
      const r = await session(companyId, 'POST', `/ai-runs/${encodeURIComponent(run.id as string)}/retry`)
      return { ok: !!r && r.status < 300 }
    },

    /** After the automatic turn: finished, failed, or still in progress → back to 「AI の番」. */
    async settle(companyId: string, recordId: string): Promise<AiTurnSettleResult> {
      if (isOccurrenceId(recordId)) return jobs && COMPANY.test(companyId) ? jobs.settle(companyId, recordId) : { outcome: 'unknown' }
      // lane C ▼
      const started = pluginStarts.get(heldKey(companyId, recordId))
      if (started !== undefined && COMPANY.test(companyId)) {
        // A plugin step is done when the record left the step's state; otherwise it is tried again later.
        // A person's step run by itself leaves the record where it is: done when it handed over what it made.
        pluginStarts.delete(heldKey(companyId, recordId))
        const record = await recordOf(companyId, recordId)
        if (record && (started.auto ? await madeSince(companyId, recordId, started.at) : record.state !== started.state)) {
          await finishRun(companyId, recordId, null)
          return settled('done', record)
        }
        await finishRun(companyId, recordId, { class: 'temporary', code: record ? 'UNFINISHED' : 'NOT_READABLE' })
        return settled(record ? 'put-back' : 'unknown', record)
      }
      // lane C ▲
      if (!COMPANY.test(companyId) || !aiTurnStepForRecord(recordId)) return { outcome: 'unknown' }
      const record = await recordOf(companyId, recordId)
      const step = aiTurnStepForRecord(recordId, record?.state)!
      const { settle } = step
      if (!record) {
        await finishRun(companyId, recordId, { class: 'temporary', code: 'NOT_READABLE' })
        return { outcome: 'unknown' }
      }
      if (settle.done.includes(record.state)) {
        await finishRun(companyId, recordId, null)
        return settled('done', record)
      }
      // The AI said it could not (missing or bad input): a person looks (waiting_person on the server).
      const couldNot = settle.couldNot.includes(record.state)
      if (couldNot || settle.closed.includes(record.state)) {
        await finishRun(companyId, recordId, couldNot ? { class: 'bad-input', code: 'AI_COULD_NOT_FINISH' } : null)
        return settled('failed', record)
      }
      // Stopped without finishing: tried again later (a few times, then a person — the server counts).
      // Finishing the run puts the reading back (the ledger names the run, not the member).
      const ran = held.has(heldKey(companyId, recordId))
      await finishRun(companyId, recordId, { class: 'temporary', code: 'UNFINISHED' })
      if (record.state !== settle.working && !claimStates(step).includes(record.state)) return settled('unknown', record)
      const after = ran ? await recordOf(companyId, recordId) : record
      if (after && claimStates(step).includes(after.state)) return settled('put-back', after)
      if (!after || after.state !== settle.working || settle.putBack === null) return settled('unknown', after ?? record)
      // An older server leaves it reading: put it back with the member's session, as before.
      const r = await session(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/actions/${encodeURIComponent(settle.putBack)}`, { expectedVersion: after.version })
      if (!r || r.status >= 300) log.warn(`[ai-turns] retry: answered ${r?.status ?? 'nothing'}`)
      return settled(r && r.status < 300 ? 'put-back' : 'unknown', after)
    },
  }
}

export type AiTurnClaims = ReturnType<typeof createAiTurnClaims>
