/**
 * `acb-doc://<token>/<file>` — the HTML viewer's address (`.claude/rules/doc-frame.md`).
 *
 * An HTML document is someone else's program: it is shown in a view of its own,
 * on an in-memory session of its own (`electron/doc-view.ts`), with a CSP whose
 * `sandbox` gives it an opaque origin, and everything it loads comes from this
 * scheme. The token stands for one opened document's folder (main keeps the
 * map, `electron/features/doc-frames/protocol.ts`); the address never leaves
 * main and never carries an absolute path.
 *
 * Pure: the address grammar, the served file types, the CSP, where a document
 * view may navigate and what its session lets out. The main process decides
 * which file a request reaches.
 */

import { COMMANDS } from './commands/catalog'
import { isMacControlKey, shortcutOf, type CommandArea, type KeyInput } from './commands/define'

export const DOC_SCHEME = 'acb-doc'

/** A token is 32 lowercase hex characters (16 random bytes): a valid host label, never guessable. */
export const DOC_TOKEN_RE = /^[0-9a-f]{32}$/

/** One file served to a document frame: at most 20 MB (the file tree's drop limit). */
export const DOC_MAX_FILE_BYTES = 20 * 1024 * 1024

/** What may be opened as a document (the top page of a grant). */
export function isHtmlDocumentName(name: string): boolean {
  return /\.html?$/i.test(name)
}

/**
 * The only files a document frame may load, by extension (lower case), with
 * the type they are served as. Data (`.md`, `.csv`, `.json`, …), media and
 * everything else are never served (`nosniff` on every answer).
 */
export const DOC_FILE_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

/** The served type of a file name, or null when it is never served. */
export function docFileType(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return Object.prototype.hasOwnProperty.call(DOC_FILE_TYPES, name.slice(dot + 1).toLowerCase())
    ? DOC_FILE_TYPES[name.slice(dot + 1).toLowerCase()]
    : null
}

/** The address of a file directly in the grant's folder (the opened document). */
export function docFrameUrl(token: string, fileName: string): string {
  return `${DOC_SCHEME}://${token}/${encodeURIComponent(fileName)}`
}

export interface DocFrameRequest {
  token: string
  /** Decoded path segments under the grant's folder; the last one is the file. */
  segments: string[]
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * Read an `acb-doc://` address, or null when it is not one this app serves.
 * Works on the raw string (not on a URL parser's normalisation): the query
 * (`?v=<n>`, a cache-buster) and fragment are dropped; then every segment must
 * be a plain name after one percent-decoding — no empty segment, no `.` /
 * `..` (also encoded), no `/` or `\` inside a name (also encoded), no control
 * character, and no name starting with `.` (hidden files and folders:
 * `.git`, `.claude`, `.backups`, …). The host is the token, nothing else
 * (no user-info, no port).
 */
export function parseDocFrameUrl(url: string): DocFrameRequest | null {
  if (typeof url !== 'string' || url.length > 4096) return null
  const prefix = `${DOC_SCHEME}://`
  if (url.slice(0, prefix.length).toLowerCase() !== prefix) return null
  let rest = url.slice(prefix.length)
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)
  if (rest.includes('\\')) return null
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const token = rest.slice(0, slash)
  if (!DOC_TOKEN_RE.test(token)) return null
  const raw = rest.slice(slash + 1).split('/')
  const segments: string[] = []
  for (const part of raw) {
    let name: string
    try {
      name = decodeURIComponent(part)
    } catch {
      return null
    }
    if (name === '' || name.startsWith('.') || name.includes('/') || name.includes('\\') || CONTROL_RE.test(name)) return null
    segments.push(name)
  }
  return segments.length > 0 ? { token, segments } : null
}

/**
 * Where a document frame may load each kind of thing from: one object, built
 * by `docFramePolicy`, turned into the CSP by `docFrameCsp`. Today every list
 * is the grant's own origin (plus `data:` / `blob:` for images and fonts) or
 * empty: **no network source at all** (owner decision 2026-11-22: internet
 * parts are blocked). Planned, not built (doc-frame.md "Later"): copies of the
 * images the HTML file names, fetched by main after the member's 「表示する」
 * and served through this origin (no change here); YouTube / Vimeo embeds on
 * click (`frameSources`, exact privacy-enhanced hosts); a company's own
 * storage hosts set by an admin (`imgSources` / `mediaSources`, exact hosts).
 * A later PR adds sources here and nowhere else; the other directives stay.
 */
export interface DocFramePolicy {
  /** `acb-doc://<token>`: the only place scripts, styles, images and fonts come from. */
  origin: string
  scriptSources: readonly string[]
  styleSources: readonly string[]
  imgSources: readonly string[]
  fontSources: readonly string[]
  mediaSources: readonly string[]
  frameSources: readonly string[]
}

