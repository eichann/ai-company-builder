/**
 * The operation runner of 「ブラウザ操作」 (agent-browser.md "The runner"): the approved plan's shape,
 * the one gate every request of a run passes (`createRunGate`), what a checker is, and the words.
 * Pure (no Node, DOM or Electron): the runner (electron/features/browser/runner.ts) drives it, the
 * shell's window (electron/browser-window.ts) asks it per request.
 *
 * Owner decisions 2026-11-20: every automated operation goes through this gate; only per-site
 * operation types, never free clicking. 2026-11-21 (design memo §24): a type is data (the
 * connector's declaration: its writes and what the target must show after them); the only site
 * code is a checker (below), handed in by the composition root — this module names no site.
 */
import {
  BROWSER_ID_VALUE_RE, BROWSER_NAME_RE, matchDeclaredWrite,
  type BrowserOperation, type BrowserPlanValues,
} from '../../shared/core/plugin-browser-declaration'

// ---------------------------------------------------------------------------
// The approved plan
// ---------------------------------------------------------------------------

/** What a checker reads of a target: named lists of ids only (never a text of the site). */
export type BrowserTargetState = Readonly<Record<string, readonly string[]>>

/**
 * A plan a person approved (the approval itself is a later PR; here it comes from an injected
 * provider). Fixed: the connector at one version, one operation type, the outside account it is
 * bound to, the target and change values, the state the person saw before (`before`), an expiry.
 */
export interface BrowserRunPlan {
  planId: string
  companyId: string
  connector: { id: string; version: string }
  operation: string
  /** The outside account's id as the checker reads it from the page. */
  account: string
  target: Readonly<Record<string, string>>
  change: Readonly<Record<string, string>>
  before: BrowserTargetState
  /** Epoch ms when a person approved it: a plan approved more than a day ago never runs, whatever its expiry. */
  approvedAt: number
  /** Epoch ms; a plan runs only before it, and never more than a day ahead. */
  expiresAt: number
}

export const BROWSER_PLAN_MAX_AHEAD_MS = 24 * 60 * 60 * 1000
const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const STATE_LIMITS = { keys: 10, entries: 500 } as const
/** A clock a minute ahead of ours is not a plan "approved in the future". */
const CLOCK_SKEW_MS = 60_000

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

function stringRecord(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) {
    if (!BROWSER_NAME_RE.test(k) || typeof x !== 'string') return null
    out[k] = x
  }
  return out
}

export function parseTargetState(v: unknown): BrowserTargetState | null {
  if (!isRecord(v) || Object.keys(v).length > STATE_LIMITS.keys) return null
  const out: Record<string, string[]> = {}
  for (const [k, list] of Object.entries(v)) {
    if (!BROWSER_NAME_RE.test(k) || !Array.isArray(list) || list.length > STATE_LIMITS.entries) return null
    if (!list.every(x => typeof x === 'string' && BROWSER_ID_VALUE_RE.test(x))) return null
    out[k] = [...list as string[]]
  }
  return out
}

/** A plan as the provider handed it, checked field by field (its values against the type come later). */
export function parseBrowserRunPlan(input: unknown, now: number): { value: BrowserRunPlan } | { error: string } {
  if (!isRecord(input)) return { error: 'plan' }
  const { planId, companyId, connector, operation, account, target, change, before, approvedAt, expiresAt } = input
  if (typeof planId !== 'string' || !PLAN_ID_RE.test(planId)) return { error: 'planId' }
  if (typeof companyId !== 'string' || companyId.length === 0 || companyId.length > 200) return { error: 'companyId' }
  if (!isRecord(connector) || typeof connector.id !== 'string' || !CONNECTOR_ID_RE.test(connector.id)
    || typeof connector.version !== 'string' || !VERSION_RE.test(connector.version)) return { error: 'connector' }
  if (typeof operation !== 'string' || !BROWSER_NAME_RE.test(operation)) return { error: 'operation' }
  if (typeof account !== 'string' || !BROWSER_ID_VALUE_RE.test(account)) return { error: 'account' }
  const t = stringRecord(target)
  const c = stringRecord(change)
  if (!t) return { error: 'target' }
  if (!c) return { error: 'change' }
  const b = parseTargetState(before)
  if (!b) return { error: 'before' }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return { error: 'expiresAt' }
  if (expiresAt <= now) return { error: 'expired' }
  if (expiresAt > now + BROWSER_PLAN_MAX_AHEAD_MS) return { error: 'expiresAt' }
  if (typeof approvedAt !== 'number' || !Number.isFinite(approvedAt) || approvedAt > now + CLOCK_SKEW_MS) return { error: 'approvedAt' }
  if (now - approvedAt > BROWSER_PLAN_MAX_AHEAD_MS) return { error: 'expired' }
  return { value: { planId, companyId, connector: { id: connector.id, version: connector.version }, operation, account, target: t, change: c, before: b, approvedAt, expiresAt } }
}

