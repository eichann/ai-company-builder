// The server's routes of opened lines that a read-only inspection uses (agent-browser.md "The inspection in the chat";
// server/src/routes/browser-lines.ts): make the inspection's plan, report its result once, tell a shape change. The
// member's session (cookies) for every call. What is sent is the request's own line and values, the result in fixed
// words (each read's status, each check's mark) and the notice's map names and counts — never a value the site showed.
// No call retries by itself.
//
// Since PR 5c also a plan of writes (write-line-runner.ts, write-lines.ts): the draft (with the account the app read), its
// approve / claim / cancel and the person's confirm with the session; a write's permit with the session AND the execution's
// secret in its header; a write's report with the secret alone (the member may have left), never the session. The secret
// goes only in `X-ACB-Browser-Execution`, never an address or a body, and is never logged. Ids go into an address only
// in the server's own shapes (`bl_` / `bw_` + 32 hex).
//
// This PC's key (agent-browser.md "This PC's registration"; device.ts) goes in `X-ACB-Browser-Device` **only on the
// steps the server's gate asks** — a plan's creation (inspection or writes), approve, claim, every permit — and only
// while this PC has a key; never on get, cancel, confirm, the result, the notice or the report.
import type { BrowserShapeNotice } from '../../../../shared/core/browser-map'
import type { BrowserLineRef } from '../../../../shared/types/browser-lines'
import type { BrowserSuppliedValue } from '../../../../shared/core/browser-read-line'
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import { BROWSER_LINE_PLAN_ID_RE } from '../../../shared/browser-inspection'
import type { BrowserInspectionReport, BrowserLineReporter } from './read-line-runner'
import { BROWSER_EXECUTION_HEADER } from './plans-api'
import { BROWSER_DEVICE_HEADER } from '../../../../shared/core/browser-device'
import { BROWSER_RUN_ID_RE } from '../../../../shared/core/browser-run-log'
import type { BrowserRunFinish } from '../../../../shared/types/browser-runs'

/** A server answer (the same three kinds as the plans' client; this module never imports the old path's runner). */
export type BrowserLinesAnswer = { kind: 'ok'; value: unknown } | { kind: 'refused'; code: string | null } | { kind: 'no-answer' }

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const EXEC_ID_RE = /^bw_[0-9a-f]{32}$/
const SECRET_RE = /^[A-Za-z0-9_-]{32,200}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/

export interface BrowserLinesHttpDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  /** This PC's key header value (device.ts), or null when this PC has none: sent on the gated steps only. */
  deviceKey?: () => string | null
  /** Each call's own limit (default 15 s). */
  timeoutMs?: number
}

export interface BrowserLinesHttp extends BrowserLineReporter {
  /** `POST /browser-line-plans { line, values, conversationId? }`: an inspection's plan (the server's gate decides). */
  createInspection(companyId: string, body: { line: BrowserLineRef; values: Record<string, BrowserSuppliedValue>; conversationId?: string }): Promise<BrowserLinesAnswer>
}

/** The routes a plan of writes uses (PR 5c). */
export interface BrowserLineWritesApi {
  /** `POST /browser-line-plans { line, values, account, conversationId? }`: a draft (the server's gate and the values' sources). */
  createWrites(companyId: string, body: { line: BrowserLineRef; values: Record<string, BrowserSuppliedValue>; account: string; conversationId?: string }): Promise<BrowserLinesAnswer>
  get(companyId: string, planId: string): Promise<BrowserLinesAnswer>
  approve(companyId: string, planId: string, contentHash: string): Promise<BrowserLinesAnswer>
  claim(companyId: string, planId: string): Promise<BrowserLinesAnswer>
  cancel(companyId: string, planId: string): Promise<BrowserLinesAnswer>
  /** One write's permit: the session and the secret in its header; `signal` aborts it (the app gave up waiting). */
  permit(companyId: string, executionId: string, secret: string, index: number, signal: AbortSignal): Promise<BrowserLinesAnswer>
  /** One write's report: the secret alone (no session). */
  report(secret: string, body: { index: number; result: 'done' | 'not_sent' | 'unknown'; reason?: string; createdId?: string }): Promise<BrowserLinesAnswer>
  confirm(companyId: string, executionId: string, index: number, result: 'done' | 'not_done'): Promise<BrowserLinesAnswer>
}

