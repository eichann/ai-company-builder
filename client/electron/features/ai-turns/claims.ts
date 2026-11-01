// 「AI の番」 run automatically (stage 2 S10, .claude/rules/ai-turns.md): main's
// part. The run is a hidden consultation in the main window; here main only
//   - claims the record before the AI starts: the type's first AI action
//     (minutes: start_reading) with a record token of that consultation, at the
//     version the app saw — the server's compare-and-set lets one PC win;
//   - looks at the record after the turn and puts an unfinished one back to
//     「AI の番」 (`retry`, the member's own action, with the session).
// It never writes history and never starts an AI itself.

import type { AgentId } from '../../../shared/agents/registry'
import { agentCan } from '../../../shared/agents/registry'
import { AI_TURN_CLAIM_ACTIONS, aiTurnKindOf, readAutoTurnSettings, type AiTurnClaimResult, type AiTurnSettleResult, type AutoTurnSettings } from '../../../shared/ai-turns'
import type { RecordsApi } from '../../records/api'

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
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const CONVERSATION = /^[A-Za-z0-9-]{8,100}$/

export function createAiTurnClaims(deps: AiTurnClaimsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

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

    /** Take the record's AI turn for this consultation, or learn that another PC (or person) was first. */
    async claim(companyId: string, recordId: string, expectedVersion: number, conversationId: string): Promise<AiTurnClaimResult> {
      const kind = aiTurnKindOf(recordId)
      if (!COMPANY.test(companyId) || !kind || !Number.isInteger(expectedVersion) || expectedVersion < 1 || !CONVERSATION.test(conversationId)) {
        return { claimed: false, reason: 'not-allowed' }
      }
      const agent = deps.agent()
      if (!deps.windowOpen() || !deps.aiAllowed() || !agentCan(agent, 'recordActions')) return { claimed: false, reason: 'not-allowed' }
      const access = await deps.records.openTurn(companyId, { conversationId, agent, scope: 'act' })
      if (!access) return { claimed: false, reason: 'unavailable' }
      try {
        if (access.scope !== 'act') return { claimed: false, reason: 'not-allowed' }
        await access.call('POST', `/item/${encodeURIComponent(recordId)}/actions/${AI_TURN_CLAIM_ACTIONS[kind]}`, { expectedVersion })
        return { claimed: true }
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'OFFLINE' || code === 'SERVER_ERROR') return { claimed: false, reason: 'unavailable' }
        // VERSION_CONFLICT (another PC, or the member, was first) and any other refusal.
        return { claimed: false, reason: 'taken' }
      } finally {
        await access.close()
      }
    },

    /** After the automatic turn: finished, failed, or still in progress → back to 「AI の番」. */
    async settle(companyId: string, recordId: string): Promise<AiTurnSettleResult> {
      if (!COMPANY.test(companyId) || !aiTurnKindOf(recordId)) return { outcome: 'unknown' }
      const record = await recordOf(companyId, recordId)
      if (!record) return { outcome: 'unknown' }
      if (record.state === 'read') return { outcome: 'done' }
      if (record.state === 'failed' || record.state === 'skipped') return { outcome: 'failed' }
      if (record.state !== 'reading') return { outcome: 'unknown' }
      const r = await session(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/actions/retry`, { expectedVersion: record.version })
      if (!r || r.status >= 300) log.warn(`[ai-turns] retry: answered ${r?.status ?? 'nothing'}`)
      return { outcome: r && r.status < 300 ? 'put-back' : 'unknown' }
    },
  }
}

export type AiTurnClaims = ReturnType<typeof createAiTurnClaims>