/** The same lists with the same entries (order inside a list ignored: a page may list them in any order). */
export function sameTargetState(a: BrowserTargetState, b: BrowserTargetState): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every(k => {
    const x = [...a[k]].sort()
    const y = [...b[k]].sort()
    return x.length === y.length && x.every((v, i) => v === y[i])
  })
}

// ---------------------------------------------------------------------------
// Checkers (reviewed; a site's live in client/connectors/<site>/, agent-browser.md "The checker")
// ---------------------------------------------------------------------------

/** One page the runner read for the checker (GET of a declared read path, the window's login). */
export interface BrowserPageRead {
  path: string
  body: string
}

export interface BrowserCheckerView {
  /** The outside account the page shows (null: it cannot be told: the run stops before any write). */
  account: string | null
  /** The target's state, or null when the target is not exactly one existing item. */
  state: BrowserTargetState | null
  /** Values for the declared write's `ignore_body` keys, read from the page (a CSRF token). */
  ignored: Readonly<Record<string, string>>
  /** Something the write needs is missing from the page: stop before writing. */
  problem?: string
}

/**
 * Reads, right before and after a write, only what the request itself does not carry: that the
 * target is exactly one existing item (of the planned parent), the outside account, the state, and
 * the CSRF / session values. Exploring the page and planning are the AI's; guarding is this, never
 * the AI's (a page can tell the AI anything). What the state must be afterwards is the operation's
 * `expect` (`expectedAfter`), not the checker's: one checker serves every operation on its thing.
 */
export interface BrowserChecker {
  /** `<site>.<thing>`, as a declaration's `checker` names it. */
  readonly id: string
  /**
   * The target fields this checker confirms on the page before any write. A target field that no
   * declared write carries must be one of these, or the runner refuses the plan: nothing else would
   * hold the request to it.
   */
  readonly confirms: readonly string[]
  /** The exact paths (no query) the checker reads for these values: the only reads a run allows besides the page's parts. */
  readPaths(values: BrowserPlanValues): string[]
  view(values: BrowserPlanValues, reads: readonly BrowserPageRead[]): BrowserCheckerView
}

// ---------------------------------------------------------------------------
// The gate of one run
// ---------------------------------------------------------------------------

/** A read of the window's own page in a run (DevTools Fetch's `resourceType`). */
export interface BrowserPageReadAttempt {
  url: string
  resourceType: string
}

/** A request from outside the page (the runner's own, through the window's session). */
export interface BrowserSessionRequest {
  method: string
  url: string
  /** The body the network sees; undefined when it is not plain bytes (a file, a blob) or there is none. */
  body?: string
}

export type BrowserGateDecision = { allow: true } | { allow: false; reason: string }

/** What a run hands the window (`BrowserRunSurface.enterAi`). */
export interface BrowserRunGateHooks {
  stopped(): boolean
  /** The page's own reads of the operated host. Its writes are always refused during a run. */
  pageRead(read: BrowserPageReadAttempt): boolean
  /** Every request to the operated host from outside the page (the runner's own). */
  sessionRequest(request: BrowserSessionRequest): BrowserGateDecision
}