/** The operator's runs (agent-browser.md "The operator's window tools"; server routes/browser-runs.ts). */
export interface BrowserRunsApi {
  /** `POST /browser-runs { host, conversationId?, frameRunId? }` + this PC's key: the server's gate and the company × domain lock. */
  runStart(companyId: string, body: { host: string; conversationId?: string; frameRunId?: string; write?: true }): Promise<BrowserLinesAnswer>
  /** `POST /browser-runs/:runId/continue` + this PC's key: the gate again before a step; the lease renewed. */
  runContinue(companyId: string, runId: string): Promise<BrowserLinesAnswer>
  /** `POST /browser-runs/:runId/finish { outcome, reason?, steps }`: the log (no value) and the lock released. */
  runFinish(companyId: string, runId: string, body: BrowserRunFinish): Promise<BrowserLinesAnswer>
}

const refusedLocally: BrowserLinesAnswer = { kind: 'refused', code: null }

/**
 * A write run's frames (agent-browser.md "Writes within frames"; server routes/browser-frames.ts): start, approve, permit
 * and a sure report carry this PC's key; get and end are the member's session alone. The one-time approval value goes only
 * in the approve body, from main's memory (never an AI tool's answer).
 */
export interface BrowserFramesApi {
  frameStart(companyId: string, body: { skill: string; conversationId?: string } | { plan: { domain: string; writes: unknown[] }; conversationId?: string }): Promise<BrowserLinesAnswer>
  frameApprove(companyId: string, runId: string, body: { planHash: string; approvalToken: string }): Promise<BrowserLinesAnswer>
  framePermit(companyId: string, runId: string, body: { frame: number; request: { method: string; path: string; fields: Record<string, string> } }): Promise<BrowserLinesAnswer>
  frameReport(companyId: string, runId: string, body: { write: number; result: 'done' | 'not_sent' | 'unknown'; reason?: string }): Promise<BrowserLinesAnswer>
  frameEnd(companyId: string, runId: string): Promise<BrowserLinesAnswer>
}

const FRAME_RUN_ID_RE = /^bf_[0-9a-f]{32}$/
const APPROVAL_TOKEN_RE = /^[0-9a-f]{64}$/

