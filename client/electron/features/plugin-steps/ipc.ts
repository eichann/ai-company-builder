// A business plugin's `start: person` steps (plan C5, .claude/rules/plugin-steps.md), main's part:
//   pluginSteps:onRecord  the person steps at a record's state (its card's buttons)
//   pluginSteps:start     a person starts one: the server pins the work's procedure (its first run)
//                         and answers it; main reads the pinned text on this PC (procedures.ts) and
//                         answers the consultation's first message. Nothing else leaves main.
// The consultation is the member's own (their rights, their tools); the server's pin is what the
// work keeps for later runs.

import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'
import {
  parsePluginStepsOn, parseProcedurePin, pluginStepConsultationTitle, pluginStepPersonMessage, type PluginStepProcedurePin, type PluginStepButton,
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

export function registerPluginStepsIpc(ipc: IpcRegistrar, deps: PluginStepsIpcDeps): void {
  const doFetch = deps.fetch ?? fetch

  async function session(companyId: string, method: 'GET' | 'POST', path: string): Promise<{ status: number; data: unknown; error?: string } | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { Cookie: cookies.join('; ') },
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
    const view = r.data as { label?: unknown; procedure?: unknown; version?: unknown; pin?: unknown } | undefined
    const pin = parseProcedurePin(view?.pin)
    if (!pin || typeof view?.label !== 'string' || typeof view.procedure !== 'string') return { ok: false, error: NOT_STARTED } as const
    const text = await deps.readProcedure(companyId, pin, view.procedure, root).catch(() => null)
    if (text === null) return { ok: false, error: NOT_HERE } as const
    return {
      ok: true,
      title: pluginStepConsultationTitle(view.label),
      message: pluginStepPersonMessage({ label: view.label, recordId, procedure: text, source: pin.source }),
    } as const
  })
}
