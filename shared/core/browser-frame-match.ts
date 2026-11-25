/**
 * Does a write the page made fit one frame of the run (agent-browser.md "Writes within frames"; redesign step ⑤)? The
 * one copy of that rule: the server asks it at every permit (with what the app read of the held request) and the app
 * (step ⑤b) asks it before it asks for a permit. Pure (shared-core.md); **knows no site** — the frames are a company's
 * data (`browser-skill.ts`).
 *
 * The request is given as the app sees it **without its values**: the method, the path (no query, no fragment) and only
 * the body fields the frame fixes, plus the body's `_method` whenever the body carries one. A request that names any other
 * field, or a `_method` the frame does not declare (I4: never through any write), does not fit.
 *
 * Path patterns (`browser-skill.ts` `isBrowserSkillPath`): literal segments match exactly; `{n}` a run of ASCII digits;
 * `{x}` one non-empty segment of URL path characters — never `.` / `..` (also percent-encoded), never an encoded slash or
 * backslash; a trailing `/` must match a trailing `/`. `{created}` is an after-read placeholder: a write never has one.
 */
import type { BrowserSkillWrite } from './browser-skill'

export interface BrowserFrameRequest {
  /** The request's method as sent (upper case). */
  method: string
  /** The path only: no scheme, host, query or fragment. */
  path: string
  /** The body fields the frame fixes, and `_method` when the body has one (values as strings). Nothing else. */
  fields: Readonly<Record<string, string>>
}

/** Why a request does not fit a frame: fixed words, never a piece of the request. */
export type BrowserFrameMismatch = 'method' | 'path' | 'method-override' | 'fields'
export const BROWSER_FRAME_MISMATCHES: readonly BrowserFrameMismatch[] = ['method', 'path', 'method-override', 'fields']

/** The most fields a request may name (the frame's fixed fields, ≤ 8, plus `_method`). */
export const BROWSER_FRAME_REQUEST_LIMITS = Object.freeze({ path: 2000, fields: 9, fieldName: 64, fieldValue: 100 })

const PATH_SEGMENT_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/
const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i
const ENCODED_SEPARATOR_RE = /%(?:2f|5c)/i

function segmentFits(pattern: string, segment: string): boolean {
  if (pattern === '{n}') return /^[0-9]+$/.test(segment)
  if (pattern === '{x}') return segment.length > 0 && PATH_SEGMENT_RE.test(segment) && !DOT_SEGMENT_RE.test(segment) && !ENCODED_SEPARATOR_RE.test(segment)
  if (pattern.startsWith('{')) return false // `{created}` or anything unknown: never in a write
  return segment === pattern
}

/** True when the path matches the frame's path pattern segment by segment. */
export function browserFramePathFits(pattern: string, path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > BROWSER_FRAME_REQUEST_LIMITS.path) return false
  // A query, fragment or backslash: refused outright (a second layer — no literal or placeholder segment takes them).
  if (!path.startsWith('/') || /[?#\\]/.test(path)) return false
  const want = pattern.split('/').slice(1)
  const got = path.split('/').slice(1)
  if (want.length !== got.length) return false
  return want.every((p, i) => (p === '' ? got[i] === '' && i === want.length - 1 : segmentFits(p, got[i])))
}

/** Null when the request fits the frame; else why not. */
export function browserFrameMismatch(frame: BrowserSkillWrite, request: BrowserFrameRequest): BrowserFrameMismatch | null {
  if (request.method !== frame.method) return 'method'
  if (!browserFramePathFits(frame.path, request.path)) return 'path'
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
 * begin with a literal segment, so a frame can never be "any path" (`/{x}`, `/{n}/{x}`, `/`). Null when it is.
 */
export function browserAdhocWritesProblem(writes: readonly BrowserSkillWrite[]): 'wide-path' | null {
  return writes.every((w) => {
    const first = w.path.split('/')[1] ?? ''
    return first !== '' && !first.startsWith('{')
  }) ? null : 'wide-path'
}
