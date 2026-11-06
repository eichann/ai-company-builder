// A business plugin's `start: person` steps (plan C5, .claude/rules/plugin-steps.md), main's part:
//   pluginSteps:onRecord  the person steps at a record's state (its card's buttons)
//   pluginSteps:start     a person starts one: the server pins the work's procedure (its first run)
//                         and answers it; main reads the pinned text on this PC (procedures.ts) and
//                         answers the consultation's first message. Nothing else leaves main.
//   pluginSteps:deliverables  what a step made for a record (its やること's 確かめる点, files, mail
//                         draft: shared/step-deliverables.ts), read with the session, for its card
// The consultation is the member's own (their rights, their tools); the server's pin is what the
// work keeps for later runs.

import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'
import type { RecordDetail, RecordSummary } from '../../../../shared/types/records'
import { deliverableTaskOf, stepDeliverablesOf, type StepDeliverablesView } from '../../../shared/step-deliverables'
import {
  parsePluginStepsOn, parseProcedurePin, pluginStepConsultationTitle, pluginStepPersonMessage, stepDeliverableFolder, type PluginStepProcedurePin, type PluginStepButton,
} from '../../../shared/ai-turn-steps/plugin'

export interface PluginStepsIpcDeps {
  baseUrl: () => string
  cookies: () => string[]
  readProcedure: (companyId: string, pin: PluginStepProcedurePin, file: string, companyRoot: string | null) => Promise<string | null>
  paths: PathGuard
  fetch?: typeof fetch
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/
const NOT_STARTED = 'この手順を始められませんでした。少し待ってからもう一度ためしてください'
const NOT_HERE = 'この手順の手順書がまだこの PC にありません。同期してから、もう一度ためしてください'

/**
 * Bind a consultation to the person step it was started from (`POST /me/plugin-steps/consultations`,
 * the chat server asks before the first turn): true when the server bound it (or had already).
 */
export function createPersonStepBinder(deps: Pick<PluginStepsIpcDeps, 'baseUrl' | 'cookies' | 'fetch'>) {
  const doFetch = deps.fetch ?? fetch
  return async (companyId: string, conversationId: string, step: { recordId: string; pluginId: string; step: string }): Promise<boolean> => {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0 || !COMPANY.test(companyId)) return false
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/plugin-steps/consultations`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, recordId: step.recordId, pluginId: step.pluginId, step: step.step }),
      })
      return res.status === 200
    } catch {
      return false
    }
  }
}

export function registerPluginStepsIpc(ipc: IpcRegistrar, deps: PluginStepsIpcDeps): void {
  const doFetch = deps.fetch ?? fetch

  async function session(companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: unknown; error?: string } | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const json = await res.json().catch(() => null) as { data?: unknown; error?: unknown } | null
      return { status: res.status, data: json?.data, ...(typeof json?.error === 'string' ? { error: json.error } : {}) }
    } catch {
      return null
    }
  }

  ipc.handle('pluginSteps:onRecord', async (_event, companyId, recordId): Promise<PluginStepButton[]> => {
    if (typeof companyId !== 'string' || !COMPANY.test(companyId) || typeof recordId !== 'string' || !ID.test(recordId)) return []
    const r = await session(companyId, 'GET', `/me/plugin-steps/records/${encodeURIComponent(recordId)}`)
    const steps = r?.status === 200 ? parsePluginStepsOn(r.data) ?? [] : []
    return steps.filter(s => s.start === 'person').map(s => ({ pluginId: s.pluginId, step: s.step, label: s.label }))
  })

  ipc.handle('pluginSteps:deliverables', async (_event, companyId, recordId): Promise<StepDeliverablesView | null> => {
    if (typeof companyId !== 'string' || !COMPANY.test(companyId) || typeof recordId !== 'string' || !ID.test(recordId)) return null
    const q = await session(companyId, 'POST', '/records/query', { type: 'task', link: { name: 'bundle', id: recordId }, limit: 20 })
    const records = q?.status === 200 ? (q.data as { records?: unknown } | undefined)?.records : undefined
    const taskId = Array.isArray(records) ? deliverableTaskOf(records as RecordSummary[]) : null
    if (!taskId || !ID.test(taskId)) return null
    const d = await session(companyId, 'GET', `/records/item/${encodeURIComponent(taskId)}`)
    const detail = d?.status === 200 ? d.data as RecordDetail | undefined : undefined
    return detail?.record && Array.isArray(detail.links) ? stepDeliverablesOf(detail) : null
  })

  ipc.handle('pluginSteps:start', async (_event, companyId, recordId, pluginId, step, companyRoot) => {
    // The company folder (a company Skill pinned as the procedure is read there): checked first.
    let root: string | null = null
    if (companyRoot !== undefined && companyRoot !== null) {
      try { root = deps.paths.validate(String(companyRoot)) } catch { return { ok: false, error: NOT_STARTED } as const }
    }
    if (![companyId, recordId, pluginId, step].every(v => typeof v === 'string') || !COMPANY.test(companyId) || !ID.test(recordId) || !ID.test(pluginId) || !ID.test(step)) {
      return { ok: false, error: NOT_STARTED } as const
    }
    const r = await session(companyId, 'POST', `/me/plugin-steps/records/${encodeURIComponent(recordId)}/${encodeURIComponent(pluginId)}/${encodeURIComponent(step)}/start`)
    if (!r || r.status >= 300) return { ok: false, error: r?.error ?? NOT_STARTED } as const
    const view = r.data as { label?: unknown; procedure?: unknown; version?: unknown; pin?: unknown; deliverableFolder?: unknown } | undefined
    const pin = parseProcedurePin(view?.pin)
    if (!pin || typeof view?.label !== 'string' || typeof view.procedure !== 'string') return { ok: false, error: NOT_STARTED } as const
    const text = await deps.readProcedure(companyId, pin, view.procedure, root).catch(() => null)
    if (text === null) return { ok: false, error: NOT_HERE } as const
    return {
      ok: true,
      title: pluginStepConsultationTitle(view.label),
      message: pluginStepPersonMessage({
        label: view.label, recordId, procedure: text, source: pin.source,
        deliverableFolder: stepDeliverableFolder({ step, label: view.label, deliverableFolder: view.deliverableFolder }),
      }),
    } as const
  })
}
