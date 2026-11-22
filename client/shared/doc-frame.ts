/**
 * `acb-doc://<token>/<file>` — the HTML viewer's address (`.claude/rules/doc-frame.md`).
 *
 * An HTML document is someone else's program: it is shown in a frame sandboxed
 * without `allow-same-origin` (an opaque origin), and everything it loads comes
 * from this scheme. The token stands for one opened document's folder (main
 * keeps the map, `electron/features/doc-frames/protocol.ts`); the address never
 * carries an absolute path.
 *
 * Pure: the address grammar, the served file types and the frame's CSP. The
 * main process decides which file a request reaches.
 */

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

export function isDocAddress(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().startsWith(`${DOC_SCHEME}:`)
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
 * Whether a network request (http, https, ws, wss) comes from a document frame
 * or anything inside one: `frameUrls` = the requesting frame's URL, then its
 * parents'. The session guard (`electron-adapter.ts` `guardDocFrameNetwork`)
 * cancels those — a second wall behind the CSP, which does not cover a frame
 * navigating itself to a web address.
 */
export function isFromDocFrame(frameUrls: readonly (string | null | undefined)[]): boolean {
  return frameUrls.some(isDocAddress)
}

/** `docFrames:open`: the address of the document's frame, or why there is none (plain Japanese). */
export type DocFrameOpenResult = { ok: true; url: string } | DocFrameRefused

export interface DocFrameRefused { ok: false; reason: DocFrameRefusal; message: string }

export type DocFrameRefusal = 'not_html' | 'not_found' | 'not_allowed' | 'not_downloaded' | 'too_large'

export const DOC_FRAME_WORDS: Readonly<Record<DocFrameRefusal, string>> = {
  not_html: 'HTML のファイルではないため、表示できません。',
  not_found: 'ファイルが見つかりません。',
  not_allowed: 'このファイルはアプリの中で表示できません。',
  not_downloaded: 'このパソコンにダウンロードしていないフォルダのファイルです。',
  too_large: 'ファイルが大きすぎるため表示できません（20 MB まで）。',
}
