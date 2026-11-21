// The preview of 「ブラウザ操作」 (agent-browser.md "The operator and the preview", design memo §33.1
// and §33.2 steps 2–4): the operator AI chooses, main reads. No Electron: the window's read session
// comes in as `BrowserPreviewSurface`, the operator through the agent registry's factories.
//
// One request: the switch (first line: off = nothing read, no CLI checked or started) → the type, the
// member's setting, the AI stop, the open window → the CLI fixed for the request (real path, version
// floor) → up to 8 steps in 4 minutes, each one fresh CLI start (90 s) with every page read so far as
// the readers' items only, answering one JSON object: a declared read (its ids taken out of a page of
// this request) — main reads it through the window's page-less read session and runs the site's
// reviewed reader over it —, a candidate (its ids likewise; fitting the type), or a stop. Nothing is
// registered here (6b-2): the candidate comes back to the caller.
import { browserOperationsAllowed, type BrowserOperation, type PluginBrowser } from '../../../../shared/core/plugin-browser-declaration'
import type { BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import type { BrowserHtmlDocument } from '../../../shared/browser-page'
import { runExploreReader } from '../../../shared/browser-page'
import {
  BROWSER_OPERATOR_LIMITS, operatorMaterial, parseOperatorAnswer, seenValues,
  type BrowserOperatorFailure, type BrowserOperatorPage, type BrowserOperatorRequest, type BrowserOperatorStopReason,
} from '../../../shared/browser-operator'
import type { BrowserExploreReader, BrowserPreviewSurface } from '../../../shared/browser-runner'
import type { BrowserAiSwitch } from './ai-switch'

/** The CLI fixed for a request (agents/claude-browser-operator.ts `BrowserOperatorCli`). */
export interface PreviewOperatorCli {
  readonly path: string
  readonly pathDirs: readonly string[]
}

/** The operator as the agent registry gives it (`browserOperatorOf`). */
export interface PreviewOperator {
  model: string
  resolve(cliPath: string, parentEnv: Readonly<Record<string, string | undefined>>): Promise<{ ok: true; cli: PreviewOperatorCli } | { ok: false; code: BrowserOperatorFailure }>
  step(job: {
    cli: PreviewOperatorCli; model: string; material: unknown; signal: AbortSignal; timeoutMs: number
    parentEnv: Readonly<Record<string, string | undefined>>
  }): Promise<{ ok: true; text: string } | { ok: false; code: BrowserOperatorFailure | 'cancelled' }>
}

export interface BrowserPreviewDeps {
  aiSwitch: BrowserAiSwitch
  /** The connector declaration at exactly this id and version (bundled with the app for now). */
  connector(id: string, version: string): PluginBrowser | null
  /** The reviewed preview reader of this id (handed in by the composition root; none = that read never runs). */
  reader(id: string): BrowserExploreReader | undefined
  /** The site as the member's current valid policy lists it (null: off, not listed, unknown). */
  site(companyId: string, host: string): BrowserSiteSetting | null
  /** The emergency stop for the company's AI (`browserAiStopped`). */
  stopped(companyId: string): boolean
  /** The member's open, logged-in window of that site, as the preview reads through it (null: not open). */
  window(companyId: string, host: string): BrowserPreviewSurface | null
  /** The member's agent's operator (null: it has none, `capabilities.browserOperator`). */
  operator(): PreviewOperator | null
  /** The app's `claude` (services/claude-cli.ts), resolved once per request by the operator. */
  cliPath(): string
  /** The app's own environment (HOME, USER, LOGNAME, the proxy variables are taken from it). */
  parentEnv(): Readonly<Record<string, string | undefined>>
  /** The page's text → the neutral tree (features/browser/html.ts). */
  parse(html: string): BrowserHtmlDocument
  /** False once the request's context changed (sign-out, company, setting, conversation stopped). */
  stillCurrent?(): boolean
  now(): number
}

export interface BrowserPreviewRequest {
  companyId: string
  connector: { id: string; version: string }
  operation: string
  hints: BrowserOperatorRequest
  signal: AbortSignal
}

export type BrowserPreviewRefusal = 'off' | 'connector' | 'operation' | 'policy' | 'stopped' | 'no-window' | 'no-operator'

export type BrowserPreviewResult =
  /** Nothing started: no page read, no CLI checked or started. */
  | { outcome: 'refused'; reason: BrowserPreviewRefusal }
  | { outcome: 'failed'; reason: BrowserOperatorFailure | 'read-failed' | 'rounds' | 'context-changed' | 'cancelled' }
  | { outcome: 'stopped'; why: BrowserOperatorStopReason; question: string }
  | { outcome: 'candidate'; target: Record<string, string>; change: Record<string, string>; explanation: string }

const OK_READ = 200

export async function runBrowserPreview(request: BrowserPreviewRequest, deps: BrowserPreviewDeps): Promise<BrowserPreviewResult> {
  // The switch first (design memo §33.3): off = return at once.
  if (!deps.aiSwitch()) return { outcome: 'refused', reason: 'off' }
  const refused = (reason: BrowserPreviewRefusal): BrowserPreviewResult => ({ outcome: 'refused', reason })
  const failed = (reason: Extract<BrowserPreviewResult, { outcome: 'failed' }>['reason']): BrowserPreviewResult => ({ outcome: 'failed', reason })

  const connector = deps.connector(request.connector.id, request.connector.version)
  if (!connector) return refused('connector')
  const operation: BrowserOperation | undefined = Object.prototype.hasOwnProperty.call(connector.operations, request.operation)
    ? connector.operations[request.operation] : undefined
  if (!operation || operation.effect === 'read') return refused('operation')
  // Every declared read needs its reviewed reader, or the type is not previewed at all.
  if (Object.keys(connector.explore).length === 0 || Object.values(connector.explore).some(r => !deps.reader(r.reader))) return refused('connector')
  const site = deps.site(request.companyId, connector.host)
  if (!site || site.host !== connector.host || !browserOperationsAllowed(connector, { mode: 'on', sites: [site] }).usable.includes(request.operation)) return refused('policy')
  if (deps.stopped(request.companyId)) return refused('stopped')
  const firstWindow = deps.window(request.companyId, connector.host)
  if (!firstWindow || firstWindow.closed()) return refused('no-window')
  const operator = deps.operator()
  if (!operator) return refused('no-operator')

  const current = () => !request.signal.aborted && (deps.stillCurrent?.() ?? true) && !deps.stopped(request.companyId)
  const parentEnv = deps.parentEnv()
  const resolved = await operator.resolve(deps.cliPath(), parentEnv)
  if (!resolved.ok) return failed(resolved.code)
  if (!current()) return failed(request.signal.aborted ? 'cancelled' : 'context-changed')

  const deadline = deps.now() + BROWSER_OPERATOR_LIMITS.totalMs
  const pages: BrowserOperatorPage[] = []
  for (let round = 1; round <= BROWSER_OPERATOR_LIMITS.rounds; round++) {
    const left = deadline - deps.now()
    if (left <= 0) return failed('timeout')
    const material = operatorMaterial({ request: request.hints, operation, explore: connector.explore, pages, round })
    const step = await operator.step({
      cli: resolved.cli, model: operator.model, material, signal: request.signal,
      timeoutMs: Math.min(BROWSER_OPERATOR_LIMITS.roundMs, left), parentEnv,
    })
    if (!step.ok) return failed(step.code)
    if (!current()) return failed(request.signal.aborted ? 'cancelled' : 'context-changed')
    const parsed = parseOperatorAnswer(step.text, { operation, explore: connector.explore, seen: seenValues(pages) })
    if ('problem' in parsed) return failed('bad-answer')
    const answer = parsed.answer
    if (answer.do === 'stop') return { outcome: 'stopped', why: answer.why, question: answer.question }
    if (answer.do === 'candidate') return { outcome: 'candidate', target: answer.target, change: answer.change, explanation: answer.explanation }

    const surface = deps.window(request.companyId, connector.host)
    if (!surface || surface.closed()) return failed('read-failed')
    let page: { status: number; body: string }
    try { page = await surface.read(answer.path, request.signal) } catch { return failed(request.signal.aborted ? 'cancelled' : 'read-failed') }
    if (!current()) return failed(request.signal.aborted ? 'cancelled' : 'context-changed')
    // A redirect (logged out), an error page: nothing to read the items from.
    if (page.status !== OK_READ) return failed('read-failed')
    const reader = deps.reader(connector.explore[answer.read].reader) as BrowserExploreReader
    const { items, complete } = runExploreReader(reader, answer.values, deps.parse(page.body))
    pages.push({ read: answer.read, values: answer.values, items, complete })
  }
  return failed('rounds')
}
