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
import { browserFactsAccount, browserFactsState } from '../../shared/core/browser-plans'
import { canonicalJson } from '../../shared/core/fixed-content'

// ---------------------------------------------------------------------------
// The approved plan
// ---------------------------------------------------------------------------

/** What a checker reads of a target: named lists of ids only (never a text of the site). */
export type BrowserTargetState = Readonly<Record<string, readonly string[]>>

/**
 * A plan a person approved, as the server's claim hands it (`BrowserClaim.plan`, 6b-2c; checked
 * against the claim's fixed content, `fixedContentMismatch`). Fixed: the connector at one version,
 * one operation type, the outside account it is bound to, the target and change values, the state the
 * person saw before (`before`), an expiry.
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

// ---------------------------------------------------------------------------
// The server's claim (6b-2c; agent-browser.md "Plans, executions, permits and locks")
// ---------------------------------------------------------------------------

/** The server's `sha256:` + hex of the canonical content (server/src/lib/content-hash.ts). */
export const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/
const EXECUTION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
/** The execution's secret goes in a header: plain token characters only, as long as the server takes. */
const SECRET_RE = /^[A-Za-z0-9_-]{32,200}$/

/** A claim the runner may work with: the execution, its secret (memory only), the plan and the fixed content. */
export interface BrowserClaimed {
  executionId: string
  secret: string
  plan: BrowserRunPlan
  fixed: { content: string; contentHash: string; factsVersion: number }
}

/**
 * The claim answer (`BrowserClaim`) checked field by field. No `fixed` (a server older than 6b-2a) is
 * `fixed-missing`: the app then never runs the plan (it cannot check what the person approved).
 */
export function parseBrowserClaim(input: unknown, now: number): { value: BrowserClaimed } | { error: 'claim' | 'fixed-missing' | 'expired' } {
  if (!isRecord(input)) return { error: 'claim' }
  const { executionId, secret, plan, fixed } = input
  if (typeof executionId !== 'string' || !EXECUTION_ID_RE.test(executionId)) return { error: 'claim' }
  if (typeof secret !== 'string' || !SECRET_RE.test(secret)) return { error: 'claim' }
  if (fixed === undefined || fixed === null) return { error: 'fixed-missing' }
  if (!isRecord(fixed) || typeof fixed.content !== 'string' || fixed.content.length > 2_000_000
    || typeof fixed.contentHash !== 'string' || !CONTENT_HASH_RE.test(fixed.contentHash)
    || !Number.isSafeInteger(fixed.factsVersion) || (fixed.factsVersion as number) < 1) return { error: 'claim' }
  if (!isRecord(plan) || typeof plan.approvedAt !== 'string' || typeof plan.expiresAt !== 'string') return { error: 'claim' }
  const parsed = parseBrowserRunPlan({ ...plan, approvedAt: Date.parse(plan.approvedAt), expiresAt: Date.parse(plan.expiresAt) }, now)
  if ('error' in parsed) return { error: parsed.error === 'expired' ? 'expired' : 'claim' }
  return { value: { executionId, secret, plan: parsed.value, fixed: { content: fixed.content, contentHash: fixed.contentHash, factsVersion: fixed.factsVersion as number } } }
}

/** A plan's fixed content as the server stored and hashed it (`BrowserPlanContent`, format 1), what the runner reads of it. */
export interface BrowserFixedContent {
  company: string
  connector: { id: string; version: string; declarationHash: string; checkerHash: string; factsVersion: number }
  operation: string
  account: string
  target: Record<string, string>
  change: Record<string, string>
  facts: Record<string, unknown>
  expiresAt: string
}

/**
 * The fixed content's text → its parts, or null. The text must be exactly the canonical JSON of what
 * it parses to (`canonicalJson`: no key written twice, no other spelling), so what the runner reads is
 * what was hashed and approved.
 */
