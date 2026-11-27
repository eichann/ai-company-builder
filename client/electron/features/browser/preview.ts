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
//
// A paginated read (`pages` in the declaration, design memo §38): the operator asks for the read once;
// main reads page 1, then — only when the reader reports a `last_page` within the declared `max` —
// pages 2..last_page in order, each address built from the declaration with main's own page number
// (`explorePath`), and hands the operator one merged list that never names a page (`readPages`).
import {
  BROWSER_DECLARATION_LIMITS, browserOperationsAllowed, explorePath,
  type BrowserExploreRead, type BrowserOperation, type PluginBrowser,
} from '../../../../shared/core/plugin-browser-declaration'
import type { BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import type { BrowserHtmlDocument } from '../../../shared/browser-page'
import { runExploreReader } from '../../../shared/browser-page'
import { runJsonExploreReader, type BrowserJsonExploreResult } from '../../../shared/browser-json'
import {
  BROWSER_OPERATOR_LIMITS, operatorMaterial, parseOperatorAnswer, previewProblem, seenValues,
  type BrowserOperatorFailure, type BrowserOperatorImage, type BrowserOperatorPage, type BrowserOperatorRequest, type BrowserOperatorStopReason,
} from '../../../shared/browser-operator'
import type { BrowserExploreItem, BrowserJsonExploreReader, BrowserPreviewReader, BrowserPreviewSurface } from '../../../shared/browser-runner'
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
    /** The window tools' fixed prompt (agent-browser.md "The operator's window tools"); absent: the preview's. */
    prompt?: 'browse' | 'work-preview' | 'work'
    /** The window tools' screen image (memory only, for this step: agent-browser.md "The operator sees the screen"). */
    image?: BrowserOperatorImage | null
  }): Promise<{ ok: true; text: string } | { ok: false; code: BrowserOperatorFailure | 'cancelled' }>
}

export interface BrowserPreviewDeps {
  aiSwitch: BrowserAiSwitch
  /** The connector declaration at exactly this id and version (bundled with the app for now). */
  connector(id: string, version: string): PluginBrowser | null
  /** The reviewed preview reader of this id (handed in by the composition root; none = that read never runs). */
  reader(id: string): BrowserPreviewReader | undefined
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
  stillCurrent(): boolean
  now(): number
}

export interface BrowserPreviewRequest {
  companyId: string
  connector: { id: string; version: string }
  operation: string
  hints: BrowserOperatorRequest
  signal: AbortSignal
}

export type BrowserPreviewRefusal = 'off' | 'connector' | 'operation' | 'not-previewable' | 'policy' | 'stopped' | 'no-window' | 'no-operator'

export type BrowserPreviewResult =
  /** Nothing started: no page read, no CLI checked or started. */
  | { outcome: 'refused'; reason: BrowserPreviewRefusal }
  | { outcome: 'failed'; reason: BrowserOperatorFailure | 'read-failed' | 'rounds' | 'context-changed' | 'cancelled' }
  | { outcome: 'stopped'; why: BrowserOperatorStopReason; question: string }
  | { outcome: 'candidate'; target: Record<string, string>; change: Record<string, string>; explanation: string }

const OK_READ = 200

/** A paginated read's merged list: at most this many items (10 pages of 50, design memo §38). */
export const BROWSER_PAGED_ITEMS = BROWSER_DECLARATION_LIMITS.explorePages * 50

type PageRead = (address: string, page: number) => Promise<{ status: number; body: string } | 'failed' | 'stop'>

/**
 * One declared JSON read, its pages merged (design memo §38). A read without `pages` is one answer: if
 * its reader reports where it stands, whole only as its only page (`current_page` 1, `last_page` 1).
 * With `pages`, page 1 is the operator's read (`firstAddress`, built from the declaration); pages
 * 2..last are main's: only when page 1 reports `last_page` ≤ the declared `max` and `total` ≤
 * `BROWSER_PAGED_ITEMS`, in order, each address `explorePath(read, values, n)`. **A list that cannot be
 * read whole offers nothing** (nothing of it is chosen from — not even the pages before): page 1 not
 * saying where it stands, more than `max` pages or `BROWSER_PAGED_ITEMS` items, a failed later page, a
 * page that does not say where it stands, a `current_page` other than the one asked, a `last_page` or
 * `total` other than page 1's, an id seen twice in the read (on one page or across pages), or — every
 * entry kept — a count other than `total`. Entries a reader leaves out (another folder, no name) make
 * the merged list incomplete, as in any read. Page 1 failing is the read failing. `'stop'` from
 * `fetch`: the request ended (context, cancel, time).
 */
