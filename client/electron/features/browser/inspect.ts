// 「ブラウザ操作」's read-only inspection, wired (generalization PR 5b; agent-browser.md "The inspection in the chat"): the
// consultation AI asks (`browser_inspect`) → the server makes the inspection's plan (its gate: the line approved, the
// member's setting, the AI stop, the member's grant) → the read runner (read-line-runner.ts) reads the site through the
// member's own logged-in window, GET only → the generic card is kept here, in memory, for the member's card in the chat →
// the server gets the result in fixed words. No Electron: main.ts hands in the window controller's read surface, the
// policy store's stop, the session, the shared context, the bundled maps and lines and the bundled declarations.
//
// Owner decisions (PC-registration memo v2): no ［任せる］ press for an inspection (it reads only); it runs only while the
// member has that consultation open (the turn's signal: closing or stopping the consultation stops the reads); the AI
// gets only fixed words and each check's ✓ / ✗ / 「読み取れませんでした」 — the values the site showed are on the
// member's card alone and never leave main but to the renderer's card (never to the server, the AI, a log or the disk).
import type { BrowserOperationLevel } from '../../../../shared/core/browser-operation'
import { browserLineCatalog } from '../../../shared/browser-tool-catalog'
import type { IpcInvokeEvent, IpcMessageEvent, IpcRegistrar } from '../../ipc/registrar'
import type { BrowserMap, BrowserThingReader } from '../../../../shared/core/browser-map'
import { browserLineValuesProblem, type BrowserSuppliedValue } from '../../../../shared/core/browser-read-line'
import type { BrowserOpenedFile, BrowserOpenedLine, BrowserOpenedLineRow } from '../../../../shared/core/browser-opened'
import { canonicalJson } from '../../../../shared/core/fixed-content'
import { BROWSER_ID_VALUE_RE } from '../../../../shared/core/plugin-browser-declaration'
import { BROWSER_RUN_ID_RE } from '../../../../shared/core/browser-run-log'
import { parsePluginManifest } from '../../../../shared/core/plugin-manifest'
import type { BrowserLineRef } from '../../../../shared/types/browser-lines'
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import {
  BROWSER_INSPECTION_CARD_WORDS as CW, BROWSER_INSPECT_WORDS as W, BROWSER_LINE_PLAN_ID_RE, inspectionWordsForAi,
  type BrowserInspectionGetResult, type BrowserInspectionView,
} from '../../../shared/browser-inspection'
import type { BrowserPreviewSurface } from '../../../shared/browser-runner'
import { noWindowWords, type BrowserRunWindow } from '../../../shared/browser-operation'
import approved from '../../../../shared/browser-connectors/approved.json'
import carried from '../../../../shared/browser-connectors/carried.json'
import opened from '../../../../shared/browser-connectors/opened.json'
import type { BrowserAiSwitch } from './ai-switch'
import { approvedBundledDeclarations } from './combination'
import type { BrowserContext } from './context'
import { createBrowserLinesHttp } from './lines-api'
import { createBrowserReadRunner, type BrowserAccountMarker, type BrowserReadRunRefusal, type BrowserThingAddress } from './read-line-runner'

/** One site's map as the app bundles it (client/connector-maps/<site>/, handed in by main.ts only). */
export interface BrowserInspectionSite {
  map: BrowserMap
  readers: Readonly<Record<string, BrowserThingReader>>
  addresses: Readonly<Record<string, BrowserThingAddress>>
  account: BrowserAccountMarker
}

