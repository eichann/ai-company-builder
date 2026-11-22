// The operation runner of 「ブラウザ操作」 (agent-browser.md "The runner", "Executing a plan"; design
// 6b-2 §3, §5): runs ONE plan the member approved on the server, in their open browser window. No
// Electron: the window comes in as `BrowserRunSurface` + `BrowserPreviewSurface` (electron/browser-window.ts),
// the server as `BrowserPlansApi` (the person's session; the execution's secret). NOT connected to
// the AI or the app yet: nothing imports this module (tests/browser-runner.test.ts proves it); 6b-2d
// wires the card's press to `run`.
//
// One run (model/browser-plan/PlanLife.tla names each step it copies):
//   approve (the hash the person saw) → claim (once per plan, ever: the execution, its secret — kept in
//   memory only — and the fixed content) → the fixed content must hash to the approved hash and agree
//   with the claim's plan (an older server without it: never run) → this PC's record `claimed` → the
//   type, the build's connector combination, the setting, the stop, the window → the facts read again
//   through the checker and compared with the approved ones (`browserFactsChangedProblem`) → the window
//   in `ai` mode, the checker's view (account, target, state, CSRF) → record `permit-asked` → the write
//   session prepared, then the permit (≤ 5 s, never asked twice), then the last check synchronously
//   right before the request leaves (both clocks under the permit, same context, not stopped, the
//   window open) → the page read again: exactly the state `expectedAfter` gives = succeeded, anything
//   else = unknown → the report (≤ 3 tries, the same body).
// Any stop before the permit gives the plan back (`cancel`: the server makes the execution void); a
// stop after the permit was asked and before the request left is `failed` ("not sent", provably: the
// window's write says so only when the request was never ended); once the request left — an answer,
// a refusal of the site (4xx), no answer, an error — it is never `failed` and never sent again.
import { createHash } from 'node:crypto'
import {
  browserOperationsAllowed, browserPlanProblem, expectedAfter, targetFieldsOutsideWrites,
  type BrowserPlanValues, type PluginBrowser,
} from '../../../../shared/core/plugin-browser-declaration'
import type { BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import {
  BROWSER_PLAN_TIMES, BROWSER_REPORT_REASONS, browserFactsChangedProblem, type BrowserReportResult,
} from '../../../../shared/core/browser-plans'
import { readBrowserFacts } from '../../../shared/browser-facts'
import type { BrowserHtmlDocument } from '../../../shared/browser-page'
import {
  BROWSER_PLAN_MAX_AHEAD_MS, CONTENT_HASH_RE, createRunGate, declaredWriteBody, encodeForm, FORM_CONTENT_TYPE, fixedContentMismatch,
  isBrowserRunReason, parseBrowserClaim, parseFixedContent, permitValidMs, sameTargetState,
  type BrowserChecker, type BrowserClaimed, type BrowserPageRead, type BrowserPreviewReader, type BrowserPreviewSurface,
  type BrowserRunPlan, type BrowserRunReason, type BrowserRunResult, type BrowserRunSurface, type BrowserStepRecord, type BrowserTargetState,
  type BrowserWriteOutcome,
} from '../../../shared/browser-runner'
import { buildAiSwitch, type BrowserAiSwitch } from './ai-switch'

/** The per-step states kept on this PC (run-records.ts). */
export interface BrowserRunRecords {
  /** Any record of this plan (it started once; it never runs again). Unreadable records: true. */
  has(planId: string): boolean
  /** Throws when it cannot be kept: then nothing more is done towards sending. */
  put(record: BrowserStepRecord): void
}

/** One answer of the server: its JSON, a refusal (its fixed code, if any), or none (network, time-out). */
export type BrowserApiAnswer = { kind: 'ok'; value: unknown } | { kind: 'refused'; code: string | null } | { kind: 'no-answer' }

/**
 * The server's plan routes as the runner uses them (shared/types/browser-plans.ts; 6b-2d gives the
 * HTTP client: the member's session for approve / claim / cancel / permit, the secret alone for the
 * report). None retries by itself.
 */
export interface BrowserPlansApi {
  approve(companyId: string, planId: string, contentHash: string): Promise<BrowserApiAnswer>
  claim(companyId: string, planId: string): Promise<BrowserApiAnswer>
  cancel(companyId: string, planId: string): Promise<BrowserApiAnswer>
  /** `X-ACB-Browser-Execution: <secret>`; `signal` aborts it (the app gave up waiting). */
  permit(companyId: string, executionId: string, secret: string, signal: AbortSignal): Promise<BrowserApiAnswer>
  report(executionId: string, secret: string, body: { result: BrowserReportResult; reason?: string }): Promise<BrowserApiAnswer>
}

/** The member's open window of a site, as a run uses it: the run's surface and the page-less read for the facts. */
export interface BrowserRunWindow {
  run: BrowserRunSurface
  preview: BrowserPreviewSurface
}

export interface BrowserRunnerDeps {
  /** The AI's browser operation's switch (default: the build's, off in 6b): off = refused at once, nothing asked, read or sent. */
  aiSwitch?: BrowserAiSwitch
  plans: BrowserPlansApi
  /** The connector declaration at exactly this id and version (bundled with the app for now: client/connectors/). */
  connector(id: string, version: string): PluginBrowser | null
  /** The approved combination this build carries for it (its declaration's and checker folder's hashes, facts version); null = none. */
  combination(id: string, version: string): { declarationHash: string; checkerHash: string; factsVersion: number } | null
  /** The reviewed checker of this id (handed in by the composition root; none = the type never runs). */
  checker(id: string): BrowserChecker | undefined
  /** The connector's reviewed preview reader of this id (the facts' reads say HTML or JSON by it). */
  reader(id: string): BrowserPreviewReader | undefined
  /** The site as the member's current valid policy lists it (null: off, not listed, unknown). */
  site(companyId: string, host: string): BrowserSiteSetting | null
  /** The emergency stop for the company's AI (`browserAiStopped`). */
  stopped(companyId: string): boolean
  /** The member's open window of that site (null: not open; they open it and log in first). */
  window(companyId: string, host: string): BrowserRunWindow | null
  /** The page's text → the neutral tree (features/browser/html.ts), for the facts. */
  parse(html: string): BrowserHtmlDocument
  /**
   * Captures the context now (server, sign-in, company, the browser setting's generation, the
   * conversation); the answer says whether it still holds. Asked after every await and right before
   * the request leaves.
   */
  context(): () => boolean
  records: BrowserRunRecords
  /** The wall clock (epoch ms). */
  now(): number
  /** A monotonic clock in ms (default `performance.now()`): a sleep stops it, a clock set back does not move it. */
  monoMs?(): number
  log?: Pick<Console, 'warn'>
}

/** What the card's press hands the runner: nothing else (never a fact, a hash of its own, the AI's word). */
export interface BrowserRunInput {
  companyId: string
  planId: string
  /** The fixed content's hash the person saw on the card. */
  contentHash: string
}

const OK_READ = 200
const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SERVER_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
/** A report is sent at most this many times, the same body each time (design 6b-2 §3 step 13). */
const REPORT_TRIES = 3
/** A run's own word → the report's (one list with the server, `BROWSER_REPORT_REASONS`): what changed the context. */
const REPORT_WORDS: Partial<Record<BrowserRunReason, string>> = { 'window-closed': 'context-changed', policy: 'context-changed', expired: 'context-changed' }
const sha256 = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

export function createBrowserRunner(deps: BrowserRunnerDeps) {
  const log = deps.log ?? console
  const mono = deps.monoMs ?? (() => performance.now())
  const busyWindows = new Set<string>()
  const runningPlans = new Set<string>()

  async function run(input: BrowserRunInput): Promise<BrowserRunResult> {
    const refused = (reason: BrowserRunReason, code?: string | null): BrowserRunResult =>
      ({ outcome: 'refused', reason, ...(code && SERVER_CODE_RE.test(code) ? { code } : {}) })
    // The switch first (design memo §33.3): off = nothing asked, read or sent.
    if (!(deps.aiSwitch ?? buildAiSwitch)()) return refused('off')
    const { companyId, planId, contentHash } = input
    if (typeof companyId !== 'string' || companyId.length === 0 || companyId.length > 200 || typeof planId !== 'string' || !PLAN_ID_RE.test(planId)
      || typeof contentHash !== 'string' || !CONTENT_HASH_RE.test(contentHash)) return refused('input')
    if (runningPlans.has(planId)) return refused('already-running')
    // This PC never runs a plan it has any record of (also one cut off by a crash); unreadable = refused.
    if (deps.records.has(planId)) return refused('already-ran')
    runningPlans.add(planId)
    try {
      return await runClaimed(input)
    } finally {
      runningPlans.delete(planId)
    }

    async function runClaimed({ companyId, planId, contentHash }: BrowserRunInput): Promise<BrowserRunResult> {
      const current = deps.context()
      // PlanLife.tla Approve + Claim: the same press. A lost approve answer still tries the claim (the
      // server answers it only for an approved plan).
      const approved = await ask(() => deps.plans.approve(companyId, planId, contentHash))
      if (approved.kind === 'refused') return refused('approve-refused', approved.code)
      if (!current()) return refused('context-changed')
      const claimAnswer = await ask(() => deps.plans.claim(companyId, planId))
      // A lost claim answer: the plan is used up and its secret never comes again (the server voids
      // the execution 2 minutes after the claim).
      if (claimAnswer.kind === 'no-answer') return refused('claim-unanswered')
      if (claimAnswer.kind === 'refused') return refused('claim-refused', claimAnswer.code)

      // From here the plan is claimed: every stop before the permit gives it back.
      let operationName = 'unknown'
      const record = (state: BrowserStepRecord['state'], reason?: BrowserRunReason) =>
        deps.records.put({ planId, operation: operationName, step: 0, state, ...(reason ? { reason } : {}), at: deps.now() })
      const giveBack = async (reason: BrowserRunReason): Promise<BrowserRunResult> => {
        try { record('failed', reason) } catch { /* nothing was sent either way */ }
        // PlanLife.tla AppDropsBeforePermit: claimed → void (a lost cancel: void 2 minutes after the claim).
        await ask(() => deps.plans.cancel(companyId, planId))
        return { outcome: 'stopped', reason }
      }

      const parsed = parseBrowserClaim(claimAnswer.value, deps.now())
      if ('error' in parsed) return giveBack(parsed.error === 'fixed-missing' ? 'server-too-old' : parsed.error === 'expired' ? 'expired' : 'fixed-mismatch')
      const claimed = parsed.value
      const plan = claimed.plan
      // 6b-2 §5-1 step 5: what the server fixed is what the person approved, and the plan agrees with it.
      const content = parseFixedContent(claimed.fixed.content)
      if (plan.planId !== planId || plan.companyId !== companyId || claimed.fixed.contentHash !== contentHash
        || sha256(claimed.fixed.content) !== contentHash || !content || fixedContentMismatch(content, claimed)) return giveBack('fixed-mismatch')
      operationName = plan.operation
      try { record('claimed') } catch { return giveBack('records-unavailable') }

      const connector = deps.connector(plan.connector.id, plan.connector.version)
      if (!connector) return giveBack('connector')
      // The build's own combination must be the one the plan was made and approved with.
      const combination = deps.combination(plan.connector.id, plan.connector.version)
      if (!combination || combination.declarationHash !== content.connector.declarationHash || combination.checkerHash !== content.connector.checkerHash
        || combination.factsVersion !== claimed.fixed.factsVersion) return giveBack('connector')
      const operation = Object.prototype.hasOwnProperty.call(connector.operations, plan.operation) ? connector.operations[plan.operation] : undefined
      if (!operation) return giveBack('operation')
      // One form write per type, not irreversible (the first version's rule).
      if (operation.effect === 'read' || operation.writes.length !== 1 || operation.writes[0].encoding !== 'form' || operation.irreversible) return giveBack('not-supported')
      if (!connector.account) return giveBack('connector')
      const checker = deps.checker(operation.checker)
      if (!checker || checker.id !== operation.checker) return giveBack('unknown-checker')
      if (!checker.facts || checker.facts.version !== claimed.fixed.factsVersion) return giveBack('connector')
      // A target field no write carries is held only by the checker's look at the page.
      if (targetFieldsOutsideWrites(operation).some(f => !checker.confirms.includes(f))) return giveBack('target-unconfirmed')
      const values: BrowserPlanValues = { target: plan.target, change: plan.change }
      if (browserPlanProblem(operation, values)) return giveBack('plan')
      const expected = expectedAfter(plan.before, operation, values)
      if (!expected) return giveBack('cannot-come-true')
      // A page that must look the same afterwards cannot tell a write that happened from one refused.
      if (sameTargetState(expected, plan.before)) return giveBack('no-visible-change')
      const readPaths = checker.readPaths(values)
      if (readPaths.length === 0) return giveBack('plan')

      const why = (): BrowserRunReason | null => {
        if (!current()) return 'context-changed'
        if (deps.stopped(plan.companyId)) return 'stopped'
        if (!allowedNow(connector, plan, deps.site(plan.companyId, connector.host))) return 'policy'
        if (deps.now() >= plan.expiresAt || deps.now() - plan.approvedAt > BROWSER_PLAN_MAX_AHEAD_MS) return 'expired'
        return null
      }
      const early = why()
      if (early) return giveBack(early)
      const win = deps.window(plan.companyId, connector.host)
      if (!win || win.run.closed() || win.preview.closed()) return giveBack('no-window')
      const surface = win.run
      const abort = (): BrowserRunReason | null => why() ?? (surface.closed() ? 'window-closed' : null)
      const windowKey = `${plan.companyId}\0${connector.host}`
      if (busyWindows.has(windowKey)) return giveBack('busy')
      busyWindows.add(windowKey)
      let inAi = false
      // Where the run stands: before the permit is asked (give back), after (report), after the send.
      const at: { phase: 'before-permit' | 'permit-asked' | 'sent'; notSent: BrowserRunReason | null; permitRefused: boolean } = { phase: 'before-permit', notSent: null, permitRefused: false }
      try {
        // PlanLife.tla AppRereadSame: every fixed fact read again through the checker, the same as approved.
        const reread = await readBrowserFacts({
          checker, browser: connector, operation, factsVersion: claimed.fixed.factsVersion, values,
          readers: Object.values(connector.explore).map(r => deps.reader(r.reader)).filter((r): r is BrowserPreviewReader => !!r),
          read: async address => {
            if (abort()) return 'stop'
            try {
              const answer = await win.preview.read(address)
              return abort() ? 'stop' : answer
            } catch { return abort() ? 'stop' : 'failed' }
          },
          parseHtml: deps.parse,
          now: () => new Date(deps.now()),
        })
        if (!reread.facts) return giveBack(reread.problem === 'stop' ? abort() ?? 'context-changed' : 'facts-changed')
        if (reread.checkerProblem || browserFactsChangedProblem(operation, claimed.fixed.factsVersion, content.facts, reread.facts, values)) return giveBack('facts-changed')
        let reason = abort()
        if (reason) return giveBack(reason)

        const gate = createRunGate({
          host: connector.host, operation, values, readPaths,
          stopped: () => abort() !== null,
        })
        inAi = true
        if (!(await surface.enterAi(gate.hooks))) return giveBack(abort() ?? 'window-not-ready')
        reason = abort()
        if (reason) return giveBack(reason)
        const view = await readView(surface, checker, values, readPaths)
        // A read the gate refused because the AI was stopped or the setting changed says so.
        if ('failed' in view) return giveBack(abort() ?? 'read-failed')
        reason = checkBefore(view.view, plan) ?? abort()
        if (reason) return giveBack(reason)

        const body = encodeForm(declaredWriteBody(operation, 0, values, view.view.ignored))
        const write = operation.writes[0]
        // The permit's window, counted from just before it is asked, on both clocks (6b-2 §5-3).
        let permitMs: number = BROWSER_PLAN_TIMES.permit
        let t0m = 0
        let t0w = 0
        gate.arm(0)
        let outcome: BrowserWriteOutcome
        try {
          outcome = await surface.write({ method: write.method, path: write.path, contentType: FORM_CONTENT_TYPE, body }, {
            // The write session is prepared: now the permit (PlanLife.tla AppAsksPermit; no retry).
            async ready() {
              const r = abort()
              if (r) { at.notSent = r; return false }
              // From here the write may leave: a crash leaves this record and the plan never runs here again.
              try { record('permit-asked') } catch { at.notSent = 'records-unavailable'; return false }
              t0m = mono()
              t0w = deps.now()
              at.phase = 'permit-asked'
              const answer = await askWithin(signal => deps.plans.permit(companyId, claimed.executionId, claimed.secret, signal), BROWSER_PLAN_TIMES.permit)
              if (answer.kind === 'refused') { at.permitRefused = true; return false }
              const valid = answer.kind === 'ok' ? permitValidMs(answer.value) : null
              // PlanLife.tla AppPermitUnanswered: no (usable) answer within 5 s → never sent.
              if (valid === null) { at.notSent = 'permit-unanswered'; return false }
              permitMs = Math.min(valid, BROWSER_PLAN_TIMES.permit)
              return true
            },
            // PlanLife.tla AppSends / AppStopsBeforeSend: synchronous, right before the request leaves.
            beforeSend() {
              const sinceMono = mono() - t0m
              const sinceWall = deps.now() - t0w
              if (!(sinceMono >= 0 && sinceMono < permitMs && sinceWall >= 0 && sinceWall < permitMs)) { at.notSent = 'permit-late'; return false }
              const r = abort()
              if (r) { at.notSent = r; return false }
              at.phase = 'sent'
              return true
            },
          })
        } catch {
          // The window's write never rejects for a write that did not leave: this one may have.
          outcome = at.phase === 'before-permit' ? { sent: false, stage: 'prepare' } : { sent: true, answer: null }
        } finally {
          gate.disarm()
        }

        // The last check said go, so the request may have been ended: never "not sent" then.
        if (!outcome.sent && at.phase === 'sent') outcome = { sent: true, answer: null }
        if (!outcome.sent) {
          // No permit asked (prepared, then stopped; or the window went): give the plan back.
          if (at.phase === 'before-permit') return giveBack(at.notSent ?? abort() ?? 'window-closed')
          // PlanLife.tla ServerRefusesPermit: the server made the execution void; nothing to report.
          if (at.permitRefused) {
            try { record('failed', 'permit-refused') } catch { /* nothing was sent either way */ }
            return { outcome: 'stopped', reason: 'permit-refused' }
          }
          // PlanLife.tla AppPermitUnanswered / AppStopsBeforeSend: the request never left.
          return await settle('failed', at.notSent ?? 'error')
        }
        at.phase = 'sent'
        // PlanLife.tla AppRereadAfterFails: no answer, an error, a disconnect: it may have arrived.
        if (!outcome.answer) return await settle('unknown', 'no-answer')
        // PlanLife.tla AppReadsAfter: whatever the site answered (a 4xx too), the page decides; only
        // exactly the planned state is success.
        const after = await readView(surface, checker, values, readPaths)
        if ('failed' in after) return await settle('unknown', 'reread-failed')
        if (after.view.account === null || after.view.account !== plan.account) return await settle('unknown', 'account-after')
        if (!after.view.state) return await settle('unknown', 'target-after')
        if (after.view.problem) return await settle('unknown', 'checker-problem')
        if (sameTargetState(after.view.state, expected)) return await settle('succeeded')
        return await settle('unknown', 'other-state')
      } catch (error) {
        log.warn(`[browser] a run ended unexpectedly (${error instanceof Error ? error.name : 'unknown'})`)
        // Before the permit was asked nothing can have left: give it back. After: it may have.
        if (at.phase === 'before-permit') return giveBack('error')
        return await settle('unknown', 'no-answer')
      } finally {
        if (inAi) { try { await surface.leaveAi() } catch { /* the window is gone */ } }
        busyWindows.delete(windowKey)
      }

      /** Keeps the result on this PC and reports it (the secret alone; ≤ 3 tries, the same body). */
      async function settle(state: 'succeeded' | 'failed' | 'unknown', reason?: BrowserRunReason): Promise<BrowserRunResult> {
        try { record(state, reason) } catch { log.warn('[browser] a run\'s result could not be kept') }
        await report(claimed, state, reason)
        if (state === 'succeeded') return { outcome: 'succeeded' }
        return { outcome: state, reason: reason ?? 'error' }
      }
    }
  }

  async function report(claimed: BrowserClaimed, result: BrowserReportResult, reason?: BrowserRunReason) {
    const word = reason ? REPORT_WORDS[reason] ?? reason : undefined
    const body = { result, ...(word && (BROWSER_REPORT_REASONS as readonly string[]).includes(word) ? { reason: word } : {}) }
    for (let i = 0; i < REPORT_TRIES; i++) {
      const answer = await ask(() => deps.plans.report(claimed.executionId, claimed.secret, body))
      // Kept (or refused for good): never again. Lost: the same body again; all lost → the server's time-out.
      if (answer.kind !== 'no-answer') return
    }
    log.warn('[browser] a run\'s report did not reach the server; it settles there by its time-out')
  }

  return { run }
}

export type BrowserRunner = ReturnType<typeof createBrowserRunner>

/** One server call; a throw is no answer. */
async function ask(call: () => Promise<BrowserApiAnswer>): Promise<BrowserApiAnswer> {
  try { return await call() } catch { return { kind: 'no-answer' } }
}

/** One server call given at most `ms`: then it is aborted and counts as no answer, whatever arrives later. */
async function askWithin(call: (signal: AbortSignal) => Promise<BrowserApiAnswer>, ms: number): Promise<BrowserApiAnswer> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<BrowserApiAnswer>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ kind: 'no-answer' }) }, ms) })
  try {
    return await Promise.race([ask(() => call(controller.signal)), late])
  } finally {
    clearTimeout(timer)
  }
}