export function parseFixedContent(text: string): BrowserFixedContent | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  try { if (canonicalJson(value) !== text) return null } catch { return null }
  if (!isRecord(value) || value.format !== 1) return null
  const { company, connector, operation, account, target, change, facts, expiresAt } = value
  if (typeof company !== 'string' || typeof operation !== 'string' || typeof account !== 'string' || typeof expiresAt !== 'string') return null
  if (!isRecord(connector) || typeof connector.id !== 'string' || typeof connector.version !== 'string'
    || typeof connector.declarationHash !== 'string' || typeof connector.checkerHash !== 'string' || !Number.isSafeInteger(connector.factsVersion)) return null
  const t = stringRecord(target)
  const c = stringRecord(change)
  if (!t || !c || !isRecord(facts)) return null
  return {
    company, operation, account, target: t, change: c, facts, expiresAt,
    connector: { id: connector.id, version: connector.version, declarationHash: connector.declarationHash, checkerHash: connector.checkerHash, factsVersion: connector.factsVersion as number },
  }
}

/**
 * Why the claim's plan is not the fixed content the person approved, or null: the company, connector,
 * operation, account, target, change, expiry, the facts version, and `before` = the `state` fact
 must all agree, so the runner never acts on a field the hash did not cover.
 */
export function fixedContentMismatch(content: BrowserFixedContent, claimed: BrowserClaimed): string | null {
  const { plan, fixed } = claimed
  const sameRecord = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => own(b, k) && b[k] === v)
  if (content.company !== plan.companyId) return 'company'
  if (content.connector.id !== plan.connector.id || content.connector.version !== plan.connector.version) return 'connector'
  if (content.connector.factsVersion !== fixed.factsVersion) return 'facts-version'
  if (content.operation !== plan.operation) return 'operation'
  if (content.account !== plan.account || browserFactsAccount(content.facts) !== plan.account) return 'account'
  if (!sameRecord(content.target, plan.target) || !sameRecord(content.change, plan.change)) return 'values'
  if (Date.parse(content.expiresAt) !== plan.expiresAt) return 'expiresAt'
  const state = browserFactsState(content.facts)
  if (!state || !sameTargetState(state, plan.before)) return 'before'
  return null
}

/** The server's permit answer (`BrowserPermit`) → how long it is good for, or null when it is not one. */
export function permitValidMs(input: unknown): number | null {
  if (!isRecord(input) || typeof input.permittedAt !== 'string' || !Number.isFinite(Date.parse(input.permittedAt))) return null
  return Number.isSafeInteger(input.validMs) && (input.validMs as number) > 0 ? input.validMs as number : null
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
  /** The facts this checker reads for a plan (6b-2b; agent-browser.md "The facts a checker reads"), when it reads any. */
  readonly facts?: BrowserCheckerFacts
}

/**
 * One read a checker asks for its facts: a read the declaration's `explore` declares (reviewed, no
 * side effects), with exactly its `{name}`s and, for a paginated read, the page. The core builds the
 * address (`explorePath`) and reads it exactly; a checker never names an address.
 */
export interface BrowserFactRequest {
  read: string
  values: Readonly<Record<string, string>>
  page?: number
}

/**
 * One answer read for a checker's facts, as the core hands it over: an HTML page as its raw text (for
 * what only the markup holds, the account's `<meta>`) and the core's page view; a JSON answer parsed
 * strictly; anything else (no answer, not 200, not parsed) is `ok: false`.
 */
export type BrowserFactAnswer = BrowserFactRequest & (
  | { ok: true; kind: 'html'; body: string; view: BrowserPageView }
  | { ok: true; kind: 'json'; json: BrowserJsonValue }
  | { ok: false }
)

/** One fact as a checker reads it; the core adds when and where it was read (the answer `from`). */
export interface BrowserFactDraft {
  status: 'known' | 'unknown'
  value?: unknown
  complete?: boolean
  /** The index of the answer it was read from. */
  from: number
  /**
   * Read from the page's raw markup by the checker's own `view` — the same reading a run makes before
   * and after its write (the account, the target's state) — not from the core's page view, so the
   * view's wholeness does not apply to it. Without this mark a fact from an HTML page whose view was
   * not whole is `unknown`.
   */
  rawMarkup?: true
}