export interface BrowserInspectionsDeps<E> {
  aiSwitch: BrowserAiSwitch
  fromMainWindow: (event: E) => boolean
  baseUrl: () => string
  cookies: () => string[]
  /** This PC's key header value (device.ts): only the plan client's gated steps send it. */
  deviceKey?: () => string | null
  userId: () => string | null
  /** The context the plans use too (sign-in, the company's setting, quitting, the switch): main advances it. */
  context: BrowserContext
  /** `browserAiStopped(policy.stop(companyId))`. */
  stopped(companyId: string): boolean
  /** The member's open window of the site as main reads through it (controller `previewWindow`); null: not open or not listed. */
  window(companyId: string, host: string): BrowserPreviewSurface | null
  /**
   * The window a run needs (controller `windowForRun`, agent-browser.md "The window a run needs"): asked before the run
   * looks for it, so a window closed meanwhile opens again by itself while this app run holds the member's login.
   */
  openWindow?(companyId: string, host: string, signal: AbortSignal): Promise<BrowserRunWindow>
  /** The site's level in the company's current valid policy (controller `siteNow`), null when the company did not register it. */
  siteLevel(companyId: string, host: string): BrowserOperationLevel | null
  /** The maps this build bundles (client/connector-maps/), the opened lines (client/browser-lines/), the declarations. */
  sites: readonly BrowserInspectionSite[]
  lines: readonly BrowserOpenedLine[]
  declarations: readonly string[]
  /** The opened list (default: shared/browser-connectors/opened.json) and the approved / carried lists (tests). */
  openedFile?: unknown
  approvedFile?: unknown
  carriedFile?: unknown
  fetch?: typeof fetch
  now?: () => number
  /** An operator run's card for this member (features/browser/browse.ts, in its memory), asked by the same card IPC. */
  runCard?: (userId: string, companyId: string, runId: string) => BrowserInspectionView | undefined
}

export type BrowserInspectOutcome =
  | { kind: 'card'; planId: string; words: string }
  | { kind: 'refused'; words: string }

/** The cards kept in memory (per signed-in member), at most this many: the oldest go first. */
const KEPT_CARDS = 100

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The server's refusal codes of an inspection's plan → the AI's fixed words. */
function refusedWords(code: string | null): string {
  switch (code) {
    case 'BROWSER_LINE_NOT_APPROVED': case 'BROWSER_LINE_RETIRED': case 'BROWSER_LINE_WRITES_NOT_YET': return W.notApproved
    case 'BROWSER_NOT_ALLOWED': return W.notAllowed
    case 'BROWSER_TYPE_NOT_GRANTED': return W.notGranted
    case 'BROWSER_AI_STOPPED': return W.stopped
    case 'BROWSER_VALUE_REFUSED': case 'BROWSER_VALUE_UNCONFIRMED': case 'BROWSER_VALUE_SOURCE_NOT_YET': return W.values
    default: return W.failed
  }
}

function runRefusedWords(reason: BrowserReadRunRefusal): string {
  switch (reason) {
    case 'off': return W.off
    case 'stopped': return W.stopped
    case 'window': return W.noWindow
    case 'busy': return W.busy
    case 'not-approved': return W.notApproved
    case 'values': return W.values
    case 'context': case 'timeout': case 'too-many-reads': return W.interrupted
    default: return W.failed
  }
}

