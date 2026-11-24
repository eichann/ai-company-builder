// The server's routes of opened lines that a read-only inspection uses (agent-browser.md "The inspection in the chat";
// server/src/routes/browser-lines.ts): make the inspection's plan, report its result once, tell a shape change. The
// member's session (cookies) for every call. What is sent is the request's own line and values, the result in fixed
// words (each read's status, each check's mark) and the notice's map names and counts — never a value the site showed.
// No call retries by itself.
import type { BrowserShapeNotice } from '../../../../shared/core/browser-map'
import type { BrowserLineRef } from '../../../../shared/types/browser-lines'
import type { BrowserSuppliedValue } from '../../../../shared/core/browser-read-line'
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import { BROWSER_LINE_PLAN_ID_RE } from '../../../shared/browser-inspection'
import type { BrowserInspectionReport, BrowserLineReporter } from './read-line-runner'

/** A server answer (the same three kinds as the plans' client; this module never imports the old path's runner). */
export type BrowserLinesAnswer = { kind: 'ok'; value: unknown } | { kind: 'refused'; code: string | null } | { kind: 'no-answer' }

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export interface BrowserLinesHttpDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  /** Each call's own limit (default 15 s). */
  timeoutMs?: number
}

export interface BrowserLinesHttp extends BrowserLineReporter {
  /** `POST /browser-line-plans { line, values, conversationId? }`: an inspection's plan (the server's gate decides). */
  createInspection(companyId: string, body: { line: BrowserLineRef; values: Record<string, BrowserSuppliedValue>; conversationId?: string }): Promise<BrowserLinesAnswer>
}

const refusedLocally: BrowserLinesAnswer = { kind: 'refused', code: null }

export function createBrowserLinesHttp(deps: BrowserLinesHttpDeps): BrowserLinesHttp {
  const doFetch = deps.fetch ?? fetch

  /** 2xx with `data` → ok; 4xx → refused (the server's code); anything else → no answer. */
  async function post(path: string, body: unknown): Promise<BrowserLinesAnswer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return { kind: 'no-answer' }
    try {
      const res = await doFetch(`${base}${path}`, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      })
      const json = await res.json().catch(() => null) as Record<string, unknown> | null
      if (res.status >= 200 && res.status < 300 && json && json.data !== undefined) return { kind: 'ok', value: json.data }
      if (res.status >= 400 && res.status < 500) return { kind: 'refused', code: typeof json?.code === 'string' && CODE_RE.test(json.code) ? json.code : null }
      return { kind: 'no-answer' }
    } catch {
      return { kind: 'no-answer' }
    }
  }

  const company = (companyId: string) => `/api/companies/${companyId}`
  const companyOk = (companyId: string) => BROWSER_COMPANY_ID_RE.test(companyId)

  return {
    createInspection: async (companyId, body) => companyOk(companyId) ? post(`${company(companyId)}/browser-line-plans`, body) : refusedLocally,
    // The result: exactly { reads, checks } (fixed words), once per plan; the runner calls it only for a judged run.
    result: async (companyId: string, planId: string, report: BrowserInspectionReport) => companyOk(companyId) && BROWSER_LINE_PLAN_ID_RE.test(planId)
      ? post(`${company(companyId)}/browser-line-plans/${planId}/result`, { reads: report.reads, checks: report.checks }) : refusedLocally,
    // The notice: exactly the server's five keys, rebuilt here too (no key name can ride along).
    notice: async (companyId: string, n: BrowserShapeNotice) => companyOk(companyId)
      ? post(`${company(companyId)}/browser-shape-notices`, { site: n.site, mapVersion: n.mapVersion, thing: n.thing, change: n.change, count: n.count }) : refusedLocally,
  }
}