export async function readPages(
  read: BrowserExploreRead, values: Readonly<Record<string, string>>, firstAddress: string,
  reader: BrowserJsonExploreReader, fetch: PageRead,
): Promise<{ items: BrowserExploreItem[]; complete: boolean } | 'failed' | 'stop'> {
  if (!read.pages) {
    const page = await fetch(firstAddress, 1)
    if (page === 'stop' || page === 'failed') return page
    if (page.status !== OK_READ) return 'failed'
    const result = runJsonExploreReader(reader, values, page.body)
    const only = !result.page || (result.page.current === 1 && result.page.last === 1)
    return { items: result.items, complete: result.complete && only }
  }
  const nothing = { items: [] as BrowserExploreItem[], complete: false }
  const max = read.pages.max
  const items: BrowserExploreItem[] = []
  const seen = new Set<string>()
  let first: { last: number; total: number } | null = null
  let whole = true
  for (let n = 1; ; n++) {
    const address = n === 1 ? firstAddress : explorePath(read, values, n)
    if (!address) return nothing
    const page = await fetch(address, n)
    if (page === 'stop') return 'stop'
    if (page === 'failed' || page.status !== OK_READ) return n === 1 ? 'failed' : nothing
    const result: BrowserJsonExploreResult = runJsonExploreReader(reader, values, page.body)
    const at = result.page
    if (!at || at.current !== n) return nothing
    if (!first) {
      if (at.last > max || at.total > BROWSER_PAGED_ITEMS) return nothing
      first = { last: at.last, total: at.total }
    } else if (at.last !== first.last || at.total !== first.total) return nothing
    const keys = result.items.map(item => `${item.field}\n${item.value}`)
    if (keys.some(k => seen.has(k)) || new Set(keys).size !== keys.length) return nothing
    if (items.length + result.items.length > BROWSER_PAGED_ITEMS) return nothing
    for (const k of keys) seen.add(k)
    items.push(...result.items)
    whole &&= result.complete
    if (n >= first.last) {
      if (whole && items.length !== first.total) return nothing
      return { items, complete: whole }
    }
  }
}

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
  // Every declared read needs its reviewed reader, or the type is not previewed at all; a paginated
  // read's reader must be a JSON one (only it reports where a page stands).
  if (Object.keys(connector.explore).length === 0 || Object.values(connector.explore).some(r => {
    const reader = deps.reader(r.reader)
    return !reader || (r.pages !== undefined && !('answer' in reader))
  })) return refused('connector')
  // A type its declared reads can never complete (no read to start from, an id field no reader takes
  // out) fails closed here, before anything is read or started.
  if (previewProblem(operation, connector.explore, id => deps.reader(id)?.fields)) return refused('not-previewable')
  const site = deps.site(request.companyId, connector.host)
  if (!site || site.host !== connector.host || !browserOperationsAllowed(connector, { mode: 'on', sites: [site] }).usable.includes(request.operation)) return refused('policy')
  if (deps.stopped(request.companyId)) return refused('stopped')
  const firstWindow = deps.window(request.companyId, connector.host)
  if (!firstWindow || firstWindow.closed()) return refused('no-window')
  const operator = deps.operator()
  if (!operator) return refused('no-operator')

  // The context includes the window: the one open when the request started (a window closed and opened
  // again is another window, even on the same site).
  const current = () => !request.signal.aborted && deps.stillCurrent() && !deps.stopped(request.companyId)
    && !firstWindow.closed() && deps.window(request.companyId, connector.host) === firstWindow
  const parentEnv = deps.parentEnv()
  // The 4 minutes count from before the CLI's version check.
  const deadline = deps.now() + BROWSER_OPERATOR_LIMITS.totalMs
  const resolved = await operator.resolve(deps.cliPath(), parentEnv)
  if (!resolved.ok) return failed(resolved.code)
  if (!current()) return failed(request.signal.aborted ? 'cancelled' : 'context-changed')

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

    const declared = connector.explore[answer.read]
    const reader = deps.reader(declared.reader) as BrowserPreviewReader
    let stop: BrowserPreviewResult | null = null
    const fetch: PageRead = async (address, n) => {
      // Main's own later pages stay within the request's 4 minutes: none starts after it, and one
      // still waiting when it comes is cut off (the request's stop and the deadline, one signal).
      const left = deadline - deps.now()
      if (n > 1 && left <= 0) { stop = failed('timeout'); return 'stop' }
      const cut = new AbortController()
      const onStop = () => cut.abort()
      request.signal.addEventListener('abort', onStop, { once: true })
      const timer = n > 1 ? setTimeout(() => cut.abort(), left) : null
      let page: { status: number; body: string }
      try { page = await firstWindow.read(address, cut.signal) } catch {
        if (request.signal.aborted) { stop = failed('cancelled'); return 'stop' }
        if (cut.signal.aborted) { stop = failed('timeout'); return 'stop' }
        if (!current()) { stop = failed('context-changed'); return 'stop' }
        return 'failed'
      } finally {
        if (timer) clearTimeout(timer)
        request.signal.removeEventListener('abort', onStop)
      }
      if (!current()) { stop = failed(request.signal.aborted ? 'cancelled' : 'context-changed'); return 'stop' }
      return page
    }
    let read: { items: BrowserExploreItem[]; complete: boolean }
    if ('answer' in reader) {
      // A JSON reader gets each answer parsed strictly; a paginated read is read page by page by main.
      const got = await readPages(declared, answer.values, answer.path, reader, fetch)
      if (got === 'stop') return stop ?? failed('context-changed')
      // A redirect (logged out), an error page: nothing to read the items from.
      if (got === 'failed') return failed('read-failed')
      read = got
    } else {
      const page = await fetch(answer.path, 1)
      if (page === 'stop') return stop ?? failed('context-changed')
      if (page === 'failed' || page.status !== OK_READ) return failed('read-failed')
      read = runExploreReader(reader, answer.values, deps.parse(page.body))
    }
    pages.push({ read: answer.read, values: answer.values, items: read.items, complete: read.complete })
  }
  return failed('rounds')
}
