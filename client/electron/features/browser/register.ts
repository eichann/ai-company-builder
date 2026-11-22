// Making a plan from the consultation's request (agent-browser.md "The card, the IPC and the request
// tool"; design 6b-2 §3 steps 1–4): the switch (off: nothing read, started or sent) → the preview (6b-1:
// the operator chooses, main reads) → the checker reads the facts through the window's page-less read
// session (6b-2b) — never anything the AI said — → `POST /browser-plans` with the member's session and
// this build's own combination. The plan then waits on the server for the member's card; nothing here
// approves, claims or sends. No Electron: everything comes in as deps (wired in main.ts).
import type { BrowserPlanInput } from '../../../../shared/types/browser-plans'
import type { PluginBrowser } from '../../../../shared/core/plugin-browser-declaration'
import { readBrowserFacts } from '../../../shared/browser-facts'
import type { BrowserHtmlDocument } from '../../../shared/browser-page'
import type { BrowserOperatorRequest } from '../../../shared/browser-operator'
import { BROWSER_PLAN_ID_RE } from '../../../shared/browser-plans'
import type { BrowserChecker, BrowserPreviewReader, BrowserPreviewSurface } from '../../../shared/browser-runner'
import { buildAiSwitch, type BrowserAiSwitch } from './ai-switch'
import type { CarriedCombination } from './combination'
import type { BrowserPreviewRequest, BrowserPreviewResult } from './preview'
import type { BrowserApiAnswer } from './runner'

export interface BrowserRegistrationRequest {
  companyId: string
  /** The consultation it came from (stored with the plan; the card opens there). */
  conversationId: string | null
  connector: { id: string; version: string }
  operation: string
  hints: BrowserOperatorRequest
  /** The turn's signal: the member's or an administrator's stop ends the request. */
  signal: AbortSignal
}

/** Words for the tool's answer (`BROWSER_REQUEST_WORDS`), never a fact or the page's text. */
export type BrowserRegistrationFailure = 'off' | 'notAllowed' | 'noWindow' | 'noOperator' | 'facts' | 'refused' | 'failed' | 'badInput'

export type BrowserRegistrationResult =
  | { outcome: 'registered'; planId: string }
  | { outcome: 'not-found'; question: string }
  | { outcome: 'not-made'; why: BrowserRegistrationFailure }

export interface BrowserRegistrationDeps {
  /** Default: the build's switch (off in 6b). Off = nothing read, started or sent. */
  aiSwitch?: BrowserAiSwitch
  /** The preview of 6b-1 (`runBrowserPreview` with the composition's deps and this request's context). */
  preview(request: BrowserPreviewRequest, stillCurrent: () => boolean): Promise<BrowserPreviewResult>
  connector(id: string, version: string): PluginBrowser | null
  /** This build's own combination (combination.ts); none = no plan. */
  combination(id: string, version: string): CarriedCombination | null
  checker(id: string): BrowserChecker | undefined
  reader(id: string): BrowserPreviewReader | undefined
  /** The member's open window of the site, as main reads through it (its page-less read session). */
  window(companyId: string, host: string): BrowserPreviewSurface | null
  parse(html: string): BrowserHtmlDocument
  plans: { register(companyId: string, input: BrowserPlanInput): Promise<BrowserApiAnswer> }
  /** The context now; the answer says whether it still holds (sign-in, company setting, the turn). */
  context(scope: { companyId: string; signal?: AbortSignal }): () => boolean
  now(): number
  log?: Pick<Console, 'warn'>
}

const notMade = (why: BrowserRegistrationFailure): BrowserRegistrationResult => ({ outcome: 'not-made', why })

export async function registerBrowserPlan(request: BrowserRegistrationRequest, deps: BrowserRegistrationDeps): Promise<BrowserRegistrationResult> {
  // The switch first (design memo §33.3): off = no page read, no CLI started, no server call.
  if (!(deps.aiSwitch ?? buildAiSwitch)()) return notMade('off')
  const { companyId, connector: key, operation: operationName } = request
  const connector = deps.connector(key.id, key.version)
  const combination = deps.combination(key.id, key.version)
  const operation = connector && Object.prototype.hasOwnProperty.call(connector.operations, operationName) ? connector.operations[operationName] : undefined
  if (!connector || !combination || !operation) return notMade('notAllowed')
  const checker = deps.checker(operation.checker)
  if (!checker || checker.id !== operation.checker || !checker.facts || checker.facts.version !== combination.factsVersion) return notMade('notAllowed')
  const current = deps.context({ companyId, signal: request.signal })

  const preview = await deps.preview({ companyId, connector: key, operation: operationName, hints: request.hints, signal: request.signal }, current)
  if (preview.outcome === 'refused') {
    if (preview.reason === 'off') return notMade('off')
    if (preview.reason === 'no-window') return notMade('noWindow')
    if (preview.reason === 'no-operator') return notMade('noOperator')
    return notMade('notAllowed')
  }
  if (preview.outcome === 'stopped') return { outcome: 'not-found', question: preview.question }
  if (preview.outcome !== 'candidate') return notMade('failed')
  if (!current()) return notMade('failed')

  // The facts the person approves are read by main through the reviewed checker (6b-2b), never taken
  // from the operator's candidate beyond its ids.
  const win = deps.window(companyId, connector.host)
  if (!win || win.closed()) return notMade('noWindow')
  const values = { target: preview.target, change: preview.change }
  const read = await readBrowserFacts({
    checker, browser: connector, operation, factsVersion: combination.factsVersion, values,
    readers: Object.values(connector.explore).map(r => deps.reader(r.reader)).filter((r): r is BrowserPreviewReader => !!r),
    read: async address => {
      if (!current() || win.closed()) return 'stop'
      try {
        const answer = await win.read(address)
        return current() ? answer : 'stop'
      } catch { return current() ? 'failed' : 'stop' }
    },
    parseHtml: deps.parse,
    now: () => new Date(deps.now()),
  })
  if (!read.facts) return notMade(read.problem === 'stop' ? 'failed' : 'facts')
  // A required fact unknown or not read whole, or the checker's own problem: no plan (availability, never a guess).
  if (read.problem || read.checkerProblem) return notMade('facts')
  if (!current()) return notMade('failed')

  const answer = await deps.plans.register(companyId, {
    connector: key, operation: operationName,
    declarationHash: combination.declarationHash, checkerHash: combination.checkerHash, factsVersion: combination.factsVersion,
    target: values.target, change: values.change, facts: read.facts,
    ...(preview.explanation ? { explanation: preview.explanation.slice(0, 2000) } : {}),
    ...(request.conversationId ? { conversationId: request.conversationId } : {}),
  }).catch((): BrowserApiAnswer => ({ kind: 'no-answer' }))
  if (answer.kind === 'refused') {
    (deps.log ?? console).warn(`[browser] the server did not take a plan (${answer.code ?? 'no code'})`)
    return notMade('refused')
  }
  if (answer.kind !== 'ok') return notMade('failed')
  const planId = (answer.value as { id?: unknown } | null)?.id
  if (typeof planId !== 'string' || !BROWSER_PLAN_ID_RE.test(planId)) return notMade('failed')
  return { outcome: 'registered', planId }
}