/** The company's setting lets this type run on this site now (on, listed, asset hosts, level). */
function allowedNow(connector: PluginBrowser, plan: BrowserRunPlan, site: BrowserSiteSetting | null): boolean {
  if (!site || site.host !== connector.host) return false
  return browserOperationsAllowed(connector, { mode: 'on', sites: [site] }).usable.includes(plan.operation)
}

async function readView(surface: BrowserRunSurface, checker: BrowserChecker, values: BrowserPlanValues, paths: readonly string[]) {
  const reads: BrowserPageRead[] = []
  for (const path of paths) {
    let answer: { status: number; body: string }
    try { answer = await surface.request({ method: 'GET', path }) } catch { return { failed: true as const } }
    // A redirect (logged out), an error page: nothing to read the target from.
    if (answer.status !== OK_READ) return { failed: true as const }
    reads.push({ path, body: answer.body })
  }
  return { view: checker.view(values, reads) }
}

/** Why the page does not allow the write the person approved, or null. */
function checkBefore(view: ReturnType<BrowserChecker['view']>, plan: BrowserRunPlan): BrowserRunReason | null {
  if (view.account === null) return 'account-unknown'
  if (view.account !== plan.account) return 'account-mismatch'
  if (!view.state) return 'target-missing'
  if (!sameTargetState(view.state, plan.before as BrowserTargetState)) return 'before-changed'
  // The checker's word is kept only when it is one of ours (never its text).
  if (view.problem) return isBrowserRunReason(view.problem) ? view.problem : 'checker-problem'
  return null
}
