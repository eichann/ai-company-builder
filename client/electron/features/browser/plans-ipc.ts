// The plan card's IPC (agent-browser.md "The card, the IPC and the request tool"; design 6b-2 §2, §7-1):
//   browserPlans:list     the member's own plans still waiting (draft / approved), for the inbox
//   browserPlans:get      one plan as the server fixed it + whether ［任せる］ can be pressed on this PC
//   browserPlans:run      ［任せる］: approve (the hash the card showed) + claim + the run, one press here
//   browserPlans:cancel   ［やめる］
//   browserPlans:confirm  ［済んでいた］［されていなかった］ on a result nobody knows
// Only the main window's own page may ask (`isMainFrameSender`), and every argument is checked here
// before anything reaches the server: ids of the server's exact shapes, a hash, nothing else — never a
// fact, a target or the AI's word. ［任せる］ takes only { companyId, planId, contentHash }.
import type { IpcInvokeEvent, IpcMessageEvent, IpcRegistrar } from '../../ipc/registrar'
import type { BrowserOpenPlans, BrowserPlanView } from '../../../../shared/types/browser-plans'
import type { PluginBrowser } from '../../../../shared/core/plugin-browser-declaration'
import type { BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import {
  BROWSER_COMPANY_ID_RE, BROWSER_EXECUTION_ID_RE, BROWSER_PLAN_ID_RE, BROWSER_PLAN_IPC_WORDS as W, readBrowserPlanView,
  type BrowserPlanCardData, type BrowserPlansFailure,
} from '../../../shared/browser-plans'
import { CONTENT_HASH_RE, type BrowserChecker, type BrowserPageRead, type BrowserPreviewSurface, type BrowserRunResult } from '../../../shared/browser-runner'
import { buildAiSwitch, type BrowserAiSwitch } from './ai-switch'
import type { BrowserApiAnswer } from './runner'

export interface BrowserCardReadinessDeps {
  aiSwitch?: BrowserAiSwitch
  connector(id: string, version: string): PluginBrowser | null
  checker(id: string): BrowserChecker | undefined
  site(companyId: string, host: string): BrowserSiteSetting | null
  stopped(companyId: string): boolean
  window(companyId: string, host: string): BrowserPreviewSurface | null
}

/**
 * Whether ［任せる］ can be pressed for this plan on this PC (6b-2 decision 4): the switch on, the plan
 * waiting, the site listed, the AI not stopped, its window open here and the page showing the plan's
 * own account (read through the window's page-less read session with the checker's declared reads).
 * Only a hint for the button: the runner checks everything again after the press.
 */
export async function browserCardReadiness(companyId: string, plan: BrowserPlanView, deps: BrowserCardReadinessDeps): Promise<BrowserPlanCardData['ready']> {
  if (!(deps.aiSwitch ?? buildAiSwitch)()) return { ok: false, reason: 'off' }
  if (plan.state !== 'draft') return { ok: false, reason: 'state' }
  const connector = deps.connector(plan.connector.id, plan.connector.version)
  const operation = connector && Object.prototype.hasOwnProperty.call(connector.operations, plan.operation) ? connector.operations[plan.operation] : undefined
  if (!connector || !operation || !deps.site(companyId, connector.host)) return { ok: false, reason: 'no-window' }
  if (deps.stopped(companyId)) return { ok: false, reason: 'stopped' }
  const win = deps.window(companyId, connector.host)
  if (!win || win.closed()) return { ok: false, reason: 'no-window' }
  const checker = deps.checker(operation.checker)
  if (!checker) return { ok: false, reason: 'not-logged-in' }
  const values = { target: plan.target, change: plan.change }
  try {
    const reads: BrowserPageRead[] = []
    for (const path of checker.readPaths(values)) {
      const answer = await win.read(path)
      if (answer.status !== 200) return { ok: false, reason: 'not-logged-in' }
      reads.push({ path, body: answer.body })
    }
    return reads.length > 0 && checker.view(values, reads).account === plan.account ? { ok: true } : { ok: false, reason: 'not-logged-in' }
  } catch {
    return { ok: false, reason: 'not-logged-in' }
  }
}

export interface BrowserPlansIpcDeps<E> {
  /** The event came from the main window's main frame (`isMainFrameSender`). */
  fromMainWindow: (event: E) => boolean
  plans: {
    get(companyId: string, planId: string): Promise<BrowserApiAnswer>
    open(companyId: string): Promise<BrowserApiAnswer>
    cancel(companyId: string, planId: string): Promise<BrowserApiAnswer>
    confirm(companyId: string, executionId: string, result: 'done' | 'not_done'): Promise<BrowserApiAnswer>
  }
  runner: { run(input: { companyId: string; planId: string; contentHash: string }): Promise<BrowserRunResult> }
  readiness(companyId: string, plan: BrowserPlanView): Promise<BrowserPlanCardData['ready']>
  /** This PC's latest record of the plan says it stopped before sending (`stoppedBeforeSending`). */
  stoppedHere(planId: string): boolean
  /** The operated host of a connector this build bundles, or null. */
  siteHost(connectorId: string, version: string): string | null
}

const BAD_INPUT: BrowserPlansFailure = { ok: false, offline: false, message: W.badInput }
// A consultation window shows the card too, but only the main window may act on it.
const NOT_MAIN: BrowserPlansFailure = { ok: false, offline: false, message: W.notMainWindow }

function failure(answer: BrowserApiAnswer): BrowserPlansFailure {
  if (answer.kind === 'no-answer') return { ok: false, offline: true, message: W.offline }
  if (answer.kind === 'refused' && (answer.code === 'BROWSER_PLAN_NOT_FOUND' || answer.code === 'BROWSER_EXECUTION_NOT_FOUND')) return { ok: false, offline: false, message: W.notFound }
  if (answer.kind === 'refused' && answer.code === 'BROWSER_TOO_EARLY') return { ok: false, offline: false, message: W.tooEarly }
  if (answer.kind === 'refused' && answer.code !== null && /^BROWSER_(ALREADY_SETTLED|NOT_PERMITTED|PLAN_NOT_OPEN|PLAN_NOT_DRAFT|PLAN_EXPIRED|EXECUTION_CLOSED)$/.test(answer.code)) return { ok: false, offline: false, message: W.settled }
  return { ok: false, offline: false, message: W.serverError }
}

const companyOk = (v: unknown): v is string => typeof v === 'string' && BROWSER_COMPANY_ID_RE.test(v)
const planOk = (v: unknown): v is string => typeof v === 'string' && BROWSER_PLAN_ID_RE.test(v)

export function registerBrowserPlansIpc<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E, IpcMessageEvent>, deps: BrowserPlansIpcDeps<E>): void {
  const running = new Set<string>()

  ipc.handle('browserPlans:list', async (event, companyId) => {
    if (!deps.fromMainWindow(event)) return NOT_MAIN
    if (!companyOk(companyId)) return BAD_INPUT
    const answer = await deps.plans.open(companyId)
    if (answer.kind !== 'ok' || !answer.value || typeof answer.value !== 'object' || !Array.isArray((answer.value as { items?: unknown }).items)) return failure(answer)
    return { ok: true as const, plans: answer.value as BrowserOpenPlans }
  })

  ipc.handle('browserPlans:get', async (event, companyId, planId) => {
    if (!deps.fromMainWindow(event)) return NOT_MAIN
    if (!companyOk(companyId) || !planOk(planId)) return BAD_INPUT
    const answer = await deps.plans.get(companyId, planId)
    // Only the fields the card reads, each of its shape (a copy): nothing else of the answer reaches the renderer.
    const plan = answer.kind === 'ok' ? readBrowserPlanView(answer.value) : null
    if (!plan || plan.id !== planId) return answer.kind === 'ok' ? { ok: false as const, offline: false, message: W.serverError } : failure(answer)
    const runningHere = running.has(planId)
    const ready: BrowserPlanCardData['ready'] = runningHere ? { ok: false, reason: 'busy' } : await deps.readiness(companyId, plan)
    return { ok: true as const, card: { plan, ready, stoppedHere: deps.stoppedHere(planId), runningHere, siteHost: deps.siteHost(plan.connector.id, plan.connector.version) } }
  })

  ipc.handle('browserPlans:run', async (event, companyId, planId, contentHash) => {
    if (!deps.fromMainWindow(event)) return NOT_MAIN
    if (!companyOk(companyId) || !planOk(planId) || typeof contentHash !== 'string' || !CONTENT_HASH_RE.test(contentHash)) return BAD_INPUT
    if (running.has(planId)) return { ok: true as const, result: { outcome: 'refused' as const, reason: 'already-running' as const } }
    running.add(planId)
    try {
      return { ok: true as const, result: await deps.runner.run({ companyId, planId, contentHash }) }
    } finally {
      running.delete(planId)
    }
  })

  ipc.handle('browserPlans:cancel', async (event, companyId, planId) => {
    if (!deps.fromMainWindow(event)) return NOT_MAIN
    if (!companyOk(companyId) || !planOk(planId)) return BAD_INPUT
    const answer = await deps.plans.cancel(companyId, planId)
    return answer.kind === 'ok' ? { ok: true as const } : failure(answer)
  })

  ipc.handle('browserPlans:confirm', async (event, companyId, executionId, result) => {
    if (!deps.fromMainWindow(event)) return NOT_MAIN
    if (!companyOk(companyId) || typeof executionId !== 'string' || !BROWSER_EXECUTION_ID_RE.test(executionId)
      || (result !== 'done' && result !== 'not_done')) return BAD_INPUT
    const answer = await deps.plans.confirm(companyId, executionId, result)
    return answer.kind === 'ok' ? { ok: true as const } : failure(answer)
  })
}
