/**
 * Does a write the page made fit one frame of the run (agent-browser.md "Writes within frames"; redesign step ⑤)? The
 * one copy of that rule: the server asks it at every permit (with what the app read of the held request) and the app
 * (step ⑤b) asks it before it asks for a permit. Pure (shared-core.md); **knows no site** — the frames are a company's
 * data (`browser-skill.ts`).
 *
 * The request is given as the app sees it **without its values**: the method, the path with its raw query (no fragment) and only
 * the body fields the frame fixes, plus the body's `_method` whenever the body carries one. A request that names any other
 * field, or a `_method` the frame does not declare (I4: never through any write), does not fit.
 *
 * Path patterns (`browser-skill.ts` `isBrowserSkillPath`): literal segments match exactly; `{n}` a run of ASCII digits;
 * `{x}` one non-empty segment of URL path characters — never `.` / `..` (also percent-encoded), never an encoded slash or
 * backslash; a trailing `/` must match a trailing `/`. `{created}` is an after-read placeholder: a write never has one.
 * `{made:<n>}` (agent-browser.md "Writes only to what this run made") fits only an id the n-th frame's own write returned
 * in this run — `made`, what the server recorded (and the app kept from the same answers); without it, nothing fits.
 *
 * The query (agent-browser.md "A write with an exact query"): a frame without one fits only an address with **no** `?` at all;
 * a frame with one fits only an address whose raw query (everything after the first `?`) is **byte for byte** the declared
 * one — no decoding, no reordering, so an encoding trick, `;`, `+`, a fragment, a repeated or extra key, `key=` for `key`
 * or another order is simply another string. The declared query is the parser's one canonical spelling
 * (`browserSkillQueryProblem`), asked again here: a frame whose query is not one fits nothing.
 */
import { browserMadeSegmentPlace, browserSkillQueryProblem, type BrowserSkillWrite } from './browser-skill'

export interface BrowserFrameRequest {
  /** The request's method as sent (upper case). */
  method: string
  /**
   * The path, and — only when the address has one — `?` and its raw query exactly as sent (no scheme, host or fragment).
   * The wire shape of the permit since ⑤b: a query used to make it fit nothing.
   */
  path: string
  /** The body fields the frame fixes, and `_method` when the body has one (values as strings). Nothing else. */
  fields: Readonly<Record<string, string>>
}

/** Why a request does not fit a frame: fixed words, never a piece of the request. */
export type BrowserFrameMismatch = 'method' | 'path' | 'made' | 'query' | 'method-override' | 'fields'
export const BROWSER_FRAME_MISMATCHES: readonly BrowserFrameMismatch[] = ['method', 'path', 'made', 'query', 'method-override', 'fields']

/** What this run made, by the frame that made it (1-based): the ids its done writes returned. Absent: nothing made. */
export type BrowserMadeIds = ReadonlyMap<number, ReadonlySet<string>>

/** The most fields a request may name (the frame's fixed fields, ≤ 8, plus `_method`). */
export const BROWSER_FRAME_REQUEST_LIMITS = Object.freeze({ path: 2000, fields: 9, fieldName: 64, fieldValue: 100 })

const PATH_SEGMENT_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/
const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i
const ENCODED_SEPARATOR_RE = /%(?:2f|5c)/i

const anySegment = (segment: string) => segment.length > 0 && PATH_SEGMENT_RE.test(segment) && !DOT_SEGMENT_RE.test(segment) && !ENCODED_SEPARATOR_RE.test(segment)

/** `made`: what this run made (for `{made:<n>}`); `'shape'`: any one segment stands in for it (only to tell `made` from `path`). */
function segmentFits(pattern: string, segment: string, made: BrowserMadeIds | 'shape' | undefined): boolean {
  if (pattern === '{n}') return /^[0-9]+$/.test(segment)
  if (pattern === '{x}') return anySegment(segment)
  const place = browserMadeSegmentPlace(pattern)
  if (place !== null) {
    if (!anySegment(segment)) return false
    if (made === 'shape') return true
    return made?.get(place)?.has(segment) === true
  }
  if (pattern.startsWith('{')) return false // `{created}` or anything unknown: never in a write
  return segment === pattern
}

/**
 * True when the path matches the frame's path pattern segment by segment (`made`: what this run made, for a `{made:<n>}`
 * segment — without it such a segment fits nothing).
 */
export function browserFramePathFits(pattern: string, path: string, made?: BrowserMadeIds): boolean {
  return pathFits(pattern, path, made)
}