/**
 * The facts a checker reads for a plan (6b-2b), in one facts version. `next` says which declared reads
 * to make given the answers so far (pure: a function of the answers; `[]` = done); `read` turns the
 * answers into facts. What it cannot read is `unknown` (never a guess, never 0 for "unknown"); a
 * required fact unknown makes no plan (`browserFactsProblem`). `problem` is a fixed word for why, when
 * one applies (a template that is not text only).
 */
export interface BrowserCheckerFacts {
  readonly version: number
  next(values: BrowserPlanValues, answers: readonly BrowserFactAnswer[]): BrowserFactRequest[]
  read(values: BrowserPlanValues, answers: readonly BrowserFactAnswer[]): { facts: Record<string, BrowserFactDraft>; problem?: string }
}

// ---------------------------------------------------------------------------
// The preview's readers (design memo §33 2-2 / 2-3; a site's live in client/connectors/<site>/)
// ---------------------------------------------------------------------------

/** What a reader asks the page for: elements by tag, exact id, id pattern or an attribute's presence. */
export interface BrowserPageQuery {
  tag?: string
  id?: string
  /** Tested against the whole id (anchor it). */
  idPattern?: RegExp
  /** The element carries this attribute (any value). */
  hasAttribute?: string
}

/**
 * One element of a page as the core lets a reader see it (client/shared/browser-page.ts): only
 * what a person could see — nothing inside `hidden`, `aria-hidden="true"`, `<template>`,
 * `<noscript>`, `<script>`, `<style>`, comments or an inline `display:none` / `visibility:hidden`
 * — and every rule (an attribute written twice, an id used twice) applied by the core, which then
 * marks the read incomplete. A reader never sees the HTML itself.
 */
export interface BrowserPageElement {
  readonly tag: string
  /** The element's id, or null (none). An element whose id stands twice is never shown to a reader. */
  readonly id: string | null
  /** An attribute's value, or null (none). An element with an attribute written twice is never shown. */
  attr(name: string): string | null
  /** The element's visible text, whitespace folded (a label: the core cleans and cuts it). */
  text(): string
  /** Matching elements inside this one (visible ones only), in document order. */
  find(query: BrowserPageQuery): BrowserPageElement[]
}

/** A page as a reader sees it: the visible tree under the body. */
export interface BrowserPageView {
  find(query: BrowserPageQuery): BrowserPageElement[]
  /** Exactly one visible element matches, or null — and the read is marked incomplete. */
  one(query: BrowserPageQuery): BrowserPageElement | null
  /** Marks this read as not read whole (an expected part missing or ambiguous). */
  incomplete(): void
}

/** One item a reader took out: a declared field's id (`value`), its visible label, and declared extras. */
export interface BrowserExploreItem {
  field: string
  value: string
  label?: string
  extra?: Readonly<Record<string, string>>
}

/**
 * A reviewed reader of one kind of page for the preview: from the declared region of the page,
 * the declared fields only. Choosing among them is the operator AI's; nothing else of the page
 * reaches it (design memo §33 2-3). `fields` and `extra` are the only names its items may carry.
 */
export interface BrowserExploreReader {
  /** `<site>.<thing>`, as a declaration's `explore.<name>.reader` names it. */
  readonly id: string
  readonly fields: readonly string[]
  readonly extra: readonly string[]
  read(values: Readonly<Record<string, string>>, page: BrowserPageView): { items: BrowserExploreItem[]; complete: boolean }
}

/** A JSON answer as a reader gets it: parsed strictly (client/shared/browser-json.ts), objects without a prototype. */
export type BrowserJsonValue = null | boolean | number | string | readonly BrowserJsonValue[] | { readonly [key: string]: BrowserJsonValue }