export function docFramePolicy(token: string): DocFramePolicy {
  const origin = `${DOC_SCHEME}://${token}`
  return {
    origin,
    // Inline scripts run (owner decision 2026-11-22: slides and charts need them);
    // they reach no network, storage or app (opaque origin, the directives below).
    scriptSources: [origin, "'unsafe-inline'"],
    styleSources: [origin, "'unsafe-inline'"],
    imgSources: [origin, 'data:', 'blob:'],
    fontSources: [origin, 'data:'],
    mediaSources: [],
    frameSources: [],
  }
}

const sources = (list: readonly string[]) => (list.length > 0 ? list.join(' ') : "'none'")

/**
 * The CSP every `acb-doc://` answer carries. Fixed parts: nothing to connect
 * to (fetch, XHR, WebSocket, EventSource, beacons), no workers, plugins,
 * forms, `<base>` or manifest, and `sandbox allow-scripts` — opened outside the
 * app's frame (top level), the page still gets an opaque origin.
 */
export function docFrameCsp(policy: DocFramePolicy): string {
  return [
    "default-src 'none'",
    `script-src ${sources(policy.scriptSources)}`,
    `style-src ${sources(policy.styleSources)}`,
    `img-src ${sources(policy.imgSources)}`,
    `font-src ${sources(policy.fontSources)}`,
    `media-src ${sources(policy.mediaSources)}`,
    `frame-src ${sources(policy.frameSources)}`,
    "connect-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts',
  ].join('; ')
}

/**
 * The document session's one request rule (`doc-view.ts`, a second wall behind
 * the CSP): only the document's own scheme and what a page makes in memory
 * (`data:`, `blob:`, `about:`). Every web address (http, https, ws, wss), every
 * file and every other scheme is cancelled.
 */
export function docSessionRequestAllowed(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  return scheme === DOC_SCHEME || scheme === 'data' || scheme === 'blob' || scheme === 'about'
}

/**
 * Where a document view may go (`will-frame-navigate`, `will-redirect`): its
 * main frame only to an `.html` page of its own grant (`token`). Never another
 * token, `data:`, `file:`, `local-file:`, `acb-plugin:`, a web address; a
 * frame inside it nowhere (its CSP allows no frame either).
 */
export function docViewNavigationAllowed(token: string | null, url: string, isMainFrame: boolean): boolean {
  if (!isMainFrame || token === null) return false
  const target = parseDocFrameUrl(url)
  return target !== null && target.token === token && isHtmlDocumentName(target.segments[target.segments.length - 1])
}

/**
 * Where the viewer places a document view (`docView:setBounds`): the tab's
 * content area in the app page's CSS pixels (main scales by the page's zoom).
 * `null` hides it again (an overlay, a hidden tab): hidden and muted.
 */
export interface DocViewBounds { x: number; y: number; width: number; height: number }

/** No side of a view is ever larger than this (CSS px): a sanity bound, not a layout rule. */
const MAX_VIEW_SIDE = 16384

/**
 * Read a placement from the renderer: four finite numbers, a size of at least
 * one pixel each way, rounded to whole pixels; anything else is null (the
 * view is then hidden, never placed somewhere unexpected).
 */
export function docViewBounds(input: unknown): DocViewBounds | null {
  if (typeof input !== 'object' || input === null) return null
  const { x, y, width, height } = input as Record<string, unknown>
  const values = [x, y, width, height]
  if (!values.every(v => typeof v === 'number' && Number.isFinite(v))) return null
  const [rx, ry, rw, rh] = (values as number[]).map(Math.round)
  if (rw < 1 || rh < 1 || rw > MAX_VIEW_SIDE || rh > MAX_VIEW_SIDE || Math.abs(rx) > MAX_VIEW_SIDE || Math.abs(ry) > MAX_VIEW_SIDE) return null
  return { x: rx, y: ry, width: rw, height: rh }
}

/**
 * Where a placement lands in the window (DIP): the app page's CSS pixels times
 * its zoom, cut to the window's content area; null when nothing of it is left.
 */
export function docViewOnScreen(bounds: DocViewBounds, pageZoom: number, [contentWidth, contentHeight]: number[]): DocViewBounds | null {
  const zoom = Number.isFinite(pageZoom) && pageZoom > 0 ? pageZoom : 1
  const left = Math.max(0, Math.round(bounds.x * zoom))
  const top = Math.max(0, Math.round(bounds.y * zoom))
  const right = Math.min(contentWidth, Math.round((bounds.x + bounds.width) * zoom))
  const bottom = Math.min(contentHeight, Math.round((bounds.y + bounds.height) * zoom))
  return right - left >= 1 && bottom - top >= 1 ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

/** The document's zoom steps (［－］［＋］); 1 is 「元の大きさ」. */
export const DOC_ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

/** A zoom factor from the renderer, kept within the steps' range; null when not a number. */
export function docZoomFactor(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input)) return null
  return Math.min(DOC_ZOOM_STEPS[DOC_ZOOM_STEPS.length - 1], Math.max(DOC_ZOOM_STEPS[0], input))
}

