// The server's plan routes for 「ブラウザ操作」 (agent-browser.md "The card, the IPC and the request tool";
// server/src/routes/browser-plans.ts): the runner's `BrowserPlansApi` and what the card and the
// registration read. The member's session (cookies) for everything under the company; the report
// carries the execution's secret alone (the member may have left since), never the session. The
// secret goes only in its header, never in an address or a body, and is never logged. No call
// retries by itself (the runner decides: the permit is asked once, the report at most three times).
import type { BrowserPlanInput, BrowserReportInput } from '../../../../shared/types/browser-plans'
import { BROWSER_COMPANY_ID_RE, BROWSER_EXECUTION_ID_RE, BROWSER_PLAN_ID_RE } from '../../../shared/browser-plans'
import type { BrowserApiAnswer, BrowserPlansApi } from './runner'

/** The header carrying an execution's secret (server: `BROWSER_EXECUTION_HEADER`). */
export const BROWSER_EXECUTION_HEADER = 'X-ACB-Browser-Execution'
const SECRET_RE = /^[A-Za-z0-9_-]{32,200}$/
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export interface BrowserPlansHttpDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  /** Each call's own limit (default 15 s); the permit's caller also aborts it after 5 s. */
  timeoutMs?: number
}

export interface BrowserPlansHttp extends BrowserPlansApi {
  register(companyId: string, input: BrowserPlanInput): Promise<BrowserApiAnswer>
  get(companyId: string, planId: string): Promise<BrowserApiAnswer>
  open(companyId: string): Promise<BrowserApiAnswer>
  confirm(companyId: string, executionId: string, result: 'done' | 'not_done'): Promise<BrowserApiAnswer>
}

const refusedLocally: BrowserApiAnswer = { kind: 'refused', code: null }

export function createBrowserPlansHttp(deps: BrowserPlansHttpDeps): BrowserPlansHttp {
  const doFetch = deps.fetch ?? fetch

  /**
   * One request. 2xx with `data` → ok; 4xx → refused (the server's code); anything else — no
   * connection, a time-out, an abort, a 5xx, an answer that does not read — → no answer.
   */
  async function call(path: string, init: { method: 'GET' | 'POST'; body?: unknown; session: boolean; secret?: string; signal?: AbortSignal }): Promise<BrowserApiAnswer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    if (!base) return { kind: 'no-answer' }
    const headers: Record<string, string> = {}
    if (init.session) {
      const cookies = deps.cookies()
      if (cookies.length === 0) return { kind: 'no-answer' }
      headers.Cookie = cookies.join('; ')
    }
    if (init.secret !== undefined) headers[BROWSER_EXECUTION_HEADER] = init.secret
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const limit = AbortSignal.timeout(deps.timeoutMs ?? 15_000)
    try {
      const res = await doFetch(`${base}${path}`, {
        method: init.method, redirect: 'error', cache: 'no-store', headers,
        signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      })
      const json = await res.json().catch(() => null) as Record<string, unknown> | null
      if (res.status >= 200 && res.status < 300 && json && json.data !== undefined) return { kind: 'ok', value: json.data }
      if (res.status >= 400 && res.status < 500) {
        const code = typeof json?.code === 'string' && CODE_RE.test(json.code) ? json.code : null
        return { kind: 'refused', code }
      }
      return { kind: 'no-answer' }
    } catch {
      return { kind: 'no-answer' }
    }
  }

  const company = (companyId: string) => `/api/companies/${companyId}`
  const plan = (companyId: string, planId: string) => `${company(companyId)}/browser-plans/${planId}`
  const okIds = (companyId: string, planId?: string) => BROWSER_COMPANY_ID_RE.test(companyId) && (planId === undefined || BROWSER_PLAN_ID_RE.test(planId))

  return {
    approve: async (companyId, planId, contentHash) => okIds(companyId, planId)
      ? call(`${plan(companyId, planId)}/approve`, { method: 'POST', body: { contentHash }, session: true }) : refusedLocally,
    claim: async (companyId, planId) => okIds(companyId, planId) ? call(`${plan(companyId, planId)}/claim`, { method: 'POST', session: true }) : refusedLocally,
    cancel: async (companyId, planId) => okIds(companyId, planId) ? call(`${plan(companyId, planId)}/cancel`, { method: 'POST', session: true }) : refusedLocally,
    permit: async (companyId, executionId, secret, signal) => okIds(companyId) && BROWSER_EXECUTION_ID_RE.test(executionId) && SECRET_RE.test(secret)
      ? call(`${company(companyId)}/browser-executions/${executionId}/send-permit`, { method: 'POST', session: true, secret, signal }) : refusedLocally,
    // The secret alone proves it (server `ownCredential`): no session goes with it.
    report: async (_executionId, secret, body: BrowserReportInput) => SECRET_RE.test(secret)
      ? call('/api/browser-executions/report', { method: 'POST', session: false, secret, body }) : refusedLocally,
    register: async (companyId, input) => okIds(companyId) ? call(`${company(companyId)}/browser-plans`, { method: 'POST', body: input, session: true }) : refusedLocally,
    get: async (companyId, planId) => okIds(companyId, planId) ? call(plan(companyId, planId), { method: 'GET', session: true }) : refusedLocally,
    open: async companyId => okIds(companyId) ? call(`${company(companyId)}/browser-plans-open`, { method: 'GET', session: true }) : refusedLocally,
    confirm: async (companyId, executionId, result) => okIds(companyId) && BROWSER_EXECUTION_ID_RE.test(executionId) && (result === 'done' || result === 'not_done')
      ? call(`${company(companyId)}/browser-executions/${executionId}/confirm`, { method: 'POST', body: { result }, session: true }) : refusedLocally,
  }
}