/**
 * Where one answer of a paginated list stands, as the answer says it (`current_page`, `last_page`,
 * `total`). A reader only reports it: which page is read next — if any — is the app's decision
 * (preview.ts, the declaration's `pages`), never the reader's or the operator's.
 */
export interface BrowserListPage {
  current: number
  last: number
  total: number
}

/**
 * A reviewed reader of a JSON answer the site's own pages use (agent-browser.md "The checker": prefer
 * stable sources). It gets the answer parsed strictly — never the text — and hands back declared
 * fields only, as an HTML reader does; the core cleans them the same way (`runJsonExploreReader`).
 * An answer it does not recognise is `complete: false`, never a guess. A paginated answer also
 * reports where it stands (`page`); `complete` then speaks of this answer's entries only.
 */
export interface BrowserJsonExploreReader {
  readonly id: string
  readonly answer: 'json'
  readonly fields: readonly string[]
  readonly extra: readonly string[]
  read(values: Readonly<Record<string, string>>, json: BrowserJsonValue): { items: BrowserExploreItem[]; complete: boolean; page?: BrowserListPage }
}

/** Any reviewed preview reader: of a page (HTML) or of a JSON answer. */
export type BrowserPreviewReader = BrowserExploreReader | BrowserJsonExploreReader

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

/**
 * The two steps a write waits on (6b-2c, design 6b-2 §5-3). `ready` runs once the write session is
 * prepared (connections closed, storage cleared, its one request hook and the window's cookies in) —
 * the runner asks the server's permit there, so the preparation's seconds never eat into the permit's
 * 5 s; false (or a throw) = nothing is sent. `beforeSend` runs synchronously right before the request
 * leaves (`request.end`), with no await between them: false (or a throw) = nothing is sent.
 */
export interface BrowserWriteSteps {
  ready(): Promise<boolean>
  beforeSend(): boolean
}

/**
 * What became of a write. `sent: false` only when the request provably never left: it stopped in the
 * preparation, at `ready`, or at `beforeSend` (the request was never ended). Once the request was
 * ended, it is `sent: true` — with the answer, or `answer: null` when none came (an error, a
 * disconnect, a time-out, a refusal of the session's hook): the write may have reached the site.
 */
export type BrowserWriteOutcome =
  | { sent: false; stage: 'prepare' | 'ready' | 'before-send' }
  | { sent: true; answer: { status: number; body: string } | null }

/** The window as a run uses it (electron/browser-window.ts). */
export interface BrowserRunSurface {
  /** `ai` mode with the run's gate; true only once the gate sees every request of the page. */
  enterAi(hooks: BrowserRunGateHooks): Promise<boolean>
  leaveAi(): Promise<void>
  /**
   * True while every frame of the page is one the page's write gate sees (the operated origin, the main
   * frame's process): no login helper's frame left, no sandboxed or other-site frame. Synchronous, so the
   * run asks it in every check up to the last one right before the write leaves (agent-browser.md "Login
   * helpers"). A closed window is never clean.
   */
  pageClean(): boolean
  /**
   * A read (GET) with the window's login, never through the page nor the window's session: through
   * the window's page-less read session (one request at a time, agent-browser.md "The operator and
   * the preview"); rejects = no answer. Not for writes (refused).
   */
  request(request: { method: string; path: string }): Promise<{ status: number; body: string }>
  /**
   * The one write of a run through the window's page-less write session, which cannot be sent
   * without its steps: `ready` (the permit) after the session is prepared, `beforeSend` (the last
   * check) synchronously right before the request leaves. Never rejects for a write that did not
   * leave (`sent: false`); a rejection is a write that may have left.
   */
  write(request: { method: string; path: string; contentType: string; body: string }, steps: BrowserWriteSteps): Promise<BrowserWriteOutcome>
  closed(): boolean
}