export function createBrowserLinesHttp(deps: BrowserLinesHttpDeps): BrowserLinesHttp & BrowserLineWritesApi & BrowserRunsApi & BrowserFramesApi {
  const doFetch = deps.fetch ?? fetch

  /** 2xx with `data` → ok; 4xx → refused (the server's code); anything else → no answer. */
  async function post(path: string, body: unknown, opts: { method?: 'GET' | 'POST'; session?: boolean; secret?: string; signal?: AbortSignal; device?: true } = {}): Promise<BrowserLinesAnswer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const session = opts.session ?? true
    const cookies = session ? deps.cookies() : []
    if (!base || (session && cookies.length === 0)) return { kind: 'no-answer' }
    const method = opts.method ?? 'POST'
    const headers: Record<string, string> = method === 'POST' ? { 'Content-Type': 'application/json' } : {}
    if (session) headers.Cookie = cookies.join('; ')
    if (opts.secret !== undefined) headers[BROWSER_EXECUTION_HEADER] = opts.secret
    if (opts.device) {
      const key = deps.deviceKey?.() ?? null
      if (key) headers[BROWSER_DEVICE_HEADER] = key
    }
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? 15_000)
    try {
      const res = await doFetch(`${base}${path}`, {
        method, redirect: 'error', cache: 'no-store', headers,
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
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

  const planOk = (companyId: string, planId: string) => companyOk(companyId) && BROWSER_LINE_PLAN_ID_RE.test(planId)
  const execOk = (companyId: string, executionId: string) => companyOk(companyId) && EXEC_ID_RE.test(executionId)

  const frameOk = (companyId: string, runId: string) => companyOk(companyId) && FRAME_RUN_ID_RE.test(runId)

  return {
    frameStart: async (companyId, body) => companyOk(companyId) ? post(`${company(companyId)}/browser-frame-runs`, body, { device: true }) : refusedLocally,
    frameApprove: async (companyId, runId, body) => frameOk(companyId, runId) && HASH_RE.test(body.planHash) && APPROVAL_TOKEN_RE.test(body.approvalToken)
      ? post(`${company(companyId)}/browser-frame-runs/${runId}/approve`, { planHash: body.planHash, approvalToken: body.approvalToken }, { device: true }) : refusedLocally,
    framePermit: async (companyId, runId, body) => frameOk(companyId, runId) && Number.isSafeInteger(body.frame) && body.frame >= 1
      ? post(`${company(companyId)}/browser-frame-runs/${runId}/permit`, { frame: body.frame, request: body.request }, { device: true }) : refusedLocally,
    // A sure answer (done / not_sent) counts only from the run's own PC: the key goes with every report.
    frameReport: async (companyId, runId, body) => frameOk(companyId, runId) && Number.isSafeInteger(body.write) && body.write >= 1
      ? post(`${company(companyId)}/browser-frame-runs/${runId}/report`, body, { device: true }) : refusedLocally,
    frameEnd: async (companyId, runId) => frameOk(companyId, runId) ? post(`${company(companyId)}/browser-frame-runs/${runId}/end`, {}) : refusedLocally,
    createWrites: async (companyId, body) => companyOk(companyId) && typeof body.account === 'string'
      ? post(`${company(companyId)}/browser-line-plans`, body, { device: true }) : refusedLocally,
    get: async (companyId, planId) => planOk(companyId, planId) ? post(`${company(companyId)}/browser-line-plans/${planId}`, null, { method: 'GET' }) : refusedLocally,
    approve: async (companyId, planId, contentHash) => planOk(companyId, planId) && HASH_RE.test(contentHash)
      ? post(`${company(companyId)}/browser-line-plans/${planId}/approve`, { contentHash }, { device: true }) : refusedLocally,
    claim: async (companyId, planId) => planOk(companyId, planId) ? post(`${company(companyId)}/browser-line-plans/${planId}/claim`, {}, { device: true }) : refusedLocally,
    cancel: async (companyId, planId) => planOk(companyId, planId) ? post(`${company(companyId)}/browser-line-plans/${planId}/cancel`, {}) : refusedLocally,
    permit: async (companyId, executionId, secret, index, signal) => execOk(companyId, executionId) && SECRET_RE.test(secret) && Number.isSafeInteger(index) && index >= 1
      ? post(`${company(companyId)}/browser-line-executions/${executionId}/permit`, { index }, { secret, signal, device: true }) : refusedLocally,
    // The secret alone proves it (server `ownCredential`): no session goes with it.
    report: async (secret, body) => SECRET_RE.test(secret)
      ? post('/api/browser-line-executions/report', body, { session: false, secret }) : refusedLocally,
    confirm: async (companyId, executionId, index, result) => execOk(companyId, executionId) && Number.isSafeInteger(index) && index >= 1
      ? post(`${company(companyId)}/browser-line-executions/${executionId}/confirm`, { index, result }) : refusedLocally,
    // The operator's runs (agent-browser.md "The operator's window tools"): the start and every continue are gated (this PC's
    // key); the finish is clean-up (the log and the lock), never gated.
    runStart: async (companyId, body) => companyOk(companyId) ? post(`${company(companyId)}/browser-runs`, body, { device: true }) : refusedLocally,
    runContinue: async (companyId, runId) => companyOk(companyId) && BROWSER_RUN_ID_RE.test(runId)
      ? post(`${company(companyId)}/browser-runs/${runId}/continue`, {}, { device: true }) : refusedLocally,
    runFinish: async (companyId, runId, body) => companyOk(companyId) && BROWSER_RUN_ID_RE.test(runId)
      ? post(`${company(companyId)}/browser-runs/${runId}/finish`, body) : refusedLocally,
    createInspection: async (companyId, body) => companyOk(companyId) ? post(`${company(companyId)}/browser-line-plans`, body, { device: true }) : refusedLocally,
    // The result: exactly { reads, checks } (fixed words), once per plan; the runner calls it only for a judged run.
    result: async (companyId: string, planId: string, report: BrowserInspectionReport) => companyOk(companyId) && BROWSER_LINE_PLAN_ID_RE.test(planId)
      ? post(`${company(companyId)}/browser-line-plans/${planId}/result`, { reads: report.reads, checks: report.checks }) : refusedLocally,
    // The notice: exactly the server's five keys, rebuilt here too (no key name can ride along).
    notice: async (companyId: string, n: BrowserShapeNotice) => companyOk(companyId)
      ? post(`${company(companyId)}/browser-shape-notices`, { site: n.site, mapVersion: n.mapVersion, thing: n.thing, change: n.change, count: n.count }) : refusedLocally,
  }
}
