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
import { readAutoTurnSettings, type AiTurnClaimResult, type AiTurnSettleResult, type AutoTurnSettings } from '../../../shared/ai-turns'
import type { RecordsApi } from '../../records/api'
import type { RunRegistry } from '../../records/runs'
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
  /** Plugin step runs this app holds: record → the state it started at (settle: moved on = done). */
  const pluginStarts = new Map<string, string>()
  /** The tool ceiling of each plugin step's consultation (the chat server asks it). */
  const pluginTools = new Map<string, { step: string; access: PluginStepToolAccess }>()
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

  /** Finish the run on the server: done, or failed with its class (the server decides where it goes). */
  async function finishRun(companyId: string, recordId: string, failure: { class: 'temporary' | 'bad-input' | 'permission' | 'unknown-result'; code: string } | null) {
    const h = release(companyId, recordId)
    if (!h) return
    const r = await session(companyId, 'POST', `/ai-runs/${encodeURIComponent(h.runId)}/finish`,
      { generation: h.generation, outcome: failure ? 'failed' : 'done', ...(failure ? { failure } : {}) })
    if (!r || r.status >= 300) log.warn(`[ai-turns] finish run: answered ${r?.status ?? 'nothing'}`)
  }

  async function session(companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: unknown } | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const json = await res.json().catch(() => null) as { data?: unknown } | null
      return { status: res.status, data: json?.data }
    } catch {
      return null
    }
  }

  async function recordOf(companyId: string, recordId: string): Promise<{ state: string; version: number; type: string | null } | null> {
    const r = await session(companyId, 'GET', `/records/item/${encodeURIComponent(recordId)}`)
    const record = (r?.status === 200 ? (r.data as { record?: { state?: unknown; version?: unknown; type?: unknown } } | undefined)?.record : undefined)
    return record && typeof record.state === 'string' && typeof record.version === 'number'
      ? { state: record.state, version: record.version, type: typeof record.type === 'string' ? record.type : null } : null
  }

  /** Hold a claimed run: register it for the consultation's tokens and renew it while running. */
  function hold(companyId: string, recordId: string, conversationId: string, run: { id: string; generation: number }) {
    release(companyId, recordId)
    deps.runs.set(companyId, conversationId, { id: run.id, generation: run.generation })
    const timer = setInterval(() => {
      void session(companyId, 'POST', `/ai-runs/${encodeURIComponent(run.id)}/renew`, { generation: run.generation }).then(r => {
        // Taken over by another PC (or ended): this PC's tokens are refused from now on; stop renewing.
        if (r && r.status === 409) release(companyId, recordId)
      })
    }, deps.renewEveryMs ?? 60_000)
    timer.unref?.()
    held.set(heldKey(companyId, recordId), { runId: run.id, generation: run.generation, conversationId, timer })
  }

  // lane C ▼
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
    const run = claimed.status < 300 ? (claimed.data as { run?: { id?: unknown; generation?: unknown; procedure?: { pin?: unknown } | null } } | undefined)?.run : undefined
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
    pluginStarts.set(heldKey(companyId, recordId), now.state)
    pluginTools.set(conversationId, { step: turn.runStep, access: pluginStepToolAccess(step, now.type) })
    return {
      claimed: true, version: now.version,
      message: pluginStepFirstMessage({ label: step.label, recordId, version: now.version, procedure: text, source: pin.source }),
    }
  }
  // lane C ▲

  return {
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
    // lane C ▲

    /** The company's 「自動で進める」 (`autoRun` of S6's task settings); not readable → off. */
    async settings(companyId: string): Promise<AutoTurnSettings> {
      if (!COMPANY.test(companyId)) return readAutoTurnSettings(undefined)
      const r = await session(companyId, 'GET', '/task-settings')
      const view = r?.status === 200 ? r.data as { settings?: { autoRun?: unknown } } | undefined : undefined
      return readAutoTurnSettings(view?.settings?.autoRun)
    },

    /**
     * Take the record's AI turn for this consultation, or learn that another PC (or person) was
     * first. The version comes from the record read now: the notice's may be old (an earlier run
     * was put back), and claiming at it would be refused every time.
     */
    async claim(companyId: string, recordId: string, noticeVersion: number, conversationId: string, companyRoot?: string | null): Promise<AiTurnClaimResult> {
      const pluginTurn = pluginTurns.get(companyId)?.get(recordId) ?? null
      const step = pluginTurn ? null : aiTurnStepForRecord(recordId)
      if (!COMPANY.test(companyId) || (!step && !pluginTurn) || !Number.isInteger(noticeVersion) || noticeVersion < 1 || !CONVERSATION.test(conversationId)) {
        return { claimed: false, reason: 'not-allowed' }
      }
      const agent = deps.agent()
      if (!deps.windowOpen() || !deps.aiAllowed() || !agentCan(agent, 'recordActions')) return { claimed: false, reason: 'not-allowed' }
      if (pluginTurn) return claimPluginStep(companyId, pluginTurn, conversationId, companyRoot ?? null)
      if (!step) return { claimed: false, reason: 'not-allowed' }
      const now = await recordOf(companyId, recordId)
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
      // lane C ▼
      const startedAt = pluginStarts.get(heldKey(companyId, recordId))
      if (startedAt !== undefined && COMPANY.test(companyId)) {
        // A plugin step is done when the record left the step's state; otherwise it is tried again later.
        pluginStarts.delete(heldKey(companyId, recordId))
        const record = await recordOf(companyId, recordId)
        if (record && record.state !== startedAt) {
          await finishRun(companyId, recordId, null)
          return { outcome: 'done' }
        }
        await finishRun(companyId, recordId, { class: 'temporary', code: record ? 'UNFINISHED' : 'NOT_READABLE' })
        return { outcome: record ? 'put-back' : 'unknown' }
      }
      // lane C ▲
      const step = aiTurnStepForRecord(recordId)
      if (!COMPANY.test(companyId) || !step) return { outcome: 'unknown' }
      const { settle } = step
      const record = await recordOf(companyId, recordId)
      if (!record) {
        await finishRun(companyId, recordId, { class: 'temporary', code: 'NOT_READABLE' })
        return { outcome: 'unknown' }
      }
      if (settle.done.includes(record.state)) {
        await finishRun(companyId, recordId, null)
        return { outcome: 'done' }
      }
      // The AI said it could not (missing or bad input): a person looks (waiting_person on the server).
      const couldNot = settle.couldNot.includes(record.state)
      if (couldNot || settle.closed.includes(record.state)) {
        await finishRun(companyId, recordId, couldNot ? { class: 'bad-input', code: 'AI_COULD_NOT_FINISH' } : null)
        return { outcome: 'failed' }
      }
      // Stopped without finishing: tried again later (a few times, then a person — the server counts).
      // Finishing the run puts the reading back (the ledger names the run, not the member).
      const ran = held.has(heldKey(companyId, recordId))
      await finishRun(companyId, recordId, { class: 'temporary', code: 'UNFINISHED' })
      if (record.state !== settle.working && !claimStates(step).includes(record.state)) return { outcome: 'unknown' }
      const after = ran ? await recordOf(companyId, recordId) : record
      if (after && claimStates(step).includes(after.state)) return { outcome: 'put-back' }
      if (!after || after.state !== settle.working || settle.putBack === null) return { outcome: 'unknown' }
      // An older server leaves it reading: put it back with the member's session, as before.
      const r = await session(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/actions/${encodeURIComponent(settle.putBack)}`, { expectedVersion: after.version })
      if (!r || r.status >= 300) log.warn(`[ai-turns] retry: answered ${r?.status ?? 'nothing'}`)
      return { outcome: r && r.status < 300 ? 'put-back' : 'unknown' }
    },
  }
}

export type AiTurnClaims = ReturnType<typeof createAiTurnClaims>