export function wireBrowserInspections<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E, IpcMessageEvent>, deps: BrowserInspectionsDeps<E>) {
  const now = deps.now ?? Date.now
  const http = createBrowserLinesHttp({ baseUrl: deps.baseUrl, cookies: deps.cookies, deviceKey: deps.deviceKey, fetch: deps.fetch })
  const file = (deps.openedFile ?? opened) as BrowserOpenedFile
  // The site's operated host and name only from its reviewed declaration that this build carries and the approved list
  // approves (as the window's helpers): never from the request, so a map's GETs go nowhere but the site the map names.
  const declared = approvedBundledDeclarations(deps.approvedFile ?? approved, deps.carriedFile ?? carried, deps.declarations)
    .map(text => parsePluginManifest(text)).flatMap(r => (r.ok && r.value.browser ? [{ id: r.value.id, label: r.value.label, host: r.value.browser.host }] : []))
  const siteOf = (site: string): { host: string; label: string } | null => {
    const found = declared.filter(d => d.id === site)
    const hosts = new Set(found.map(d => d.host))
    return found.length > 0 && hosts.size === 1 ? { host: found[0].host, label: found[found.length - 1].label } : null
  }

  /**
   * What the AI is told it may ask in this company (agent-browser.md "The tools' words"): the bundled lines of this kind
   * whose row in the opened list is approved, on a site whose reviewed declaration this build carries **and the company
   * registered** (its current valid policy). A company that registered none of them hears no site's words.
   */
  const catalog = (companyId: string) => browserLineCatalog(
    deps.lines.filter(l => file.lines?.some(r => r.name === l.name && r.version === l.version && r.site === l.read.site && r.status === 'approved')),
    id => { const s = siteOf(id); return s && deps.siteLevel(companyId, s.host) !== null ? { id, label: s.label } : null }, 'read')

  // One read runner (one run per window). Its context is the shared one, captured with the run's own turn signal.
  const runner = createBrowserReadRunner({
    aiSwitch: deps.aiSwitch, stopped: deps.stopped, window: deps.window, context: scope => deps.context.capture(scope), reporter: http, now,
  })

  const cards = new Map<string, BrowserInspectionView>()
  const key = (userId: string, companyId: string, planId: string) => `${userId}|${companyId}|${planId}`
  const keep = (k: string, view: BrowserInspectionView) => {
    cards.delete(k)
    cards.set(k, view)
    while (cards.size > KEPT_CARDS) cards.delete(cards.keys().next().value as string)
  }

  /** The bundled line, its map and its row in the opened list — the very line and map the row holds — or null. */
  function lineOf(site: string, name: string): { line: BrowserOpenedLine; s: BrowserInspectionSite; row: BrowserOpenedLineRow } | null {
    const line = deps.lines.find(l => l.read.site === site && l.name === name)
    const s = deps.sites.find(x => x.map.site === site)
    if (!line || !s || line.writes !== undefined) return null
    const lines = isMap(file) && Array.isArray(file.lines) ? file.lines : []
    const maps = isMap(file) && Array.isArray(file.maps) ? file.maps : []
    const rows = lines.filter(r => isMap(r) && r.site === site && r.name === name && r.version === line.version && r.mapVersion === s.map.version)
    const mapRows = maps.filter(m => isMap(m) && m.site === site && m.version === s.map.version)
    if (rows.length !== 1 || mapRows.length !== 1) return null
    try {
      if (canonicalJson(rows[0].line) !== canonicalJson(line) || canonicalJson(mapRows[0].map) !== canonicalJson(s.map)) return null
    } catch { return null }
    return { line, s, row: rows[0] }
  }

  /** The consultation AI's inspection: a card for the member and fixed words for the AI. Off: nothing read or sent. */
  async function inspect(input: {
    companyId: string; conversationId: string | null; site: string; line: string; values: Record<string, string>; signal: AbortSignal
  }): Promise<BrowserInspectOutcome> {
    const refused = (words: string): BrowserInspectOutcome => ({ kind: 'refused', words })
    if (!deps.aiSwitch()) return refused(W.off)
    const userId = deps.userId()
    if (!userId || !BROWSER_COMPANY_ID_RE.test(input.companyId)) return refused(W.failed)
    const found = lineOf(input.site, input.line)
    if (!found) return refused(W.unknownLine)
    const { line, s, row } = found
    if (row.status !== 'approved') return refused(W.notApproved)
    // Values: only the line's own names, each a plain id, named as the objects the line reads (`target` ← `site_fact`):
    // the read itself is what makes each a site fact — main reads exactly that object, in the member's account, and an
    // id the site does not answer for is not read and never ✓. A value that decides which / when (a person's or a bound
    // record field's, §16-4) is never this tool's: the core's rule refuses it as a site fact.
    const supplied: Record<string, BrowserSuppliedValue> = {}
    const names = Object.keys(line.read.values)
    if (!isMap(input.values) || Object.keys(input.values).length !== names.length) return refused(W.values)
    for (const name of names) {
      const v = Object.prototype.hasOwnProperty.call(input.values, name) ? input.values[name] : undefined
      if (typeof v !== 'string' || !BROWSER_ID_VALUE_RE.test(v)) return refused(W.values)
      supplied[name] = { value: v, from: { kind: 'site_fact' } }
    }
    if (browserLineValuesProblem(line.read, supplied)) return refused(W.values)
    const site = siteOf(line.read.site)
    if (!site) return refused(W.notAllowed)
    if (deps.stopped(input.companyId)) return refused(W.stopped)
    const opened = await deps.openWindow?.(input.companyId, site.host, input.signal)
    const win = deps.window(input.companyId, site.host)
    if (!win || win.closed()) return refused(noWindowWords(W.noWindow, opened))

    // The server's gate first: nothing is read unless it makes the plan (and no plan for a turn already stopped).
    const stillCurrent = deps.context.capture({ companyId: input.companyId, signal: input.signal })
    if (!stillCurrent()) return refused(W.interrupted)
    const ref: BrowserLineRef = { site: row.site, line: row.name, version: row.version, mapVersion: row.mapVersion, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash }
    const made = await http.createInspection(input.companyId, { line: ref, values: supplied, ...(input.conversationId ? { conversationId: input.conversationId } : {}) })
    if (made.kind === 'no-answer') return refused(W.offline)
    if (made.kind === 'refused') return refused(refusedWords(made.code))
    const planId = isMap(made.value) && typeof made.value.id === 'string' && BROWSER_LINE_PLAN_ID_RE.test(made.value.id) ? made.value.id : null
    if (!planId) return refused(W.failed)
    if (!stillCurrent()) return refused(W.interrupted)

    const result = await runner.run({
      companyId: input.companyId, host: site.host, line, lineStatus: row.status, map: s.map, readers: s.readers,
      addresses: s.addresses, account: s.account, values: supplied, planId, signal: input.signal,
    })
    if (result.status === 'refused') return refused(runRefusedWords(result.reason))
    // Kept for this member only, in memory: the card is the one place the site's values are shown.
    if (deps.userId() !== userId) return refused(W.interrupted)
    keep(key(userId, input.companyId, planId), { card: result.card, readAt: new Date(now()).toISOString(), siteLabel: site.label })
    return { kind: 'card', planId, words: inspectionWordsForAi(result.card) }
  }

  // The card's IPC: the main window's own page only (as the plan card), ids of the server's exact shape, this member's card.
  ipc.handle('browserLines:card', async (event, companyId, planId): Promise<BrowserInspectionGetResult> => {
    if (!deps.fromMainWindow(event)) return { ok: false, message: CW.notMainWindow }
    if (typeof companyId !== 'string' || !BROWSER_COMPANY_ID_RE.test(companyId) || typeof planId !== 'string'
      || !(BROWSER_LINE_PLAN_ID_RE.test(planId) || BROWSER_RUN_ID_RE.test(planId))) return { ok: false, message: CW.badInput }
    const userId = deps.userId()
    // An operator run's card (`bo_…`, agent-browser.md "The operator's window tools") is held by its own wiring.
    const view = !userId ? undefined : BROWSER_RUN_ID_RE.test(planId) ? deps.runCard?.(userId, companyId, planId) : cards.get(key(userId, companyId, planId))
    return view ? { ok: true, view } : { ok: false, message: CW.gone }
  })

  return {
    /** Whether the inspection tool may exist at all (the switch, asked per turn). */
    inspectAvailable: () => deps.aiSwitch(),
    catalog,
    inspect,
    /** Sign-out: no card of the previous account stays in memory. */
    clear: () => cards.clear(),
  }
}

export type BrowserInspectionsWiring = ReturnType<typeof wireBrowserInspections>
