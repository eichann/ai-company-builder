// The operation runner of 「ブラウザ操作」 (agent-browser.md "The runner"): runs ONE approved plan of a
// per-site operation type in the member's open browser window. No Electron: the window comes in as
// `BrowserRunSurface` (electron/browser-window.ts), the plan from an injected provider (the approval
// flow is a later PR). NOT connected to the AI: nothing in the app imports this module yet (the
// chat, IPC and agents cannot start a run; tests/browser-runner.test.ts proves it).
//
// One run: the plan and its type are checked → the window goes to `ai` mode with the run's gate →
// the checker reads the target (account, existence, the state the person approved) → the one
// declared write is armed and sent through the window's session → the page is read again: the state
// the operation's `expect` gives (`expectedAfter`) = succeeded, the state from before = failed, anything else or no answer = unknown (never
// sent again by itself) → back to `human` mode. Every step's state is kept on this PC before the
// send, so a plan once started never runs twice, not even after a crash.
import {
  browserOperationsAllowed, browserPlanProblem, expectedAfter, targetFieldsOutsideWrites,
  type BrowserPlanValues, type PluginBrowser,
} from '../../../../shared/core/plugin-browser-declaration'
import type { BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import {
  BROWSER_PLAN_MAX_AHEAD_MS, createRunGate, declaredWriteBody, encodeForm, FORM_CONTENT_TYPE, isBrowserRunReason, parseBrowserRunPlan, sameTargetState,
  type BrowserRunReason,
  type BrowserChecker, type BrowserPageRead, type BrowserRunPlan, type BrowserRunResult, type BrowserRunSurface,
  type BrowserStepRecord, type BrowserTargetState,
} from '../../../shared/browser-runner'

/** The per-step states kept on this PC (run-records.ts). */
export interface BrowserRunRecords {
  /** Any record of this plan (it started once; it never runs again). Unreadable records: true. */
  has(planId: string): boolean
  /** Throws when it cannot be kept: then nothing is sent. */
  put(record: BrowserStepRecord): void
}

export interface BrowserRunnerDeps {
  /** The approved plan (PR 6 adds the approval); null = none. */
  approvedPlan(planId: string): Promise<unknown>
  /** The connector declaration at exactly this id and version (bundled with the app for now: client/connectors/). */
  connector(id: string, version: string): PluginBrowser | null
  /** The reviewed checker of this id (handed in by the composition root; none = the type never runs). */
  checker(id: string): BrowserChecker | undefined
  /** The site as the member's current valid policy lists it (null: off, not listed, unknown). */
  site(companyId: string, host: string): BrowserSiteSetting | null
  /** The emergency stop for the company's AI (`browserAiStopped`). */
  stopped(companyId: string): boolean
  /** The member's open window of that site (null: not open; they open it and log in first). */
  window(companyId: string, host: string): BrowserRunSurface | null
  records: BrowserRunRecords
  now(): number
  log?: Pick<Console, 'warn'>
}

const OK_READ = 200

export function createBrowserRunner(deps: BrowserRunnerDeps) {
  const log = deps.log ?? console
  const busyWindows = new Set<string>()
  const runningPlans = new Set<string>()

  async function run(planId: string): Promise<BrowserRunResult> {
    const refused = (reason: BrowserRunReason): BrowserRunResult => ({ outcome: 'refused', reason })
    if (runningPlans.has(planId)) return refused('already-running')
    let raw: unknown
    try { raw = await deps.approvedPlan(planId) } catch { return refused('no-plan') }
    if (raw === null || raw === undefined) return refused('no-plan')
    const parsed = parseBrowserRunPlan(raw, deps.now())
    if ('error' in parsed) return refused(parsed.error === 'expired' ? 'expired' : 'plan')
    const plan = parsed.value
    if (plan.planId !== planId) return refused('plan')
    if (runningPlans.has(planId) || deps.records.has(planId)) return refused('already-ran')

    const connector = deps.connector(plan.connector.id, plan.connector.version)
    if (!connector) return refused('connector')
    const operation = Object.prototype.hasOwnProperty.call(connector.operations, plan.operation) ? connector.operations[plan.operation] : undefined
    if (!operation) return refused('operation')
    // One write per type for now (PR 5a); a type that reads only has nothing to run here.
    if (operation.effect === 'read' || operation.writes.length !== 1 || operation.writes[0].encoding !== 'form') return refused('not-supported')
    // A deletion asks once more right before it: not before the approval flow exists.
    if (operation.irreversible) return refused('not-supported')
    if (!connector.account) return refused('connector')
    const checker = deps.checker(operation.checker)
    if (!checker || checker.id !== operation.checker) return refused('unknown-checker')
    // A target field no write carries is held only by the checker's look at the page.
    if (targetFieldsOutsideWrites(operation).some(f => !checker.confirms.includes(f))) return refused('target-unconfirmed')
    const values: BrowserPlanValues = { target: plan.target, change: plan.change }
    if (browserPlanProblem(operation, values)) return refused('plan')
    // What the page must show afterwards; a removal of something the person did not see there cannot come true.
    const expected = expectedAfter(plan.before, operation, values)
    if (!expected) return refused('cannot-come-true')
    // A page that must look the same afterwards (a value added and taken away again) cannot tell a
    // write that happened from one the site refused: never claim success on it.
    if (sameTargetState(expected, plan.before)) return refused('no-visible-change')
    const readPaths = checker.readPaths(values)
    if (readPaths.length === 0) return refused('plan')

    const why = (): BrowserRunReason | null => {
      if (deps.stopped(plan.companyId)) return 'stopped'
      if (!allowedNow(connector, plan, deps.site(plan.companyId, connector.host))) return 'policy'
      if (deps.now() >= plan.expiresAt || deps.now() - plan.approvedAt > BROWSER_PLAN_MAX_AHEAD_MS) return 'expired'
      return null
    }
    const before = why()
    if (before) return refused(before)
    const surface = deps.window(plan.companyId, connector.host)
    if (!surface || surface.closed()) return refused('no-window')
    const windowKey = `${plan.companyId}\0${connector.host}`
    if (busyWindows.has(windowKey)) return refused('busy')

    const record = (state: BrowserStepRecord['state'], reason?: BrowserRunReason) =>
      deps.records.put({ planId, operation: plan.operation, step: 0, state, ...(reason ? { reason } : {}), at: deps.now() })
    try { record('pending') } catch { return refused('records-unavailable') }

    busyWindows.add(windowKey)
    runningPlans.add(planId)
    const gate = createRunGate({
      host: connector.host, operation, values, readPaths,
      stopped: () => why() !== null || surface.closed(),
    })
    // `failed` without a `sent` before it: nothing went out.
    const stop = (reason: BrowserRunReason): BrowserRunResult => {
      try { record('failed', reason) } catch { /* nothing was sent either way */ }
      return { outcome: 'stopped', reason }
    }
    try {
      if (!(await surface.enterAi(gate.hooks))) return stop('window-not-ready')
      const abort = (): BrowserRunReason | null => why() ?? (surface.closed() ? 'window-closed' : null)
      let reason = abort()
      if (reason) return stop(reason)

      const view = await readView(surface, checker, values, readPaths)
      // A read the gate refused because the AI was stopped or the setting changed says so.
      if ('failed' in view) return stop(abort() ?? 'read-failed')
      reason = checkBefore(view.view, plan)
      if (reason) return stop(reason)
      reason = abort()
      if (reason) return stop(reason)

      const body = encodeForm(declaredWriteBody(operation, 0, values, view.view.ignored))
      try { record('sent') } catch { return stop('records-unavailable') }
      gate.arm(0)
      let status: number | null = null
      try {
        status = (await surface.request({ method: operation.writes[0].method, path: operation.writes[0].path, contentType: FORM_CONTENT_TYPE, body })).status
      } catch {
        status = null
      } finally {
        gate.disarm()
      }
      if (status === null) return settle('unknown', gate.sent(0) ? 'no-answer' : 'not-confirmed-sent')

      const afterRead = await readView(surface, checker, values, readPaths)
      if ('failed' in afterRead || !afterRead.view.state) return settle('unknown', 'reread-failed')
      if (sameTargetState(afterRead.view.state, expected)) return settle('succeeded')
      if (sameTargetState(afterRead.view.state, plan.before)) {
        // Nothing found before and nothing after: the page may not be read the way we think (unknown).
        if (Object.values(plan.before).every(list => list.length === 0)) return settle('unknown', 'empty-state')
        // `failed` only when the site said no (419, 422…) and nothing changed.
        return status >= 400 && status < 500 ? settle('failed', 'refused-by-site') : settle('unknown', 'unchanged-unrefused')
      }
      return settle('unknown', 'other-state')
    } catch (error) {
      log.warn(`[browser] a run ended unexpectedly (${error instanceof Error ? error.name : 'unknown'})`)
      return settle('unknown', 'error')
    } finally {
      try { await surface.leaveAi() } catch { /* the window is gone */ }
      busyWindows.delete(windowKey)
      runningPlans.delete(planId)
    }

    function settle(state: 'succeeded' | 'failed' | 'unknown', reason?: BrowserRunReason): BrowserRunResult {
      try { record(state, reason) } catch { log.warn('[browser] a run\'s result could not be kept') }
      if (state === 'succeeded') return { outcome: 'succeeded' }
      return { outcome: state, reason: reason ?? 'error' }
    }
  }

  return { run }
}

export type BrowserRunner = ReturnType<typeof createBrowserRunner>

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

