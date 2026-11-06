// Where a business plugin step's consultation may write (plugin-steps.md "The deliverable folder"),
// main's part. A step's automatic run is known from main's own claim (`automatic`); a person's
// consultation started from a step is bound on the server for good, so its folder is asked of the
// server once per consultation and app run (`GET /me/plugin-steps/consultations/:id`) and kept.
// Not readable (offline, an older server): no area this turn and nothing kept — the write guard
// then judges as for any consultation (a client check may allow when unsure).

import { deliverableFolderProblem } from '../../../../shared/core/plugin-step-runs'

export interface StepWriteAreaDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** The deliverable folder of an automatic step run this app holds for the consultation, or null. */
  automatic: (conversationId: string) => string | null
  fetch?: typeof fetch
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const CONVERSATION = /^[A-Za-z0-9-]{8,100}$/

export function createStepWriteAreas(deps: StepWriteAreaDeps) {
  const doFetch = deps.fetch ?? fetch
  /** company + consultation → its folder (null: not a step's consultation), as the server answered. */
  const known = new Map<string, string | null>()
  const keyOf = (companyId: string, conversationId: string) => `${companyId}\n${conversationId}`

  return {
    /** The folder a consultation's writes are held to this turn, or null (an ordinary consultation, or unknown). */
    async areaOf(companyId: string, conversationId: string): Promise<string | null> {
      const automatic = deps.automatic(conversationId)
      if (automatic !== null) return automatic
      if (!COMPANY.test(companyId) || !CONVERSATION.test(conversationId)) return null
      const key = keyOf(companyId, conversationId)
      if (known.has(key)) return known.get(key) ?? null
      const base = deps.baseUrl().replace(/\/+$/, '')
      const cookies = deps.cookies()
      if (!base || cookies.length === 0) return null
      try {
        const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/plugin-steps/consultations/${encodeURIComponent(conversationId)}`, {
          redirect: 'error', signal: AbortSignal.timeout(3_000), headers: { Cookie: cookies.join('; ') },
        })
        if (res.status !== 200) return null
        const json = await res.json().catch(() => null) as { data?: { step?: { deliverableFolder?: unknown } | null } } | null
        const step = json?.data?.step
        if (step === null) { known.set(key, null); return null }
        const folder = step?.deliverableFolder
        if (typeof folder !== 'string' || deliverableFolderProblem(folder) !== null) return null
        known.set(key, folder)
        return folder
      } catch {
        return null
      }
    },
    /** A consultation was just bound to a step: ask the server again on its next turn. */
    forget(companyId: string, conversationId: string): void {
      known.delete(keyOf(companyId, conversationId))
    },
  }
}

export type StepWriteAreas = ReturnType<typeof createStepWriteAreas>