/**
 * The window as the preview uses it: reads through its page-less read session with the window's
 * login (only GET of exactly that address: the path, and a declared read's query when it has one),
 * the window itself untouched — not switched to `ai`, its page and the member's typing left alone
 * (design memo §33 2-4).
 */
export interface BrowserPreviewSurface {
  read(address: string, signal?: AbortSignal): Promise<{ status: number; body: string }>
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

/**
 * One step's state, kept on this PC (ids and reasons only, never a value; 6b-2 §7-1). `claimed`: the
 * server's claim answered; `permit-asked`: written right before the permit is asked — from here on the
 * write may have left, so a crash leaves this and the plan never runs again here; `failed`: it
 * provably never left (the only state the card may show as a hint, `stoppedBeforeSending`);
 * `succeeded` / `unknown`: sent, judged by the read after it. (No `sent` mark: writing one would sit
 * between the last check and the request leaving; `permit-asked` already means "may have been sent".)
 */
export type BrowserStepState = 'claimed' | 'permit-asked' | 'succeeded' | 'failed' | 'unknown'

/** The only reason words a step record or a result carries (never a checker's, a site's or the server's text). */
export const BROWSER_RUN_REASONS = [
  // nothing claimed (nothing to send)
  'off', 'input', 'already-running', 'already-ran', 'records-unavailable', 'approve-refused', 'claim-refused', 'claim-unanswered',
  // claimed, given back before any permit (the server makes the execution void)
  'server-too-old', 'fixed-mismatch', 'connector', 'operation', 'not-supported', 'unknown-checker', 'target-unconfirmed', 'plan',
  'expired', 'stopped', 'policy', 'no-window', 'busy', 'facts-changed', 'context-changed', 'window-not-ready', 'window-closed', 'foreign-frames',
  'read-failed', 'account-unknown', 'account-mismatch', 'target-missing', 'before-changed', 'csrf-missing', 'checker-problem',
  'cannot-come-true', 'no-visible-change', 'permit-refused',
  // permit asked, stopped before the request left (reported `failed`)
  'permit-unanswered', 'permit-late', 'error',
  // the request left (reported `unknown` unless the read after it shows the plan)
  'no-answer', 'reread-failed', 'account-after', 'target-after', 'other-state',
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

/** True only when this PC's latest record of the plan says it stopped before sending (a hint for the card, never a confirm). */
export function stoppedBeforeSending(records: readonly BrowserStepRecord[], planId: string): boolean {
  const mine = records.filter(r => r.planId === planId)
  return mine.length > 0 && mine[mine.length - 1].state === 'failed'
}

export type BrowserRunResult =
  /** Nothing claimed: the plan was not taken (off, the input, this PC's record, the server refused). */
  | { outcome: 'refused'; reason: BrowserRunReason; code?: string }
  /** Claimed, then given back before any permit (or the permit was refused): nothing sent. */
  | { outcome: 'stopped'; reason: BrowserRunReason }
  /** The permit was asked, and the write stopped before it left (reported `failed`): nothing sent. */
  | { outcome: 'failed'; reason: BrowserRunReason }
  /** Sent, and the page shows exactly the planned change. */
  | { outcome: 'succeeded' }
  /** Sent (or maybe sent) and the result cannot be told: never sent again; a person confirms. */
  | { outcome: 'unknown'; reason: BrowserRunReason }

/** The card's words (6b-2 §4). */
export const BROWSER_RUN_WORDS = {
  succeeded: '計画どおりの状態になっています。',
  failed: '送る前に止めました。この操作の送信は行っていません。',
  unknown: '結果が分かりません。サイトの画面で確かめてください。もう一度は送りません。',
  stopped: '送りませんでした。もう一度やるときは、相談で頼み直してください。',
  refused: 'この操作は、いまは実行できません。サイトには何も送っていません。',
} as const

export function browserRunSentence(result: BrowserRunResult): string {
  return BROWSER_RUN_WORDS[result.outcome]
}
