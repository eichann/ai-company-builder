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
import { readAutoTurnSettings, type AiTurnClaimResult, type AiTurnSettleResult, type AutoTurnSettings } from '../../../shared/ai-turns'
import type { RecordsApi } from '../../records/api'
import type { RunRegistry } from '../../records/runs'

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
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const CONVERSATION = /^[A-Za-z0-9-]{8,100}$/

export function createAiTurnClaims(deps: AiTurnClaimsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  /** Runs this app instance holds: record → its run, generation, consultation and renewal timer. */
  const held = new Map<string, { runId: string; generation: number; conversationId: string; timer: ReturnType<typeof setInterval> }>()
  const heldKey = (companyId: string, recordId: string) => `${companyId}\n${recordId}`

  function release(companyId: string, recordId: string) {
    const h = held.get(heldKey(companyId, recordId))
    if (!h) return null
    clearInterval(h.timer)
    held.delete(heldKey(companyId, recordId))
    deps.runs.clear(companyId, h.conversationId)
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

  async function recordOf(companyId: string, recordId: string): Promise<{ state: string; version: number } | null> {
    const r = await session(companyId, 'GET', `/records/item/${encodeURIComponent(recordId)}`)
    const record = (r?.status === 200 ? (r.data as { record?: { state?: unknown; version?: unknown } } | undefined)?.record : undefined)
    return record && typeof record.state === 'string' && typeof record.version === 'number' ? { state: record.state, version: record.version } : null
  }

  return {
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
    async claim(companyId: string, recordId: string, noticeVersion: number, conversationId: string): Promise<AiTurnClaimResult> {
      const step = aiTurnStepForRecord(recordId)
      if (!COMPANY.test(companyId) || !step || !Number.isInteger(noticeVersion) || noticeVersion < 1 || !CONVERSATION.test(conversationId)) {
        return { claimed: false, reason: 'not-allowed' }
      }
      const agent = deps.agent()
      if (!deps.windowOpen() || !deps.aiAllowed() || !agentCan(agent, 'recordActions')) return { claimed: false, reason: 'not-allowed' }
      const now = await recordOf(companyId, recordId)
      // No longer waiting for the AI (another PC read it, a person skipped it): nothing to claim.
      if (now && now.state !== step.claim.from) {
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
      release(companyId, recordId)
      deps.runs.set(companyId, conversationId, { id: run.id, generation: run.generation })
      const runId = run.id
      const generation = run.generation
      const timer = setInterval(() => {
        void session(companyId, 'POST', `/ai-runs/${encodeURIComponent(runId)}/renew`, { generation }).then(r => {
          // Taken over by another PC (or ended): this PC's tokens are refused from now on; stop renewing.
          if (r && r.status === 409) release(companyId, recordId)
        })
      }, deps.renewEveryMs ?? 60_000)
      timer.unref?.()
      held.set(heldKey(companyId, recordId), { runId, generation, conversationId, timer })

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
      if (!COMPANY.test(companyId) || !aiTurnStepForRecord(recordId)) return { ok: false }
      const list = await session(companyId, 'GET', '/ai-runs')
      const runs = list?.status === 200 ? (list.data as { runs?: Array<{ id?: unknown; recordId?: unknown }> } | undefined)?.runs ?? [] : []
      const run = runs.find(r => r.recordId === recordId && typeof r.id === 'string')
      if (!run) return { ok: true }
      const r = await session(companyId, 'POST', `/ai-runs/${encodeURIComponent(run.id as string)}/retry`)
      return { ok: !!r && r.status < 300 }
    },

    /** After the automatic turn: finished, failed, or still in progress → back to 「AI の番」. */
    async settle(companyId: string, recordId: string): Promise<AiTurnSettleResult> {
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
      if (record.state !== settle.working) return { outcome: 'unknown' }
      const after = ran ? await recordOf(companyId, recordId) : record
      if (after && after.state === step.claim.from) return { outcome: 'put-back' }
      if (!after || after.state !== settle.working || settle.putBack === null) return { outcome: 'unknown' }
      // An older server leaves it reading: put it back with the member's session, as before.
      const r = await session(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/actions/${encodeURIComponent(settle.putBack)}`, { expectedVersion: after.version })
      if (!r || r.status >= 300) log.warn(`[ai-turns] retry: answered ${r?.status ?? 'nothing'}`)
      return { outcome: r && r.status < 300 ? 'put-back' : 'unknown' }
    },
  }
}

export type AiTurnClaims = ReturnType<typeof createAiTurnClaims>
