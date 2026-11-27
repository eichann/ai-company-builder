// A Skill's draft made from the member's own recordings, from main (agent-browser.md "A Skill's draft from a recording",
// PR 2): the server's `/browser-skill-drafts` routes with the member's session — never this PC's key (nothing here writes
// to a site), never the recordings' own routes (`/browser-recordings`: an owner / admin reads everyone's there). The
// consultation AI's tool (`browser_skill_draft`, browser-request/skill-draft-tool.ts) is the only caller.
import type { BrowserSkillDraftDetail, BrowserSkillDraftsList } from '../../../../shared/types/browser-skill-drafts'
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import { DRAFT_ID_RE } from '../../../shared/browser-skill-drafts'

/** The server's answer: the value, a refusal (its plain Japanese sentence and code, as the server wrote them), or none. */
export type DraftsAnswer<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'refused'; status: number; error: string | null; code: string | null; extra: { version?: string; problem?: string; write?: number } }
  | { kind: 'no-answer' }

export interface BrowserSkillDraftsHttpDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  timeoutMs?: number
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function createBrowserSkillDraftsHttp(deps: BrowserSkillDraftsHttpDeps) {
  const doFetch = deps.fetch ?? fetch
  async function call<T>(companyId: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<DraftsAnswer<T>> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0 || !BROWSER_COMPANY_ID_RE.test(companyId)) return { kind: 'no-answer' }
    const headers: Record<string, string> = { Cookie: cookies.join('; ') }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      const res = await doFetch(`${base}/api/companies/${companyId}/browser-skill-drafts${path}`, {
        method, redirect: 'error', cache: 'no-store', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
      })
      const json = await res.json().catch(() => null) as Record<string, unknown> | null
      if (res.status >= 200 && res.status < 300 && isMap(json) && isMap(json.data)) return { kind: 'ok', value: json.data as T }
      if (res.status >= 400 && res.status < 500) {
        const extra: { version?: string; problem?: string; write?: number } = {}
        if (typeof json?.version === 'string' && /^sha256:[0-9a-f]{64}$/.test(json.version)) extra.version = json.version
        if (typeof json?.problem === 'string' && /^[a-z-]{1,40}$/.test(json.problem)) extra.problem = json.problem
        if (Number.isSafeInteger(json?.write)) extra.write = json?.write as number
        return {
          kind: 'refused', status: res.status,
          // The server's sentence is plain Japanese for the member; anything else is not passed on.
          error: typeof json?.error === 'string' && json.error.length <= 200 ? json.error : null,
          code: typeof json?.code === 'string' && /^[A-Z_]{1,60}$/.test(json.code) ? json.code : null,
          extra,
        }
      }
      return { kind: 'no-answer' }
    } catch {
      return { kind: 'no-answer' }
    }
  }
  const draftPath = (draftId: string) => (DRAFT_ID_RE.test(draftId) ? `/${draftId}` : null)
  return {
    list: (companyId: string) => call<BrowserSkillDraftsList>(companyId, 'GET', ''),
    async get(companyId: string, draftId: string): Promise<DraftsAnswer<BrowserSkillDraftDetail>> {
      const p = draftPath(draftId)
      return p ? call(companyId, 'GET', p) : { kind: 'no-answer' }
    },
    async save(companyId: string, draftId: string, body: { expectedVersion: string; name?: string; steps?: string; declaration?: string }): Promise<DraftsAnswer<BrowserSkillDraftDetail>> {
      const p = draftPath(draftId)
      return p ? call(companyId, 'PUT', p, body) : { kind: 'no-answer' }
    },
    remake: (companyId: string, body: { recordingIds: string[]; name?: string; replaces?: string }) => call<BrowserSkillDraftDetail>(companyId, 'POST', '', body),
    async remove(companyId: string, draftId: string): Promise<DraftsAnswer<{ deleted: true }>> {
      const p = draftPath(draftId)
      return p ? call(companyId, 'DELETE', p) : { kind: 'no-answer' }
    },
  }
}
export type BrowserSkillDraftsHttp = ReturnType<typeof createBrowserSkillDraftsHttp>