/** The window as a run uses it (electron/browser-window.ts). */
export interface BrowserRunSurface {
  /** `ai` mode with the run's gate; true only once the gate sees every request of the page. */
  enterAi(hooks: BrowserRunGateHooks): Promise<boolean>
  leaveAi(): Promise<void>
  /** A request through the window's session (its login), never through the page; rejects = no answer. */
  request(request: { method: string; path: string; contentType?: string; body?: string }): Promise<{ status: number; body: string }>
  closed(): boolean
}

/** The page's parts (scripts, styles, images, fonts) load as they are; any other read only on a declared path. */
const PAGE_PART_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font'])
const READ_METHODS = new Set(['GET', 'HEAD'])

function splitUrl(url: string, host: string): { path: string; query: boolean } | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password || parsed.hostname !== host) return null
  // The raw path as sent (no decoding): everything after the authority up to `?` / `#`.
  const rest = url.replace(/^https:\/\/[^/?#]*/i, '')
  const cut = rest.search(/[?#]/)
  return { path: cut < 0 ? rest : rest.slice(0, cut), query: cut >= 0 }
}

/** `application/x-www-form-urlencoded` → the pairs in order, repeats kept (matchDeclaredWrite refuses them). */
export function formPairs(body: string): Array<[string, string]> {
  return [...new URLSearchParams(body)].map(([k, v]) => [k, v] as [string, string])
}

export function encodeForm(pairs: ReadonlyArray<readonly [string, string]>): string {
  const params = new URLSearchParams()
  for (const [k, v] of pairs) params.append(k, v)
  return params.toString()
}

export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8'

/**
 * The gate of one run on one site (agent-browser.md "The runner"):
 * - the page's own writes are never let through during a run (the window's write decider says no);
 * - the page's own reads of the operated host: its parts (script, style, image, font), else only a
 *   declared read path, without a query;
 * - a request from outside the page: GET / HEAD only on a declared read path without a query or a
 *   body; a write only while the runner has armed a declared write, only when `matchDeclaredWrite`
 *   says it is exactly that write with the plan's values, carrying a body the gate could read, in
 *   the declared order and at most once; never while stopped.
 */
export function createRunGate(options: {
  host: string
  operation: BrowserOperation
  values: BrowserPlanValues
  readPaths: readonly string[]
  stopped: () => boolean
}) {
  const { host, operation, values, readPaths, stopped } = options
  let armed: number | null = null
  const consumed = new Set<number>()
  const refusals: string[] = []
  const refuse = (reason: string): BrowserGateDecision => { refusals.push(reason); return { allow: false, reason } }

  const hooks: BrowserRunGateHooks = {
    stopped: () => stopped(),
    pageRead(read) {
      let parsedHost: string
      try { parsedHost = new URL(read.url).hostname } catch { return false }
      // Another host is the request hook's (asset hosts: GET of parts only).
      if (parsedHost !== host) return true
      const at = splitUrl(read.url, host)
      // A part on the operated host loads only without a query (a GET with parameters may do something).
      if (PAGE_PART_TYPES.has(read.resourceType)) return !!at && !at.query
      return !!at && !at.query && readPaths.includes(at.path)
    },
    sessionRequest(request) {
      const at = splitUrl(request.url, host)
      if (!at) return refuse('host')
      if (stopped()) return refuse('stopped')
      if (at.query) return refuse('query')
      const method = request.method.toUpperCase()
      if (READ_METHODS.has(method)) {
        if (request.body) return refuse('read-body')
        return readPaths.includes(at.path) ? { allow: true } : refuse('undeclared-read')
      }
      if (armed === null) return refuse('not-armed')
      // An upload or a body Chromium does not hand over as bytes cannot be checked.
      if (request.body === undefined) return refuse('no-body')
      const write = operation.writes[armed]
      if (!write || write.encoding !== 'form') return refuse('encoding')
      const match = matchDeclaredWrite(operation, values, {
        method: request.method, path: at.path, query: [], headers: {}, encoding: 'form', body: formPairs(request.body),
      })
      if (!match.match) return refuse(match.reason)
      if (match.write !== armed) return refuse('out-of-order')
      if (consumed.has(match.write)) return refuse('already-sent')
      consumed.add(match.write)
      armed = null
      return { allow: true }
    },
  }

  return {
    hooks,
    /** Lets declared write `index` through once (the runner calls this right before sending it). */
    arm(index: number) {
      if (index !== consumed.size || consumed.has(index)) throw new Error('writes go in their declared order, once each')
      armed = index
    },
    disarm() { armed = null },
    sent(index: number): boolean { return consumed.has(index) },
    /** Refusal reasons so far (no values). */
    refusals(): readonly string[] { return refusals },
  }
}

export type BrowserRunGate = ReturnType<typeof createRunGate>

/** The body of declared write `index`: its keys with the plan's values, then the page's ignored fields. */
export function declaredWriteBody(operation: BrowserOperation, index: number, values: BrowserPlanValues, ignored: Readonly<Record<string, string>>): Array<[string, string]> {
  const write = operation.writes[index]
  const pairs: Array<[string, string]> = []
  for (const [key, value] of Object.entries(write.body)) {
    pairs.push([key, 'literal' in value ? value.literal : own(values.target, value.field) ? values.target[value.field] : values.change[value.field]])
  }
  for (const key of write.ignoreBody) if (own(ignored, key)) pairs.push([key, ignored[key]])
  return pairs
}

// ---------------------------------------------------------------------------
// What a run reports, and what is kept of each step
// ---------------------------------------------------------------------------

/** One step's state, kept on this PC (ids and reasons only, never a value). */
export type BrowserStepState = 'pending' | 'sent' | 'succeeded' | 'failed' | 'unknown'

/** The only reason words a step record or a result carries (never a checker's or a site's text). */
export const BROWSER_RUN_REASONS = [
  // before anything starts
  'already-running', 'no-plan', 'plan', 'expired', 'already-ran', 'connector', 'operation', 'not-supported',
  'unknown-checker', 'target-unconfirmed', 'stopped', 'policy', 'no-window', 'busy', 'records-unavailable',
  // started, nothing sent
  'window-not-ready', 'window-closed', 'read-failed', 'account-unknown', 'account-mismatch', 'target-missing',
  'before-changed', 'csrf-missing', 'checker-problem', 'cannot-come-true',
  // sent
  'refused-by-site', 'no-answer', 'not-confirmed-sent', 'reread-failed', 'unchanged-unrefused', 'empty-state',
  'other-state', 'error',
] as const
export type BrowserRunReason = typeof BROWSER_RUN_REASONS[number]
export const isBrowserRunReason = (v: unknown): v is BrowserRunReason => (BROWSER_RUN_REASONS as readonly unknown[]).includes(v)

export interface BrowserStepRecord {
  planId: string
  operation: string
  step: number
  state: BrowserStepState
  /** A fixed reason word (`BROWSER_RUN_REASONS`), never a value of the site or the plan. */
  reason?: BrowserRunReason
  at: number
}

export type BrowserRunResult =
  /** Nothing started, nothing sent (the plan, the setting, the window, the type). */
  | { outcome: 'refused'; reason: BrowserRunReason }
  /** Started, stopped before anything was sent. */
  | { outcome: 'stopped'; reason: BrowserRunReason }
  /** Sent, and the page shows exactly the planned change. */
  | { outcome: 'succeeded' }
  /** Sent, the site answered it with a refusal (4xx) and the page shows the state from before. */
  | { outcome: 'failed'; reason: BrowserRunReason }
  /** Sent (or maybe sent) and the result cannot be told: never sent again by itself. */
  | { outcome: 'unknown'; reason: BrowserRunReason }

export const BROWSER_RUN_WORDS = {
  succeeded: '変更しました。',
  failed: '変更されませんでした。サイトの画面で確かめてください。',
  unknown: '結果が分からないままです。もう一度は送りません。サイトの画面で確かめてください。',
  stopped: '送る前に止めました。サイトには何も送っていません。',
  refused: 'この操作は、いまは実行できません。サイトには何も送っていません。',
} as const

export function browserRunSentence(result: BrowserRunResult): string {
  return BROWSER_RUN_WORDS[result.outcome]
}