function pathFits(pattern: string, path: string, made: BrowserMadeIds | 'shape' | undefined): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > BROWSER_FRAME_REQUEST_LIMITS.path) return false
  // A query, fragment or backslash: refused outright (a second layer — no literal or placeholder segment takes them).
  if (!path.startsWith('/') || /[?#\\]/.test(path)) return false
  const want = pattern.split('/').slice(1)
  const got = path.split('/').slice(1)
  if (want.length !== got.length) return false
  return want.every((p, i) => (p === '' ? got[i] === '' && i === want.length - 1 : segmentFits(p, got[i], made)))
}

/**
 * Null when the request fits the frame; else why not. `made`: what this run made (the server's record at a permit, the
 * app's copy before asking) — a `{made:<n>}` frame fits only one of those ids (`made` when the path fits otherwise).
 */
export function browserFrameMismatch(frame: BrowserSkillWrite, request: BrowserFrameRequest, made?: BrowserMadeIds): BrowserFrameMismatch | null {
  if (request.method !== frame.method) return 'method'
  if (typeof request.path !== 'string' || request.path.length > BROWSER_FRAME_REQUEST_LIMITS.path) return 'path'
  const [path, query] = splitOnce(request.path)
  if (!pathFits(frame.path, path, made)) return pathFits(frame.path, path, 'shape') ? 'made' : 'path'
  if (frame.query === null ? query !== null : browserSkillQueryProblem(frame.query) !== null || query !== frame.query) return 'query'
  const declared = frame.fields._method
  const sent = Object.prototype.hasOwnProperty.call(request.fields, '_method') ? request.fields._method : undefined
  if (declared !== sent) return 'method-override'
  const names = Object.keys(request.fields)
  if (names.some(k => k !== '_method' && !Object.prototype.hasOwnProperty.call(frame.fields, k))) return 'fields'
  for (const [k, v] of Object.entries(frame.fields)) {
    if (!Object.prototype.hasOwnProperty.call(request.fields, k) || request.fields[k] !== v) return 'fields'
  }
  return null
}

/**
 * A plan the AI wrote (ad hoc, approved on the card) is narrower than a reviewed `browser.yaml`: every write path must
 * begin with a literal segment, so a frame can never be "any path" (`/{x}`, `/{n}/{x}`, `/`); and no `{made}` target
 * (`made`: "only what this run made" is a reviewed company Skill's — its parsed place is no wire format either); and no
 * query (`query`: a write with an exact query is a reviewed company Skill's too — a query can change what a write does, and
 * an AI-written plan has nobody but the card to review it). Null when it is.
 */
export function browserAdhocWritesProblem(writes: readonly BrowserSkillWrite[]): 'wide-path' | 'made' | 'query' | null {
  if (writes.some(w => w.path.split('/').some(seg => browserMadeSegmentPlace(seg) !== null))) return 'made'
  if (writes.some(w => w.query !== null)) return 'query'
  return writes.every((w) => {
    const first = w.path.split('/')[1] ?? ''
    return first !== '' && !first.startsWith('{')
  }) ? null : 'wide-path'
}

/**
 * Does a read (a GET the page or the operator makes) fall under one of a Skill's `never_read` patterns (a read that changes
 * something on the site, design memo I2)? The path matches the pattern's path part as a write's would (`{n}`, `{x}`,
 * literals); each query word the pattern names (`key`, or `key=value`) must be in the request's query, which may hold
 * more. A path that cannot be read is treated as falling under it (refused: the safe side).
 */
export function browserNeverReadFits(pattern: string, pathAndQuery: string): boolean {
  if (typeof pathAndQuery !== 'string' || !pathAndQuery.startsWith('/') || pathAndQuery.length > BROWSER_FRAME_REQUEST_LIMITS.path) return true
  const hash = pathAndQuery.indexOf('#')
  const bare = hash === -1 ? pathAndQuery : pathAndQuery.slice(0, hash)
  const [wantPath, wantQuery] = splitOnce(pattern)
  const [gotPath, gotQuery] = splitOnce(bare)
  if (!browserFramePathFits(wantPath, gotPath)) return false
  if (wantQuery === null) return true
  let params: Array<[string, string]>
  try {
    params = (gotQuery ?? '').split('&').filter(p => p !== '').map((p): [string, string] => {
      const at = p.indexOf('=')
      const k = decodeURIComponent((at === -1 ? p : p.slice(0, at)).replace(/\+/g, ' '))
      const v = at === -1 ? '' : decodeURIComponent(p.slice(at + 1).replace(/\+/g, ' '))
      return [k, v]
    })
  } catch {
    return true
  }
  return wantQuery.split('&').every((word) => {
    const at = word.indexOf('=')
    if (at === -1) return params.some(([k]) => k === word)
    return params.some(([k, v]) => k === word.slice(0, at) && v === word.slice(at + 1))
  })
}

function splitOnce(s: string): [string, string | null] {
  const q = s.indexOf('?')
  return q === -1 ? [s, null] : [s.slice(0, q), s.slice(q + 1)]
}

/**
 * What the site's answer to a sent write means (agent-browser.md "Recovering from a failed write"; the one rule the app
 * asks): `done` for a success or a redirect (2xx / 3xx: the site took it — a classic form whose error is a 302 back to the
 * form counts as done too: the after-read and the card show it); **`refused` only for the 4xx on this list**, the ones
 * that say the request was not taken (a bad or invalid request, the login or the CSRF value run out, not allowed, no such
 * address or method, too large, the wrong body type) — the run goes on, and a corrected try is a new write with its own
 * permit and unit; nothing is resent automatically; **`unknown` for every other status**, decided on the safe side —
 * every other 4xx (408 timed out, 409 a conflict after a partial or concurrent change, 424, 425, 429, a proxy's 460 / 463 /
 * 499 …), every 5xx and anything outside 200–499 —: the run is then locked and nothing more is sent. This reverses the
 * runner's earlier rule "every non-success is unknown" (6b-2c) for the listed codes only.
 */
export const BROWSER_WRITE_REFUSED_4XX: readonly number[] = [400, 401, 403, 404, 405, 410, 411, 413, 414, 415, 419, 422]
export function browserWriteAnswerKind(status: number): 'done' | 'refused' | 'unknown' {
  if (!Number.isInteger(status)) return 'unknown'
  if (status >= 200 && status < 400) return 'done'
  return BROWSER_WRITE_REFUSED_4XX.includes(status) ? 'refused' : 'unknown'
}