/**
 * What main tells the main window about one of its document views
 * (`docView:event`): the member pressed a link to the web inside it (`link`:
 * the app asks before the member's browser opens it), or the view went by
 * itself (`gone`: its page crashed, or more views were opened than a window keeps), or the member
 * pressed one of the app's shortcuts while the document had the keyboard (`shortcut`: the key, run
 * by the window as if pressed in the document's tab), or its page wanted internet parts that were
 * not loaded (`blocked`: the whole tally so far, hosts only — `DocBlockedParts`).
 */
export type DocViewEvent =
  | { viewId: number; kind: 'link'; url: string }
  | { viewId: number; kind: 'gone' }
  | { viewId: number; kind: 'shortcut'; key: KeyInput }
  | ({ viewId: number; kind: 'blocked' } & DocBlockedParts)

/**
 * The internet parts a document's page wanted and did not get (doc-frame.md "The band of blocked
 * internet parts", A3), for the band over it: how many different addresses (`count`, at most
 * `DOC_BLOCKED_PARTS_MAX`) and their hosts (`hosts`, distinct, at most `DOC_BLOCKED_HOSTS_MAX`, in
 * the order first seen). **Hosts only**: an address's path and query may carry what the page holds
 * (a document can put its content into a URL), so they never leave main. `count: 0` = the page
 * loaded again and wanted nothing yet.
 */
export interface DocBlockedParts {
  count: number
  hosts: string[]
  /** How many different hosts in all (beyond the named ones too): a host past the cap still brings a dismissed band back. */
  hostCount: number
}

/** The band names at most this many hosts (the rest is counted only). */
export const DOC_BLOCKED_HOSTS_MAX = 20
/** Different blocked addresses counted per page (a page asking in a loop counts no further). */
export const DOC_BLOCKED_PARTS_MAX = 999

const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])
const HOST_RE = /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}\.?$|^\[[0-9a-f:.]{2,45}\]$/

/**
 * The host of an internet address a document wanted (lower case, punycode for a non-ASCII name, no
 * port, user name, path or query), or null for anything that is not a web address — a file, data or
 * another scheme is not an internet part — or whose host is not a plain name / IP address.
 */
export function blockedWebHost(url: string): string | null {
  if (typeof url !== 'string' || url.length > 8192) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!WEB_SCHEMES.has(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase()
  return host.length > 0 && host.length <= 253 && HOST_RE.test(host) ? host : null
}

/**
 * The command areas around a document's view: it sits in the editor (its tab), inside the app.
 * Their shortcuts (the catalog's) reach the app even while the document has the keyboard.
 */
export const DOC_VIEW_SHORTCUT_AREAS: readonly CommandArea[] = ['editor', 'app']

/**
 * Whether a key pressed in a document's view is one of the app's shortcuts, which main takes from
 * the document and hands to the window (doc-frame.md "App shortcuts in a document"): the command it
 * would run, or null (the key stays the document's: arrows, typing, Space, Enter). On a Mac only ⌘
 * counts: Ctrl+letter is the text fields' own editing key (Ctrl+K, Ctrl+B), left to the document;
 * a binding marked `notInHtmlDocument` (⌘F: nothing on an HTML tab) is the document's too.
 */
export function docViewShortcutOf(input: KeyInput, mac: boolean): string | null {
  if (isMacControlKey(input, mac)) return null
  return shortcutOf(COMMANDS, input, DOC_VIEW_SHORTCUT_AREAS, def => !def.keybinding?.notInHtmlDocument)
}

/** `docView:open`: the view showing the document (the renderer never sees its address), or why not. */
export type DocViewOpenResult = { ok: true; viewId: number } | DocFrameRefused

export interface DocFrameRefused { ok: false; reason: DocFrameRefusal; message: string }

export type DocFrameRefusal = 'not_html' | 'not_found' | 'not_allowed' | 'not_downloaded' | 'too_large' | 'top_level' | 'unavailable'

export const DOC_FRAME_WORDS: Readonly<Record<DocFrameRefusal, string>> = {
  not_html: 'HTML のファイルではないため、表示できません。',
  not_found: 'ファイルが見つかりません。',
  not_allowed: 'このファイルはアプリの中で表示できません。',
  not_downloaded: 'このパソコンにダウンロードしていないフォルダのファイルです。',
  too_large: 'ファイルが大きすぎるため表示できません（20 MB まで）。',
  top_level: '会社フォルダのいちばん上にある HTML は表示できません。部署などのフォルダに入れてください。',
  unavailable: 'いまは表示できません。もう一度お試しください。',
}
