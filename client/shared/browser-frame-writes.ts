/**
 * Writes within frames, the app's half (redesign step ⑤b; agent-browser.md "Writes within frames, in the app"; design memo
 * §3 I3 / I4 / I6 / I7 / I8, §6-1, §6-2, §9 bugs 1 / 3 / 4). The operator AI operates a registered domain freely and may
 * press 「保存」: each write its page makes is **held** by the window, read here (method, path, the body's fields), matched
 * to one of the run's frames with the core's one rule (`browserFrameMismatch`), sent once by main under the server's
 * permit, and its answer handed back to the page. Pure: main's wiring (electron/features/browser/work.ts,
 * frame-writes.ts), the tool and tests import it. **Knows no site**: the frames are a company's data.
 *
 * What may flow where:
 * - the page's text, the body's values and the site's answers: the operator (the page as it sees it) and the member's card
 *   only — never the consultation AI, a log or the server;
 * - the server: a held write's shape (method, path, the frame's fixed fields) and fixed result words;
 * - the consultation AI: fixed words and its own headings by number (`workWordsForAi`);
 * - the run log: the method, the path as a pattern, the frame and the outcome (`workWriteLogStep`).
 * Cookies and CSRF values the page put in its request are sent as the page made them and never read into anything here.
 */
import { outsideValue, type OutsideValue } from '../../shared/core/outside-text'
import { browserFrameMismatch, browserFramePathFits, browserAdhocWritesProblem, type BrowserFrameMismatch, type BrowserFrameRequest, type BrowserMadeIds } from '../../shared/core/browser-frame-match'
import { browserSkillDeclarationFrom, browserSkillQueryWords, browserSkillWriteLine, type BrowserSkillWrite } from '../../shared/core/browser-skill'
import { isSensitiveFieldName } from '../../shared/core/browser-recording'
import { BROWSER_PROMISE_LIMITS, browserOpenSegments, browserPathSegments, browserPromiseImplicitField, type BrowserPermitCheck } from '../../shared/core/browser-run-promise'
import { browserRunAddressPattern, browserRunWriteMethod, type BrowserRunWriteOutcome, type BrowserRunWriteStep } from '../../shared/core/browser-run-log'
import { BROWSER_CARD_CHECKED_BY_WORDS, type BrowserCard, type BrowserCardCheck, type BrowserCardRow, type BrowserCardSection, type BrowserCardValue } from '../../shared/core/browser-card'
import type { BrowserFrameView } from '../../shared/types/browser-frames'
import type { BrowserWriteOutcome, BrowserWriteSteps } from './browser-runner'
import { BROWSER_ANSWER_PROBLEM_WORDS, stopQuestion, type BrowserAnswerProblem, type BrowserStopNext } from './browser-operator-trail'
import {
  BROWSER_BROWSE_LIMITS, BROWSER_BROWSE_STOPS, OPERATOR_ACTION_LINES, OPERATOR_MEMO_KEYS, OPERATOR_OUTSIDE_LINE, OPERATOR_REASON_LINE, OPERATOR_SCREEN_LINES, browseHeading, operatorReason, parseBrowseAnswer,
  type BrowserBrowseAction, type BrowserBrowseStop, type BrowserOperatorHistoryEntry, type BrowserPageSnapshot,
} from './browser-browse'

/** The chat AI's one generic write tool (`mcp__acb_browser__browser_work`). */
export { BROWSER_WORK_TOOL, BROWSER_WORK_TOOL_ID } from './browser-browse'

export const BROWSER_WORK_LIMITS = Object.freeze({
  /** Write tasks per consultation turn (each one asks the member, or is a pre-approved company Skill). */
  callsPerTurn: 1,
  /** A held write's body read at most (larger: refused, never sent). */
  body: 1024 * 1024,
  /** The preview's plan for the card. */
  summary: 1000,
  affects: 500,
  values: 10,
  valueLabel: 40,
  value: 200,
  /** The operator's checks after writing (AI が確かめた). */
  checks: 20,
  checkItem: 60,
  checkValue: 300,
  comparedName: 40,
  /** One after-read page on the card: fields, each value. */
  afterFields: 30,
  afterValue: 300,
  /**
   * What the person said, as the consultation AI hands it (`said`: their prohibitions and limits, each as said; `values`:
   * the values they gave): the operator's first source, apart from the Skill's steps (agent-browser.md "The operator works
   * from the approved steps").
   */
  said: 10,
  saidChars: 300,
  personValues: 16,
  personLabel: 40,
  personValue: 200,
  /**
   * After the operator's press, typing or choice: how long main still watches for a write the page's script makes a
   * moment later, before the next look at the page (one value for every site; then every held write is waited for).
   */
  writeStartMs: 1000,
  /**
   * A press, typing or choice that follows another such action which has made no write yet is done only once this long
   * has passed since that one (a page may start its write seconds after the press): one value for every site; usually
   * already over, since the operator's own step takes longer.
   */
  pressGapMs: 5000,
})
const L = BROWSER_WORK_LIMITS

// ── A held write ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A held write's body as the window could read it: none, its bytes as text, or not readable (a file, a stream, too large). */
export type HeldBody = { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'unreadable' }

/**
 * A write the page made, held by the window (DevTools Fetch, `ai` mode of a write run): what the core may read of it, and
 * `send` — the shell's one way to send **exactly that request** (its method, address, headers and bytes, with the window's
 * login) once over the write session's fresh connection, asking `steps.ready` (the permit) after the session is prepared
 * and `steps.beforeSend` synchronously right before it leaves. Its Cookie and CSRF values never pass through main's code.
 */
export interface HeldPageWrite {
  method: string
  url: string
  contentType: string
  body: HeldBody
  send(steps: BrowserWriteSteps): Promise<BrowserWriteOutcome>
}

/** What the window does with the held request: fail it (the page sees a network error), or answer it with the site's answer. */
export type HeldPageWriteAnswer =
  | { kind: 'fail' }
  | { kind: 'fulfill'; status: number; headers: ReadonlyArray<readonly [string, string]>; body: Uint8Array }

/** A write run's hooks on the window (`BrowserBrowseSurface.enter`). */
export interface BrowserWorkHooks {
  holdWrite(held: HeldPageWrite): Promise<HeldPageWriteAnswer>
  /** A read of the operated host the page or the operator must not make (a Skill's `never_read`). */
  neverRead(pathAndQuery: string): boolean
  /**
   * The window's DevTools connection went while a write was held or parked: nothing more of the run is sent.
   * `originalMayHaveGone`: a write the page made was not parked yet, so Chromium may have let it go out as the page made
   * it (its outcome is then unknown); false: every original was parked and can no longer reach the site.
   */
  detached?(originalMayHaveGone: boolean): void
}

/** Why a held write is refused before any frame is asked (fixed words). */
export type HeldWriteProblem = 'host' | 'file' | 'unreadable' | 'repeated-method'

export interface HeldWriteShape {
  method: string
  /**
   * The path (no query); `query` the raw query string after the `?`, null when the address has no `?` at all — `''` for a
   * bare `?` (the URL parser's `search` drops it, but the site receives it: a frame without a query must not fit it).
   */
  path: string
  query: string | null
  /** Every body field by name (form, multipart text parts, a JSON object's top-level keys), values as text. */
  fields: ReadonlyMap<string, readonly string[]>
}

const formFields = (text: string): Map<string, string[]> => {
  const out = new Map<string, string[]>()
  for (const [k, v] of new URLSearchParams(text)) out.set(k, [...(out.get(k) ?? []), v])
  return out
}

/** A JSON body's top-level fields as text; not an object → no field (its `_method` cannot ride in it either). */
function jsonFields(text: string): Map<string, string[]> | null {
  let v: unknown
  try { v = JSON.parse(text) } catch { return null }
  const out = new Map<string, string[]>()
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out.set(k, [typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : x === null ? '' : '\u0000'])
  }
  return out
}

/** A multipart body's text parts; a part carrying a file (`filename`) refuses the whole write (design memo 追記). */
function multipartFields(text: string, contentType: string): Map<string, string[]> | 'file' | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = m ? (m[1] ?? m[2]) : null
  if (!boundary) return null
  const parts = text.split(`--${boundary}`)
  if (parts.length < 2 || !parts[parts.length - 1].startsWith('--')) return null
  const out = new Map<string, string[]>()
  for (const raw of parts.slice(1, -1)) {
    const part = raw.startsWith('\r\n') ? raw.slice(2) : raw
    const end = part.indexOf('\r\n\r\n')
    if (end === -1) return null
    const head = part.slice(0, end)
    const disposition = head.split('\r\n').find(l => /^content-disposition:/i.test(l))
    if (!disposition || !/form-data/i.test(disposition)) return null
    if (/;\s*filename\*?=/i.test(disposition)) return 'file'
    const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1]
    if (name === undefined) return null
    const value = part.slice(end + 4).replace(/\r\n$/, '')
    out.set(name, [...(out.get(name) ?? []), value])
  }
  return out
}

/**
 * The held write as the core may look at it, or why it is refused (never sent): another host or scheme; a body that could
 * not be read, of a kind the core cannot read (anything but a form, multipart text parts or JSON), or carrying a file; a
 * `_method` given twice. Only https on the operated host's default port.
 */
export function readHeldWrite(input: { method: string; url: string; host: string; contentType: string; body: HeldBody }): { ok: true; shape: HeldWriteShape } | { ok: false; problem: HeldWriteProblem } {
  let u: URL
  try { u = new URL(input.url) } catch { return { ok: false, problem: 'host' } }
  if (u.protocol !== 'https:' || u.hostname !== input.host || u.port !== '' || u.username !== '' || u.password !== '') return { ok: false, problem: 'host' }
  let fields: Map<string, string[]>
  const type = input.contentType.toLowerCase()
  if (input.body.kind === 'unreadable') return { ok: false, problem: 'unreadable' }
  if (input.body.kind === 'none' || input.body.text === '') fields = new Map()
  else if (input.body.text.length > L.body) return { ok: false, problem: 'unreadable' }
  // A raw `;` is refused: some server stacks split a form body on it too, so `type=note&title=x;type=admin` could be read
  // as another value than the one the frame was matched on (independent review of #856).
  else if (type.startsWith('application/x-www-form-urlencoded')) {
    if (input.body.text.includes(';')) return { ok: false, problem: 'unreadable' }
    fields = formFields(input.body.text)
  }
  else if (/^application\/([a-z0-9.+-]*\+)?json\b/.test(type)) {
    const j = jsonFields(input.body.text)
    if (!j) return { ok: false, problem: 'unreadable' }
    fields = j
  } else if (type.startsWith('multipart/form-data')) {
    const mp = multipartFields(input.body.text, input.contentType)
    if (mp === 'file') return { ok: false, problem: 'file' }
    if (!mp) return { ok: false, problem: 'unreadable' }
    fields = mp
  } else return { ok: false, problem: 'unreadable' }
  if ((fields.get('_method')?.length ?? 0) > 1) return { ok: false, problem: 'repeated-method' }
  // `search` is '' both for no `?` and for a bare one; the address (without its fragment) tells them apart.
  const query = u.search !== '' ? u.search.slice(1) : u.href.split('#')[0].includes('?') ? '' : null
  return { ok: true, shape: { method: input.method.toUpperCase(), path: u.pathname, query, fields } }
}

/** One frame of the run as the app holds it: the server's view (its fixed fields, how many units are left). */
export type WorkFrame = Pick<BrowserFrameView, 'frame' | 'method' | 'path' | 'fields' | 'max' | 'left' | 'body' | 'bind'> & {
  /** The exact query (null: none; the server's view leaves it out then). Required here so no copy of a frame drops it. */
  query: string | null
}

/** The frame as the core's one rule reads it. */
const frameWrite = (f: WorkFrame): BrowserSkillWrite => ({ method: f.method, path: f.path, query: f.query, max: f.max, fields: f.fields })

/** The server's frame as the app holds it (`query` absent from the view = none). */
export const workFrameOf = (f: BrowserFrameView): WorkFrame => ({
  frame: f.frame, method: f.method, path: f.path, query: typeof f.query === 'string' ? f.query : null, fields: { ...f.fields }, max: f.max, left: f.left,
  ...(Array.isArray(f.body) ? { body: [...f.body] } : {}), ...(f.bind && typeof f.bind === 'object' ? { bind: { ...f.bind } } : {}),
})

/**
 * What a permit carries for the run's promise (agent-browser.md "The run's promise"; the core's `browserPromiseVerdict`
 * reads it on both sides): every body field but `_method` and login / CSRF / session fields with the keyed digest of its
 * value (a repeated field: of all its values together, so it never equals one promised value), and per path segment the
 * digest of a segment the frame leaves open (`{n}` / `{x}`). Null when the body cannot be told whole (a field name too long
 * or with a control character, too many fields): such a write is not sent.
 */
export function promiseCheckOf(frame: Pick<WorkFrame, 'path'>, shape: HeldWriteShape, digest: (value: string) => string): BrowserPermitCheck | null {
  const fields: Record<string, string> = {}
  for (const [k, values] of shape.fields) {
    // Only `_method` and the frameworks' anti-forgery tokens stay out; a name that merely looks like a login field is checked
    // (its value only as a keyed digest, like every other).
    if (browserPromiseImplicitField(k)) continue
    // eslint-disable-next-line no-control-regex
    if (k.length === 0 || k.length > BROWSER_PROMISE_LIMITS.checkFieldName || /[\u0000-\u001f\u007f]/.test(k)) return null
    fields[k] = digest(values.length === 1 ? values[0] : JSON.stringify(values))
  }
  if (Object.keys(fields).length > BROWSER_PROMISE_LIMITS.checkFields) return null
  const segments = browserPathSegments(shape.path)
  const open = new Set(browserOpenSegments(frame.path))
  return { fields, segments: segments.map((seg, i) => (open.has(i) ? digest(seg) : null)) }
}

/**
 * The request a permit carries for this frame: the method, the path with its raw query (a frame without one never fits a
 * query; one with a query only that exact string: agent-browser.md "A write with an exact query"),
 * the frame's fixed fields as the body holds them and the body's `_method` — nothing else (the server asks the same rule).
 * Null when a fixed field or `_method` is given more than once (it cannot be one value).
 */
export function frameRequestFor(frame: Pick<WorkFrame, 'fields'>, shape: HeldWriteShape): BrowserFrameRequest | null {
  const fields: Record<string, string> = {}
  for (const name of [...Object.keys(frame.fields), '_method']) {
    const values = shape.fields.get(name)
    if (!values) continue
    if (values.length !== 1) return null
    fields[name] = values[0]
  }
  return { method: shape.method, path: shape.query === null ? shape.path : `${shape.path}?${shape.query}`, fields }
}

/**
 * The first frame with a unit left that the held write fits, or why none (`used-up` when one fits but is spent, else the
 * first frame's reason). `made`: what this run made so far (the ids the server recorded from this run's done writes), for a
 * `{made:<n>}` frame.
 */
export function pickFrame(frames: readonly WorkFrame[], shape: HeldWriteShape, made?: BrowserMadeIds): { frame: WorkFrame; request: BrowserFrameRequest } | { mismatch: BrowserFrameMismatch | 'used-up' | 'none' } {
  let first: BrowserFrameMismatch | null = null
  let usedUp = false
  for (const f of frames) {
    const request = frameRequestFor(f, shape)
    const why = request ? browserFrameMismatch(frameWrite(f), request, made) : 'fields'
    if (why === null && request) {
      if (f.left > 0) return { frame: f, request }
      usedUp = true
      continue
    }
    first ??= why
  }
  return { mismatch: usedUp ? 'used-up' : first ?? 'none' }
}

/**
 * The body's fields worth comparing with what the site shows afterwards (the card's machine check): one value each, never a
 * login, CSRF or session field (`isSensitiveFieldName`), never a non-text JSON value. Kept in main's memory for the card.
 */
export function sentFields(shape: HeldWriteShape): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, values] of shape.fields) {
    if (k === '_method' || isSensitiveFieldName(k) || values.length !== 1 || values[0].includes('\u0000')) continue
    out[k] = values[0]
  }
  return out
}

// ── After the writes: what was created, what is read again ───────────────────────────────────────────────────────────

const CREATED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** The id a write's JSON answer names (`id`, else `data.id`): what `{created}` and `{made:<n>}` stand for. Null when none or not plain. */
export function createdIdOf(answerText: string): string | null {
  let v: unknown
  try { v = JSON.parse(answerText) } catch { return null }
  const idOf = (o: unknown): string | null => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    const id = (o as Record<string, unknown>).id
    const s = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === 'string' ? id : null
    return s !== null && CREATED_ID_RE.test(s) ? s : null
  }
  return idOf(v) ?? (v && typeof v === 'object' ? idOf((v as Record<string, unknown>).data) : null)
}

/** A done write as after-reads use it: its path and what it created (null: none named). */
export interface DoneWrite { path: string; created: string | null }

const commonPrefix = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/**
 * The address an `after_read` pattern names once the writes are done, or null when it cannot be told (then it is not
 * read, and the consultation AI hears its pattern as 「読めなかったもの」): `{created}` is the id created by the done write
 * whose path shares the longest beginning with the pattern's part before `{created}` (exactly one such write); `{n}` / `{x}`
 * are filled from exactly one done write's path that fits the pattern; a literal address is itself.
 */
export function afterReadAddress(pattern: string, done: readonly DoneWrite[]): string | null {
  return afterReadTarget(pattern, done)?.address ?? null
}

/**
 * The same, with the done write the address came from (the one that created it, or whose path it is): what that write
 * sent is what the card compares the read with. `from` is null for a literal address no write sent to.
 */
export function afterReadTarget(pattern: string, done: readonly DoneWrite[]): { address: string; from: number | null } | null {
  let address = pattern
  let from: number | null = null
  const at = pattern.indexOf('{created}')
  if (at !== -1) {
    const prefix = pattern.slice(0, at)
    const scored = done.map((w, i) => ({ w, i, n: commonPrefix(prefix, w.path) })).filter(s => s.w.created !== null)
    const best = Math.max(0, ...scored.map(s => s.n))
    const winners = scored.filter(s => s.n === best && best > 1)
    if (winners.length !== 1) return null
    address = pattern.replace('{created}', winners[0].w.created as string)
    if (address.includes('{created}')) return null
    from = winners[0].i
  }
  if (/\{[nx]\}/.test(address)) {
    const fits = [...new Set(done.map(w => w.path).filter(p => browserFramePathFits(address, p)))]
    if (fits.length !== 1) return null
    address = fits[0]
  }
  if (from === null) {
    const same = done.findIndex(w => w.path === address)
    from = same === -1 ? null : same
  }
  return { address, from }
}

/** The address to read **before** a held write for an after-read pattern: never for `{created}`; a literal, or this write's own path when it fits. */
export function beforeReadAddress(pattern: string, heldPath: string | null): string | null {
  if (pattern.includes('{created}')) return null
  if (!/\{[nx]\}/.test(pattern)) return pattern
  return heldPath !== null && browserFramePathFits(pattern, heldPath) ? heldPath : null
}

/**
 * The write ledger's machine check (agent-browser.md "The write ledger across requests"): did a write whose answer was
 * lost land? Only when the very address it wrote to was read before it and again after, **every** field it sent now reads
 * exactly the sent value, and **at least one** of them read otherwise before (so the read shows a change to what was sent,
 * not a state that was already so). Compared on the **whole** answers (`before` / `after`: the JSON objects' texts, never
 * the card's shortened rows — Codex review: a 300-character cut or a field past the card's 30 would pass for equal or
 * changed), each field a top-level text, number or boolean, the changed one present before too. Anything less — nothing
 * sent, a field missing or not plain, one value different, nothing changed, a read missing or not a JSON object — is no
 * proof: the person is asked. The caller also requires the write's own body to be whole (`sentBodyWhole`).
 */
export function readBackLanded(sent: Readonly<Record<string, string>> | null, before: string | null, after: string | null): boolean {
  const was = jsonObject(before)
  const now = jsonObject(after)
  if (!sent || !was || !now) return false
  const fields = Object.entries(sent)
  if (fields.length === 0) return false
  const plain = (o: Record<string, unknown>, k: string): string | null => {
    if (!Object.prototype.hasOwnProperty.call(o, k)) return null
    const x = o[k]
    return typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : null
  }
  return fields.every(([k, v]) => plain(now, k) === v) && fields.some(([k, v]) => { const b = plain(was, k); return b !== null && b !== v })
}
/**
 * "Sent is not done": a refused write is known **not saved** only when its own address, read right before it and again
 * now, is one JSON object holding **every** field the write sent as a top-level plain value, and the whole answer reads
 * exactly as before (independent review of #907: a list page whose text did not move proves nothing about a create).
 * Anything less — nothing sent, a field the read does not show, a changed text, not JSON — is not proof.
 */
export function readBackUnchanged(sent: Readonly<Record<string, string>> | null, before: string | null, after: string | null): boolean {
  const was = jsonObject(before)
  const now = jsonObject(after)
  if (!sent || !was || !now || before !== after) return false
  const fields = Object.keys(sent)
  if (fields.length === 0) return false
  const plain = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k) && ['string', 'number', 'boolean'].includes(typeof o[k])
  return fields.every(k => plain(was, k) && plain(now, k))
}
const jsonObject = (text: string | null): Record<string, unknown> | null => {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Whether `sentFields` holds the whole of what a held write said (the read-back may then speak for the write): every field
 * but `_method` and the login / CSRF / session ones is one plain value — none repeated, none nested in JSON.
 */
export function sentBodyWhole(shape: HeldWriteShape): boolean {
  for (const [k, values] of shape.fields) {
    if (k === '_method' || isSensitiveFieldName(k)) continue
    if (values.length !== 1 || values[0].includes('\u0000')) return false
  }
  return true
}

/** A page's JSON object as the card's rows: its top-level plain values (a list of plain values joined), at most 30. Null: not a JSON object. */
export function topFields(answerText: string): Array<[string, string]> | null {
  let v: unknown
  try { v = JSON.parse(answerText) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Array<[string, string]> = []
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (out.length >= L.afterFields) break
    if (isSensitiveFieldName(k)) continue
    const text = x === null ? 'なし'
      : typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? String(x)
        : Array.isArray(x) && x.every(e => e === null || ['string', 'number', 'boolean'].includes(typeof e)) ? (x.length ? x.map(String).join('、') : 'なし')
          : '（入れ子の値）'
    out.push([k.slice(0, 60), text.slice(0, L.afterValue)])
  }
  return out
}

// ── The operator: its answers and what it is shown ──────────────────────────────────────────────────────────────────

export interface WorkPlanValue { label: string; value: string }
export interface WorkCheck { item: string; before: string | null; after: string; compared: string | null; ok: boolean }

export type WorkAnswer =
  | BrowserBrowseAction
  /** The preview's plan for the card: what will be done, who else is affected, the key values read, and (ad hoc) the frames. */
  | { do: 'plan'; summary: string; affects: string; values: WorkPlanValue[]; writes: AdhocPlanWrite[] | null; unread: number[] }
  /** Done writing: the summary for the card, the headings not read, what the operator checked (AI が確かめた). */
  | { do: 'done'; result: string; unread: number[]; checks: WorkCheck[]; comparedName: string | null }
  /**
   * Stopped: the fixed word, the headings not read, and — for a person's decision — what to decide (`question`: outside text,
   * the person's card only, one clean line ≤ 300 or null; never the consultation AI's, a log's or the server's).
   */
  | { do: 'stop'; why: BrowserBrowseStop; unread: number[]; question: string | null }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
const clean = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v.replace(CONTROL_RE, ' ') : null)
/**
 * A plan's words for the card: a string, its control characters dropped, cut to `max` with an ellipsis when longer (the
 * operator's overlong summary or value is shown cut, never a reason to refuse the plan); null when not a string.
 */
const cut = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(CONTROL_RE, ' ')
  if (s.length <= max) return s
  // Never half a surrogate pair at the cut.
  const end = /[\ud800-\udbff]/.test(s.charAt(max - 2)) ? max - 2 : max - 1
  return `${s.slice(0, end)}…`
}
const hasOnly = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every(k => keys.includes(k))
/** An answer itself (not an item inside it) may also carry the operator's notes and reason. */
const answerHasOnly = (o: Record<string, unknown>, keys: readonly string[]) => hasOnly(o, [...keys, ...OPERATOR_MEMO_KEYS])

function unreadOf(v: unknown, items: number): number[] | null {
  if (!Array.isArray(v) || v.length > items) return null
  const seen = new Set<number>()
  for (const n of v) {
    if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > items || seen.has(n as number)) return null
    seen.add(n as number)
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * An ad-hoc plan's write as the start sends it (`POST /browser-frame-runs { plan }`): written as `browser.yaml` writes are,
 * so **no `query` key** — an AI-written plan never carries one (`browserAdhocWritesProblem`), and the server's strict
 * parser refuses even `query: null`.
 */
export type AdhocPlanWrite = Omit<BrowserSkillWrite, 'query'>

/**
 * The operator's answer in a write run: one of the window tools' actions (`parseBrowseAnswer`, the same rules), or — in
 * the preview — `plan`, or — while writing — `done`; `stop` in both. Anything else ends the run (`problem`). An ad-hoc
 * plan's frames are checked with the declaration's own rules and the ad-hoc one (every path begins with a literal); a Skill
 * run's plan names none (the server's frames are the only ones).
 */
export function parseWorkAnswer(text: string, ctx: { snapshot: BrowserPageSnapshot | null; items: number; phase: 'preview' | 'work'; adhoc: boolean; domain: string }): { answer: WorkAnswer; notes?: string; reason?: string; unlisted?: string } | { problem: string } {
  let v: unknown
  try { v = JSON.parse(text.trim()) } catch { return { problem: 'not-json' } }
  if (!isMap(v) || typeof v.do !== 'string') return { problem: 'shape' }
  const notes = v.notes === undefined ? undefined : clean(v.notes, BROWSER_BROWSE_LIMITS.notes)
  if (notes === null) return { problem: 'notes' }
  const reason = operatorReason(v.reason)
  if (reason === false) return { problem: 'reason' }
  const unlisted = operatorReason(v.unlisted)
  if (unlisted === false) return { problem: 'unlisted' }
  const withNotes = (answer: WorkAnswer) => ({ answer, ...(notes !== undefined ? { notes } : {}), ...(reason !== undefined ? { reason } : {}), ...(unlisted !== undefined ? { unlisted } : {}) })
  if (v.do === 'plan') {
    // Lenient only where it is safe (production trial 2026-11-27: a sensible plan refused for a slip of form): the card's
    // words are cut to their caps instead of refused, and a Skill run's `writes: null` reads as none. Unknown keys, the
    // types, the item numbers and an ad-hoc plan's writes stay strict.
    if (ctx.phase !== 'preview') return { problem: 'plan' }
    if (!answerHasOnly(v, ['do', 'summary', 'affects', 'values', 'writes', 'unread'])) return { problem: 'plan-keys' }
    const summary = cut(v.summary, L.summary)
    if (!summary || summary.trim() === '') return { problem: 'plan-summary' }
    const affects = cut(v.affects ?? '', L.affects)
    if (affects === null) return { problem: 'plan-affects' }
    const unread = unreadOf(v.unread ?? [], ctx.items)
    if (!unread) return { problem: 'plan-unread' }
    if (!Array.isArray(v.values) || v.values.length > L.values) return { problem: 'plan-values' }
    const values: WorkPlanValue[] = []
    for (const x of v.values) {
      if (!isMap(x) || !hasOnly(x, ['label', 'value'])) return { problem: 'plan-value' }
      const label = cut(x.label, L.valueLabel)
      const value = cut(x.value, L.value)
      if (!label || label.trim() === '' || value === null) return { problem: 'plan-value' }
      values.push({ label, value })
    }
    let writes: AdhocPlanWrite[] | null = null
    if (ctx.adhoc) {
      const parsed = browserSkillDeclarationFrom({ domain: ctx.domain, writes: v.writes })
      if (!parsed.ok || browserAdhocWritesProblem(parsed.declaration.writes)) return { problem: 'plan-writes' }
      writes = parsed.declaration.writes.map(w => ({ method: w.method, path: w.path, max: w.max, fields: { ...w.fields } }))
    } else if (v.writes !== undefined && v.writes !== null) return { problem: 'plan-writes' }
    return withNotes({ do: 'plan', summary, affects, values, writes, unread })
  }
  if (v.do === 'done') {
    if (ctx.phase !== 'work' || !answerHasOnly(v, ['do', 'result', 'unread', 'checks', 'compared_name'])) return { problem: 'done' }
    const result = clean(v.result, BROWSER_BROWSE_LIMITS.result)
    const unread = unreadOf(v.unread ?? [], ctx.items)
    const comparedName = v.compared_name === undefined || v.compared_name === null ? null : clean(v.compared_name, L.comparedName)
    const rawChecks = v.checks ?? []
    if (result === null || !unread || comparedName === null && v.compared_name !== undefined && v.compared_name !== null || !Array.isArray(rawChecks) || rawChecks.length > L.checks) return { problem: 'done' }
    const checks: WorkCheck[] = []
    for (const c of rawChecks) {
      if (!isMap(c) || !hasOnly(c, ['item', 'before', 'after', 'compared', 'ok']) || typeof c.ok !== 'boolean') return { problem: 'done' }
      const item = clean(c.item, L.checkItem)
      const after = clean(c.after, L.checkValue)
      const before = c.before === undefined || c.before === null ? null : clean(c.before, L.checkValue)
      const compared = c.compared === undefined || c.compared === null ? null : clean(c.compared, L.checkValue)
      if (!item || after === null || (before === null && c.before !== undefined && c.before !== null) || (compared === null && c.compared !== undefined && c.compared !== null)) return { problem: 'done' }
      checks.push({ item, before, after, compared, ok: c.ok })
    }
    return withNotes({ do: 'done', result, unread, checks, comparedName })
  }
  if (v.do === 'stop') {
    const unread = unreadOf(v.unread ?? [], ctx.items)
    if (!answerHasOnly(v, ['do', 'why', 'unread', 'question']) || !unread || !(BROWSER_BROWSE_STOPS as readonly unknown[]).includes(v.why)) return { problem: 'stop' }
    // The question: a string (made one clean line, cut at its cap — a long one costs its end, never the run) or none.
    if (v.question !== undefined && v.question !== null && typeof v.question !== 'string') return { problem: 'stop' }
    return withNotes({ do: 'stop', why: v.why as BrowserBrowseStop, unread, question: stopQuestion(v.question) })
  }
  // An action: exactly the window tools' rules (the same element refs, roles, paths).
  const parsed = parseBrowseAnswer(text, { snapshot: ctx.snapshot, items: ctx.items })
  if ('problem' in parsed) return parsed
  if (parsed.answer.do === 'done' || parsed.answer.do === 'stop') return { problem: 'shape' }
  return {
    answer: parsed.answer, ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}), ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    ...(parsed.unlisted !== undefined ? { unlisted: parsed.unlisted } : {}),
  }
}

/**
 * The app's one re-ask after an answer out of its form (fixed words: the rule it broke, from `BROWSER_ANSWER_PROBLEM_WORDS`;
 * never the operator's own text).
 */
export function workRetrySentence(problem: BrowserAnswerProblem): string {
  return `答えの形が決まりに合いませんでした：${BROWSER_ANSWER_PROBLEM_WORDS[problem]}。決まった形の JSON 1つだけで、答え直してください。`
}

const ACTION_LINES = OPERATOR_ACTION_LINES
/** The `stop` answer of both write prompts (with the person's question for `need-person`). */
const WORK_STOP_LINE = '{"do":"stop","why":"need-login|need-person|not-found|blocked","unread":[<番号>],"question":"<need-person のとき本人に決めてほしいこと。ほかは null>"}'
/**
 * What the operator works from, in order (agent-browser.md "The operator works from the approved steps"): the person's own
 * prohibitions and values first, then the company Skill's approved steps, then (the work) the plan the person approved on
 * the preview's card; an ad-hoc task's request. The consultation AI's own additions are not in the material at all when a
 * Skill is used (`workMaterial`), so no line has to rank them.
 */
const WORK_SOURCE_LINE = (work: boolean) => `することと入れる値は person（本人の言葉）・steps（会社の Skill の手順）・${work ? 'plan（承認された下見の計画。null は下見なし）・' : ''}request（頼み）のとおりに、記号もそのまま。person.said の禁止・制約は steps より先に守る。`
/** When the operator may stop: these only (incident 2026-11-27: four stops, half of them on words the prompt itself gave). */
const WORK_STOP_WHEN = (work: boolean) => `stop は、ログインが要る（need-login）、頼まれたものがない（not-found）、${work ? 'writes に「分からない」（blocked）、' : ''}どこにも答えのない分かれ道（need-person。question は「はい」で進められる問い）のときだけ。person.said と steps がぶつかるときは、書く前に一度だけ need-person で聞く。ほかは手順に沿って進める。`
const commonLines = (screen: readonly string[]) => [OPERATOR_OUTSIDE_LINE, ...screen, OPERATOR_REASON_LINE]
const WORK_INTRO = (what: string) => `あなたは会社が登録したサイトで${what}係。毎回 JSON と画面の画像を受け取り、次の1つの JSON だけを返す。`

/** A tool set's lines (agent-browser.md "The operator's tool sets"): only these differ between the sets' prompts. */
export interface OperatorToolLines { actions: readonly string[]; screen: readonly string[] }

/** The write run's preview (read only): the operator reads what it needs and answers the plan for the member's card. */
export function workPreviewOperatorPrompt(lines: OperatorToolLines): string {
  return [
    WORK_INTRO('、頼まれた書く作業の下見をする'),
    ...lines.actions,
    '{"do":"plan","summary":"<これからすること>","affects":"<ほかに影響する人・もの>","values":[{"label":"<名前>","value":"<下見で読んだ大事な値>"}],"writes":<下>,"unread":[<読めなかった items の番号>]}',
    WORK_STOP_LINE,
    '下見なので読むだけ。変えるボタンは押さない。',
    'writes は frames が null のときだけ [{"method":"POST|PUT|PATCH|DELETE","path":"/<決まった語で始まる。数字は {n}、ほかの1区切りは {x}>","max":<1〜20>}]。',
    WORK_SOURCE_LINE(false),
    WORK_STOP_WHEN(false),
    ...commonLines(lines.screen),
  ].join('\n')
}

/** The write run itself: the operator may now press what writes, within the frames; it reports what it checked. */
export function workOperatorPrompt(lines: OperatorToolLines): string {
  return [
    WORK_INTRO('、人が承認した書く作業をする'),
    ...lines.actions,
    '{"do":"done","result":"<したこと。4000字まで>","unread":[<番号>],"checks":[{"item":"<60字まで>","before":"<前>","after":"<いま>","compared":"<比べ元>","ok":true|false}],"compared_name":"<比べ元の呼び名>"}',
    WORK_STOP_LINE,
    WORK_SOURCE_LINE(true),
    WORK_STOP_WHEN(true),
    '書き終えたら steps の確かめることをページで確かめ、checks に書いて done。',
    ...commonLines(lines.screen),
  ].join('\n')
}

const CURRENT_LINES: OperatorToolLines = { actions: ACTION_LINES, screen: OPERATOR_SCREEN_LINES }
export const BROWSER_OPERATOR_WORK_PREVIEW_PROMPT = workPreviewOperatorPrompt(CURRENT_LINES)
export const BROWSER_OPERATOR_WORK_PROMPT = workOperatorPrompt(CURRENT_LINES)

/** What the operator is told of each held write so far: fixed words only. */
export const WORK_WRITE_WORDS: Readonly<Record<BrowserRunWriteOutcome, string>> = {
  done: '送りました（サイトが答えました）',
  'not-sent': '送っていません',
  unknown: '分からない（届いたか分かりません。もう書かないでください）',
  refused: 'アプリが止めました（送っていません。理由は why）',
  'site-refused': 'サイトがエラーを返しました（保存されたかは確かめていません）。画面のエラーを見て直し、もう一度押せます（新しい書き込みとして枠を1回使います）',
}

/**
 * A held write whose result is not kept yet (on its way to the site, or queued behind one): its permit — and the frame's
 * unit — may already be taken, so the operator sees it beside the frames' `left` and never presses again for it.
 */
export const WORK_WRITE_SENDING = 'sending' as const
export const WORK_WRITE_SENDING_WORDS = '送っている途中です（サイトの答えを待っています）'
/** An action the app did not do because a held write was being sent (it could have made a second write). */
export const WORK_NOT_PRESSED_WHILE_SENDING = '送っている途中なので押していません'
export type WorkWriteState = BrowserRunWriteOutcome | typeof WORK_WRITE_SENDING

/** Why a held write was not sent, as the operator is told it (the app's own reasons; never the site's or the page's words). */
export const WORK_WRITE_WHY_WORDS = {
  'outside-frames': '計画の枠のどれにも合わない書き込みでした',
  'used-up': '合う枠の回数を使い切っていました',
  'not-made-here': 'この作業で作ったもの以外への書き込みでした',
  file: 'ファイルを送る書き込みでした（送れません）',
  unreadable: '中身を読めない書き込みでした',
  'other-host': '操作するサイトの外への書き込みでした',
  'run-over': '作業が終わったか止められていたので送っていません',
  'no-permit': '許可が出なかったか、作業が止まったので送っていません',
  'stopped-before-send': '送る直前の確かめで止めました（送っていません）',
  'outside-promise': 'この作業で約束した値と違う書き込みでした（送っていません）',
  'not-allowed': '約束にない書き込みを、本人が「書かない」と答えました（送っていません）',
} as const
export type WorkWriteWhy = keyof typeof WORK_WRITE_WHY_WORDS

/**
 * One held write as the operator is told of it: its state (kept outcome or `sending`), the frame it fitted (null: none
 * or not matched yet), after which of the operator's actions (its history's number; 0 = before any) it was held, and a
 * refusal's or a not-sent write's fixed reason. Nothing the page or the site sent.
 */
export interface WorkWriteSeen { state: WorkWriteState; frame: number | null; afterAction: number; why: WorkWriteWhy | null }

/**
 * What the person said, as handed to the operator: their prohibitions and limits, their values (each as said), and — when
 * this run continues one that stopped to ask — what they answered there (`decided`: the stopped operator's question, outside
 * text, and the card's fixed answer; agent-browser.md "The stopped card's answer").
 */
export interface WorkPerson {
  said: readonly string[]
  values: ReadonlyArray<{ label: string; value: string }>
  decided?: ReadonlyArray<{ question: string; answer: 'proceed' }>
}

/** The plan the person approved on the preview's card, for the work (its own words; null: no preview — a pre-approved Skill). */
export type WorkApprovedPlan = { summary: string; affects: string; values: readonly WorkPlanValue[] }

/**
 * The material of one step of a write run (agent-browser.md "The operator works from the approved steps"). **The page**
 * (address, title, text, element names and values), the item headings and the operator's own notes are outside text
 * (`{ outside }`, 【】 → 〔〕). What the operator works from is handed as written, each its own JSON value (the encoding is
 * the fence: nothing inside a value can end it), because the values it types come from them — a name written with 【】 must
 * reach the site with 【】 (incident 2026-11-27):
 * - `person`: what the person said — their prohibitions and limits (`said`) and values (`values`) — first;
 * - `steps`: the company Skill's steps, exactly the text the server sealed (null: no Skill, or none in it);
 * - `plan` (the work only): the preview's plan the person approved on the card, or null when there was no preview;
 * - `request`: the consultation AI's own words of the task — **only when no Skill's steps are handed** (an ad-hoc task, or a
 *   Skill with no steps on this PC: nothing else says what to do); with them the consultation AI's additions never reach
 *   the operator (`null`).
 */
export function workMaterial(input: {
  phase: 'preview' | 'work'
  /** The consultation AI's request: handed only when no Skill's steps are (`skill` false: no steps handed). */
  request: string
  person: WorkPerson
  skill: boolean
  items: readonly string[]
  steps: string | null
  /** The work's approved plan (null: no preview); not in the preview's material. */
  plan?: WorkApprovedPlan | null
  frames: readonly WorkFrame[] | null
  page: BrowserPageSnapshot
  history: readonly BrowserOperatorHistoryEntry[]
  /** Each held write so far: the kept ones, then the ones still being sent (`sending`). */
  writes: readonly WorkWriteSeen[]
  notes: string
  round: number
  /** The run's budget of steps (the server's answer: browser-run-budget.ts). */
  rounds: number
  /** Its last answer was out of form: the app's fixed sentence asking it to answer again (`workRetrySentence`). */
  retry?: string | null
}): unknown {
  const o = (s: string): OutsideValue => outsideValue(s)
  const p = input.page
  return {
    phase: input.phase,
    person: {
      said: [...input.person.said], values: input.person.values.map(v => ({ label: v.label, value: v.value })),
      ...(input.person.decided && input.person.decided.length > 0 ? { decided: input.person.decided.map(d => ({ question: o(d.question), answer: DECIDED_WORDS[d.answer] })) } : {}),
    },
    steps: input.steps === null || input.steps === '' ? null : input.steps,
    ...(input.phase === 'work' ? { plan: input.plan ? { summary: input.plan.summary, affects: input.plan.affects, values: input.plan.values.map(v => ({ label: v.label, value: v.value })) } : null } : {}),
    request: input.skill ? null : input.request,
    items: input.items.map((heading, i) => ({ number: i + 1, heading: o(heading) })),
    frames: input.frames ? input.frames.map(f => ({ frame: f.frame, method: f.method, path: f.path, ...(f.query !== null ? { query: f.query } : {}), fields: f.fields, left: f.left })) : null,
    page: {
      address: o(p.address), title: o(p.title), text: o(p.text), truncated: p.truncated,
      elements: p.elements.map(e => ({
        ref: e.ref, role: e.role, name: o(e.name),
        ...(e.path !== undefined ? { path: o(e.path) } : {}),
        ...(e.value !== undefined ? { value: o(e.value) } : {}),
        ...(e.options ? { options: e.options.map(o) } : {}),
        ...(e.checked !== undefined ? { checked: e.checked } : {}),
      })),
      ...(p.omitted ? { elementsLeftOut: p.omitted } : {}),
      ...(p.screen ? { screen: { width: p.screen[0], height: p.screen[1] } } : {}),
    },
    history: input.history.map((h, i) => (h.why === 'sending'
      ? { number: i + 1, do: h.do, ...(h.ref !== undefined ? { ref: h.ref } : {}), outcome: h.outcome, result: WORK_NOT_PRESSED_WHILE_SENDING }
      : { number: i + 1, ...h })),
    writes: input.writes.map((w, i) => ({
      number: i + 1, frame: w.frame, afterAction: w.afterAction,
      result: w.state === WORK_WRITE_SENDING ? WORK_WRITE_SENDING_WORDS : WORK_WRITE_WORDS[w.state],
      ...(w.state === WORK_WRITE_SENDING ? { sending: true } : {}),
      ...(w.why ? { why: WORK_WRITE_WHY_WORDS[w.why] } : {}),
    })),
    notes: o(input.notes),
    round: input.round,
    roundsLeft: input.rounds - input.round,
    ...(input.retry ? { retry: input.retry } : {}),
  }
}

/** The person's fixed answer as the next run's operator reads it. */
const DECIDED_WORDS = { proceed: 'はい（そのまま進める）' } as const

/** One page write of the run log (no value): the path as a pattern, the frame, the method, the outcome. */
export function workWriteLogStep(input: { after: number; frame: number | null; method: string; path: string; host: string; outcome: BrowserRunWriteOutcome }): BrowserRunWriteStep {
  return {
    after: input.after, frame: input.frame, method: browserRunWriteMethod(input.method), outcome: input.outcome,
    page: browserRunAddressPattern(`https://${input.host}${input.path}`, input.host) ?? '/{x}',
  }
}

// ── The consultation AI's fixed words ───────────────────────────────────────────────────────────────────────────────

/**
 * Why a write run stopped, each a fixed word the card and the consultation AI both say (incident 2026-11-27: one word for
 * "closed, stopped, the login or a setting changed, the time ran out" left the person guessing). The operator's own stops
 * (`BrowserBrowseStop`), then the app's: a write outside the plan (`refused`), the card not approved, the server out of
 * reach (`network`), the member's stop or the consultation closed (`stop-button`: the app cannot tell the two apart — both
 * end the turn's request), the AI stop (`ai-stopped`), the run's time (`timeout`) or steps (`rounds`), the site's window
 * closed, the app's sign-in / company / setting changed (`context-changed`), the operator AI not answering in its form
 * (`operator`), and the server refusing to go on (`server-refused`: a setting, a level, this PC). The write ledger's two
 * (agent-browser.md "The write ledger across requests"): an earlier write in doubt the person answered 「済んでいた」
 * (`earlier-done`: this request may be that same write again, so nothing is written) or left unanswered (`earlier-unknown`);
 * and a write whose answer was lost — the work stopped there — that the app's read-back then found landed (`read-back`).
 */
export const WORK_STOP_REASONS = [
  'not-found', 'need-login', 'need-person', 'blocked', 'refused', 'not-approved', 'network', 'stop-button', 'ai-stopped', 'timeout',
  'rounds', 'window-closed', 'context-changed', 'operator', 'server-refused', 'earlier-done', 'earlier-unknown', 'read-back',
  'steps-unsealed', 'steps-too-large', 'steps-missing', 'steps-changed',
] as const
export type WorkStopReason = typeof WORK_STOP_REASONS[number]

/**
 * What reading back says of a finished run (agent-browser.md "Sent is not done"): every write the site took read again and
 * holding what the run promised and sent (`matched`), something read otherwise (`differs`), or not every one could be read
 * and compared (`unconfirmed` — never a stop: the card says so). "The site answered success" alone is `unconfirmed`.
 */
export type WorkBusiness = 'matched' | 'differs' | 'unconfirmed'

export type WorkEnd =
  | { kind: 'done'; business?: WorkBusiness }
  | { kind: 'unknown' }
  | { kind: 'stopped'; why: WorkStopReason }

export const BROWSER_WORK_WORDS = {
  off: 'ブラウザ操作は、このアプリではまだ使えません。ユーザーにそう伝えてください。',
  badInput: '頼み方の形が正しくありません。site（下の一覧のサイト）、task（してほしいことを文で）、skill（会社や部署の Skill を使うときだけ、その名前か Skill のパス）、said（本人がはっきり言った禁止・制約。10個まで、各300字まで）、values（本人が言った値。{"label","value"} を16個まで、label 40字・value 200字まで）、items（読んでほしいものの見出し。10個まで、各40字まで）を入れて、もう一度呼んでください。',
  notAllowed: 'このサイトは、会社の設定でいま書き込みに使えません。ユーザーにそう伝えてください。',
  notGranted: 'ユーザーには、このサイトを AI に変えてもらう許可（変えてよい）がありません。管理者に頼むようユーザーに伝えてください。',
  stopped: 'AI の動きが止められているため、サイトに触れませんでした。ユーザーにそう伝えてください。',
  noWindow: 'このパソコンでサイトの窓が開いていません。設定の「ブラウザ操作」で窓を開いてログインしてから、もう一度頼むようユーザーに伝えてください。',
  busy: 'このサイトでは、いま別の AI の作業が動いています。終わってから、もう一度頼むようユーザーに伝えてください。',
  /** The server said the latest the holder frees the domain: rounded up to whole minutes, never a page's word. */
  busyFor: (minutes: number) => `このサイトでは、いま別の AI の作業が動いています。長くても約${minutes}分で空きます。空いてから、もう一度頼むようユーザーに伝えてください。`,
  tooLate: '時間切れ：計画の残り時間が足りないため、作業を始めませんでした。サイトには何も書いていません。もう一度頼むようユーザーに伝えてください。',
  pc: 'この PC は、ブラウザ操作に使えるようになっていません。設定の「ブラウザ操作」の「この PC」を確かめるようユーザーに伝えてください。',
  noOperator: 'この AI では、サイトを操作する係を使えません（Claude Code のときだけ使えます）。ユーザーにそう伝えてください。',
  offline: 'サーバーにつながらなかったため、サイトに触れませんでした。少し待ってから、もう一度頼むようユーザーに伝えてください。',
  failed: '作業をできませんでした。サイトには何も書いていません。少し待ってから、もう一度頼むようユーザーに伝えてください。',
  skill: 'その Skill は、いまブラウザ操作に使えません（承認されていない・直されて承認待ち・見つからないなど）。ユーザーに管理者へ確かめてもらってください。',
  skillAmbiguous: 'その名前の Skill が、全社と部署（または複数の部署）にあります。どれのことか決められないので、何もしていません。skill に Skill のパス（全社のものは .claude/skills/<名前>、部署のものは <部署のフォルダ>/.claude/skills/<名前>）を入れて頼み直してください。どれか分からなければユーザーに聞いてください。',
  tooMany: 'この返事の中で頼める書く作業は1回までです。ユーザーに結果のカードを見てもらってから、次の返事でまた頼んでください。',
  done: '済みました。読み直して、約束した値と送った値になっていることを確かめました。したことと読み直した結果はカードとして相談に出しました。サイトの内容はカードにだけ出ていて、あなたには見えません。内容を推測して書かず、ユーザーにカードを見るよう伝えて、次の作業に進んでください。',
  doneUnconfirmed: '書き込みは送り、サイトは受け付けました。ただ、読み直して約束どおりになったかは確かめられませんでした（止まってはいません）。したことはカードとして相談に出しました。サイトの内容はカードにだけ出ていて、あなたには見えません。内容を推測して書かず、ユーザーにカードを見て、サイトの画面で確かめるよう伝えてください。',
  doneDiffers: '書き込みは送り、サイトは受け付けましたが、読み直すと、約束した値や送った値と違う項目がありました。カードとして相談に出しました。サイトの内容はカードにだけ出ていて、あなたには見えません。内容を推測して書かず、ユーザーにカードを見て、サイトの画面で確かめるよう伝えてください。',
  unknown: '分からない書き込みがあります（送ったあと、サイトから答えが来ませんでした）。もう一度は送りません。ユーザーに、カードを見てサイトの画面で確かめてもらってください。',
  stoppedBy: {
    'not-found': '止まりました：頼まれたものがサイトで見つかりませんでした。',
    'need-login': '止まりました：サイトのログインが必要です。開いた窓でログインしてから、もう一度頼んでください。',
    'need-person': '止まりました：本人に決めてほしいことがあるので、ブラウザ操作の係の AI が止まりました。',
    blocked: '止まりました：画面が先に進めませんでした。',
    refused: '止まりました：書き込みが承認した範囲に合わなかったため、送らずに止めました。',
    'not-approved': '止まりました：ユーザーが計画を任せなかった（やめた・時間切れ）ので、何も書いていません。',
    network: '止まりました：サーバーとの通信が途切れました。',
    'stop-button': '止まりました：止めるボタンが押されたか、相談が閉じられました。',
    'ai-stopped': '止まりました：AI の動きが止められました（緊急停止）。',
    timeout: '止まりました：時間切れです（この作業に使える時間を使い切りました）。',
    rounds: '止まりました：この作業で操作できる回数の上限に達しました。',
    'window-closed': '止まりました：サイトの窓が閉じられました。',
    'context-changed': '止まりました：アプリのサインイン・会社・設定が変わりました。',
    operator: '止まりました：ブラウザ操作の係の AI が、決まった形で答えられませんでした。',
    'server-refused': '止まりました：サーバーが続けることを断りました（会社の設定・許可・この PC の登録のどれかが変わりました）。',
    'earlier-done': '止まりました：前に送って結果が分からなかった書き込みについて、ユーザーが「済んでいた」と答えました。同じものを二重に作らないよう、この作業ではサイトに何も書いていません。',
    'earlier-unknown': '止まりました：前に送って結果が分からない書き込みがあり、ユーザーの答え（済んでいた／されていなかった）がなかったため、この作業ではサイトに何も書いていません。',
    'read-back': '止まりました：書き込みの答えがサイトから来なかったため、作業をそこで止めました。読み直したところ、その書き込みは済んでいました（もう一度は送りません）。',
    'steps-unsealed': '始めませんでした：サーバーが Skill の手順の版を答えなかったため（サーバーが古い）、承認された手順か確かめられません。サイトには何も書いていません。',
    'steps-too-large': '始めませんでした：Skill の手順（SKILL.md と site-notes.md）が長すぎて、全部を係の AI に渡せません。サイトには何も書いていません。管理者に手順を短くしてもらってください。',
    'steps-missing': '始めませんでした：この PC に Skill の手順（SKILL.md・site-notes.md）がありません（その部署のフォルダをダウンロードしていないなど）。サイトには何も書いていません。',
    'steps-changed': '始めませんでした：この PC の Skill の手順が、会社で承認された版と違います（同期していない、手元で直したなど）。サイトには何も書いていません。同期してから、もう一度頼んでください。',
  } satisfies Record<WorkStopReason, string>,
  stoppedFooter: 'ユーザーにカードを見て、サイトの画面で確かめてもらってください。',
  /**
   * In place of the footer when the card asks the member to decide (its question is never in these words). Only said for a
   * run that wrote nothing (`workStopNext`): a new request starts that work over from the site's own state.
   */
  askedFooter: 'この作業では、サイトにまだ何も書いていません。カードに、人に決めてほしいことと［そのまま進める］［やめる］を出しました。ユーザーの返事を待ってください。ユーザーが［そのまま進める］を押すと、決まった言葉とカードの番号（bo_… か bf_…）が届きます。そのときは同じ頼みをもう一度、decision にそのカードの番号を入れて頼んでください。［やめる］なら、続けないでください。',
  /** A `decision` that names no stopped card the member answered here (or one already used, or of another site or Skill). */
  badDecision: 'decision のカードの番号は、ユーザーが［そのまま進める］を押したカードのものではありません（もう使った、別のサイトや Skill のもの、時間が過ぎたなど）。何もしていません。ユーザーにカードで答えてもらうか、新しく頼み直してください。',
  unread: (headings: readonly string[]) => `読めなかったもの：${headings.map(h => `「${h}」`).join('、')}`,
} as const
const WW = BROWSER_WORK_WORDS

/**
 * The consultation AI's words for a write run: fixed sentences and headings the company or the chat AI itself wrote —
 * the chat AI's own `items` by number, and the Skill's `after_read` patterns that could not be read (company-reviewed text,
 * shown as written) — never anything of the page, nor the operator's question (`asked` only says the card asks one).
 */
export function workWordsForAi(end: WorkEnd, items: readonly string[], unread: readonly number[], unreadAddresses: readonly string[] = [], asked = false): string {
  const headings = [...unread.map(n => items[n - 1]).filter((h): h is string => typeof h === 'string'), ...unreadAddresses]
  const doneWords = end.kind === 'done' ? (end.business === 'matched' ? WW.done : end.business === 'differs' ? WW.doneDiffers : WW.doneUnconfirmed) : ''
  const lines = end.kind === 'done' ? [doneWords] : end.kind === 'unknown' ? [WW.unknown] : [WW.stoppedBy[end.why], asked ? WW.askedFooter : WW.stoppedFooter]
  if (headings.length > 0) lines.push(WW.unread(headings))
  return lines.join('\n')
}

/** A busy refusal's words: with the server's `freeAt` (the latest the holder can keep the domain) as whole minutes from now. */
export function workBusyWords(freeAt: string | undefined, now: number): string {
  const at = freeAt === undefined ? Number.NaN : Date.parse(freeAt)
  if (!Number.isFinite(at)) return WW.busy
  return WW.busyFor(Math.max(1, Math.ceil((at - now) / 60_000)))
}

/** A heading the chat AI may hand in (its own words; echoed back only by number). */
export const workHeading = browseHeading

// ── The member's cards ──────────────────────────────────────────────────────────────────────────────────────────────

export const BROWSER_WORK_CARD_WORDS = {
  title: 'ブラウザ操作：AI が書く作業',
  plan: 'これからすること（AI が下見して書いたものです）',
  affects: (s: string) => `ほかに影響する人・もの：${s}`,
  frame: (f: WorkFrame) => `書く先：${browserSkillWriteLine(frameWrite(f))}`,
  resultTitle: 'AI がサイトで書いたこと',
  writes: '書いたこと',
  writeOutcome: {
    done: `サイトが成功を返しました（${BROWSER_CARD_CHECKED_BY_WORDS.machine}）`,
    'not-sent': '送っていません',
    unknown: `届いたか分かりません（${BROWSER_CARD_CHECKED_BY_WORDS.none}）`,
    refused: '計画の枠に合わないので止めました（送っていません）',
    'site-refused': 'サイトがエラーを返しました（保存されたかは確かめていません）',
  } satisfies Record<BrowserRunWriteOutcome, string>,
  /**
   * A refused write: the site's error alone (`unconfirmed`), or read again and found unchanged (`unchanged`: only then "not
   * saved"; agent-browser.md "Sent is not done").
   */
  siteRefusedStatus: (status: number, refusal: 'unchanged' | 'unconfirmed' = 'unconfirmed') => (refusal === 'unchanged'
    ? `サイトが「${status}」を返しました。読み直して変わっていないことを確かめました（保存されていません）`
    : `サイトが「${status}」を返しました。保存されたかどうかは確かめられていません`),
  failedStatus: (status: number) => `サイトが「${status}」を返しました。届いたかどうか、変わったかどうかは分かりません（${BROWSER_CARD_CHECKED_BY_WORDS.none}）`,
  reread: (address: string) => `読み直し：${address}`,
  created: 'なし（この作業で作ったもの）',
  // Who checked each row is its own mark (`BROWSER_CARD_CHECKED_BY_WORDS`) and the card's one folded line
  // (`BROWSER_INSPECTION_CARD_WORDS.checkedBy`): the headings no longer repeat it (owner 2026-11-27).
  aiChecks: 'ブラウザ操作の係の AI が確かめたこと',
  summary: 'ブラウザ操作の係の AI のまとめ（係の AI がページを読んで書いたもので、確かめた事実ではありません。相談の AI には渡していません）',
  done: '済みました。読み直して、約束した値と送った値になっていることを確かめました。',
  doneUnconfirmed: '送りました（サイトは受け付けました）。済んだかは、読み直して確かめられませんでした。サイトの画面で確かめてください。',
  doneDiffers: '送りました（サイトは受け付けました）が、読み直すと違う項目があります。サイトの画面で確かめてください。',
  /** The row of a value the run promised (the person's own, or approved on a card). */
  promised: '約束した値',
  promisedDiffers: '約束した値と、読み直した値が違う項目があります。サイトの画面で確かめてください。',
  /** The card asks before a write outside the run's promise is sent (agent-browser.md "The run's promise"). */
  askHeadline: 'この書き込みは、この作業の約束にないものを含みます。書いてよいか確かめてください（答えるまで送りません）。',
  askField: (name: string) => `約束にない項目「${name}」も送ります`,
  askTarget: (segment: string) => `書く先「${segment}」は、この作業で作ったものでも、頼みの値でもありません`,
  askValue: (name: string, value: string) => `項目「${name}」に「${value}」を入れます（この作業で約束した値がありません）`,
  askAllow: '書いてよい',
  askDeny: '書かない',
  askGone: '答えを受け取れませんでした（作業が終わったか、時間が過ぎました）。',
  unknown: '分からない書き込みがあります。もう一度は送りません。下の「手でやること」を見て、サイトの画面で確かめてください。',
  /** After a stop's fixed reason: what the card then shows (nothing sent at all, or the sent and not sent apart). */
  stoppedNothingSent: 'サイトには何も書いていません。',
  stoppedSplit: '送ったものと送っていないものを下に分けています。',
  compare: (name: string) => `「${name}」と違う項目があります。意図した変更か確かめてください。`,
  sentDiffers: '送った値と、読み直した値が違う項目があります。サイトの画面で確かめてください。',
  byHand: (line: string) => `サイトの画面で、次の書き込みが入っているか確かめてください：${line}。アプリはもう一度は送りません。`,
  confirmNotNow: 'この書き込みについては、いま答えられません。',
  confirmTooEarly: 'まだ送られるかもしれないため、少し待ってから押してください。',
  confirmFailed: '答えを送れませんでした。少し待ってから、もう一度押してください。',
  confirmedDone: '「済んでいた」と答えました。アプリはもう一度は送りません。',
  confirmedNotDone: '「されていなかった」と答えました。アプリは自動では送り直しません。続けるときは、相談で頼み直してください。',
  lateDone: 'あとからサイトの答えが届き、済んでいました。アプリはもう一度は送りません。',
  lateRefused: 'あとからサイトの答えが届き、受け付けられていませんでした（保存されていません）。続けるときは、相談で頼み直してください。',
  confirmSettledElsewhere: 'この書き込みは、もう答えが記録されています。サイトの画面で確かめてください。',
  /** The write ledger: an earlier write in doubt, asked before this request writes anything. */
  earlierDoubt: '前回の結果が分からない書き込みがあります。サイトの画面で確かめて、下で答えてください。答えるまで、この作業はサイトに書きません。',
  /** The app read the address again and found what the write sent: machine-checked, so the person is not asked. */
  readBackDone: '読み直したところ、送った値になっていました（機械で確かめた）。済んでいたとして記録しました。アプリはもう一度は送りません。',
  defaultCompared: '比べ元',
  previewTitle: 'ブラウザ操作：AI が書く作業の下見',
  previewStopped: '下見の途中で止まりました。サイトには何も書いていません。',
} as const

/**
 * The card of a write task's preview that ended without a plan (incident 2026-11-27: a `need-person` stop left the member
 * nothing to look at): the fixed reason once and that nothing was written (owner 2026-11-27: the reason said three times —
 * the headline, a note and the memo — was 「最悪の UX」). What to decide is the view's `next`, drawn above it; what the
 * operator tried is the view's folded trail.
 */
export function workPreviewStoppedCard(end: WorkEnd): BrowserCard {
  return {
    title: BROWSER_WORK_CARD_WORDS.previewTitle,
    state: 'not_read',
    headline: end.kind === 'stopped' ? `${BROWSER_WORK_WORDS.stoppedBy[end.why]}${BROWSER_WORK_CARD_WORDS.stoppedNothingSent}` : BROWSER_WORK_CARD_WORDS.previewStopped,
    sections: [],
    checks: [],
    notes: [],
  }
}
const CW = BROWSER_WORK_CARD_WORDS

/**
 * What a stopped write task's card asks of the member first (agent-browser.md "The stopped card asks one thing"): the
 * operator's question for its own `need-person` stop (`decide`), the window for a `need-login` stop (`login`), else
 * nothing. Only the operator's own stop words ask: the app's stops (a refused write, the time, a button…) never do —
 * a `need-person` turned into `refused` by `workEndAfterRefusals` asks nothing.
 *
 * `held`: how many page writes this run held. The answers start the work over as a new run (Codex review): the once-rules
 * hold within a run, not across runs, so after any write the card shows the question without them (`question`) and the
 * member asks again in their own words, having seen what was written.
 */
export function workStopNext(end: WorkEnd, question: string | null, held = 0): BrowserStopNext | null {
  if (end.kind !== 'stopped') return null
  if (end.why === 'need-login') return { kind: 'login' }
  const q = end.why === 'need-person' ? stopQuestion(question) : null
  if (q === null) return null
  return held === 0 ? { kind: 'decide', question: q } : { kind: 'question', question: q }
}

/** The plan card's sentences: what will be done, who else is affected, each frame with its count. */
export function workPlanSentences(input: { summary: string; affects: string; frames: readonly WorkFrame[] }): string[] {
  return [input.summary, ...(input.affects.trim() ? [CW.affects(input.affects)] : []), ...input.frames.map(CW.frame)]
}

/** One after-read address on the card: what it was before (null: not read; 'created': new), what it is now (null: not read), what was sent. */
export interface AfterReadResult {
  pattern: string
  before: Array<[string, string]> | null | 'created'
  after: Array<[string, string]> | null
  sent: Record<string, string> | null
  /** The values the run promised for that write's bound fields (agent-browser.md "The run's promise"); null: none. */
  promised?: Record<string, string> | null
  /** Which done write (its place among them) the address came from; null / absent: none. */
  from?: number | null
}

/**
 * What reading back says of the run (agent-browser.md "Sent is not done"): `matched` only when every done write (`done`:
 * how many) was read again at an address that came from it, every value compared there — promised, else sent — reads as
 * it should, and nothing promised was missing; `differs` when anything compared reads otherwise; else `unconfirmed`
 * (nothing written, nothing read, a write no address came from, a promised field not shown, nothing to compare).
 */
export function workBusinessOf(done: number, reads: readonly AfterReadResult[]): WorkBusiness {
  let differs = false
  let short = done === 0
  for (let i = 0; i < done; i++) {
    const mine = reads.filter(r => r.from === i && r.after)
    if (mine.length === 0) { short = true; continue }
    for (const r of mine) {
      const s = afterReadSection(r)
      if (s.differs.length > 0) differs = true
      if (s.unconfirmed.length > 0 || s.compared === 0) short = true
    }
  }
  return differs ? 'differs' : short ? 'unconfirmed' : 'matched'
}

const read = (text: string): BrowserCardValue => ({ status: 'read', text })
const unreadable: BrowserCardValue = { status: 'unreadable' }

/**
 * An after-read section: each field before → after, checked by the machine against the value the run **promised** for it
 * (a bound field) or else the value the write sent (bug 1: both sides shown). `differs`: fields read otherwise;
 * `promisedDiffers`: of them, the promised ones; `unconfirmed`: a promised field the read did not show.
 */
export function afterReadSection(r: AfterReadResult): { section: BrowserCardSection; differs: string[]; promisedDiffers: string[]; unconfirmed: string[]; compared: number } {
  if (!r.after) return { section: { heading: CW.reread(r.pattern), rows: [{ label: r.pattern, value: unreadable }] }, differs: [], promisedDiffers: [], unconfirmed: [], compared: 0 }
  const before = r.before === 'created' || r.before === null ? null : new Map(r.before)
  const differs: string[] = []
  const promisedDiffers: string[] = []
  let compared = 0
  const has = (o: Record<string, string> | null | undefined, k: string): o is Record<string, string> => !!o && Object.prototype.hasOwnProperty.call(o, k)
  const rows: BrowserCardRow[] = r.after.map(([k, now]) => {
    const was: BrowserCardValue = r.before === 'created' ? read(CW.created) : before?.has(k) ? read(before.get(k) as string) : unreadable
    const want = has(r.promised, k) ? r.promised[k] : has(r.sent, k) ? r.sent[k] : null
    if (want !== null) {
      compared++
      const ok = want === now
      if (!ok) { differs.push(k); if (has(r.promised, k)) promisedDiffers.push(k) }
      return { label: k, before: was, after: read(now), compared: read(want), by: 'machine', mark: ok ? 'ok' : 'ng' }
    }
    return { label: k, before: was, after: read(now), by: 'none' }
  })
  const shown = new Set(r.after.map(([k]) => k))
  const unconfirmed = Object.keys(r.promised ?? {}).filter(k => !shown.has(k))
  return { section: { heading: CW.reread(r.pattern), rows }, differs, promisedDiffers, unconfirmed, compared }
}

export interface WorkCardInput {
  end: WorkEnd
  summary: string | null
  writes: ReadonlyArray<{ line: string; outcome: BrowserRunWriteOutcome; status: number | null; refusal?: 'unchanged' | 'unconfirmed' }>
  afterReads: readonly AfterReadResult[]
  checks: readonly WorkCheck[]
  comparedName: string | null
}

/**
 * The after-read card (design memo §6-1 step 5): the writes and what became of each, each after-read address before → after
 * (compared with what was sent: 機械で確かめた), the operator's checks before → after → compared-to (AI が確かめた), the
 * operator's summary. A ✗ of the operator's comparison says bug 4's soft words with the Skill's name for what it compares to.
 * Every value here is the member's only (main's memory; never the consultation AI).
 */
export function workResultCard(input: WorkCardInput): BrowserCard {
  const sections: BrowserCardSection[] = []
  const checks: BrowserCardCheck[] = []
  if (input.writes.length > 0) {
    sections.push({
      heading: CW.writes,
      rows: input.writes.map((w, i) => ({
        label: `${i + 1}. ${w.line}`,
        value: read(w.status === null ? CW.writeOutcome[w.outcome]
          : w.outcome === 'unknown' ? CW.failedStatus(w.status) : w.outcome === 'site-refused' ? CW.siteRefusedStatus(w.status, w.refusal) : CW.writeOutcome[w.outcome]),
      })),
    })
  }
  const machineDiffers: string[] = []
  const promisedDiffers: string[] = []
  for (const r of input.afterReads) {
    const read = afterReadSection(r)
    sections.push(read.section)
    machineDiffers.push(...read.differs.filter(k => !read.promisedDiffers.includes(k)))
    promisedDiffers.push(...read.promisedDiffers)
  }
  if (promisedDiffers.length > 0) checks.push({ label: CW.promisedDiffers, mark: 'ng', fields: promisedDiffers })
  if (machineDiffers.length > 0) checks.push({ label: CW.sentDiffers, mark: 'ng', fields: machineDiffers })
  if (input.checks.length > 0) {
    sections.push({
      heading: CW.aiChecks,
      rows: input.checks.map(c => ({
        label: c.item, before: c.before !== null ? read(c.before) : unreadable, after: read(c.after),
        ...(c.compared !== null ? { compared: read(c.compared) } : {}), by: 'ai' as const, mark: c.ok ? 'ok' as const : 'ng' as const,
      })),
    })
    const ng = input.checks.filter(c => !c.ok)
    if (ng.length > 0) checks.push({ label: CW.compare(input.comparedName ?? CW.defaultCompared), mark: 'ng', fields: ng.map(c => c.item) })
  }
  // The operator's summary: only when it finished (`done`). A stop has none, and an empty 「読み取れませんでした」 row there
  // told the member nothing (owner 2026-11-27); a `done` without words still says it could not be read.
  if (input.summary !== null) sections.push({ heading: CW.summary, rows: [{ label: '', value: input.summary ? read(input.summary) : unreadable }] })
  const unknown = input.writes.filter(w => w.outcome === 'unknown')
  // "The site answered success" is not "done" (agent-browser.md "Sent is not done"): the card is all ✓ only when reading back
  // matched what the run promised and sent; a run nothing could be compared for is not ✓ (Codex review point 8).
  const business = input.end.kind === 'done' ? input.end.business ?? 'unconfirmed' : null
  const state: BrowserCard['state'] = input.end.kind !== 'done' ? 'not_read' : checks.length > 0 || business === 'differs' ? 'ng' : business === 'matched' ? 'all_ok' : 'not_read'
  return {
    title: CW.resultTitle,
    state,
    // A stop: its fixed reason once, then whether anything was sent at all (no write held: nothing reached the site).
    headline: input.end.kind === 'done' ? (business === 'matched' ? CW.done : business === 'differs' ? CW.doneDiffers : CW.doneUnconfirmed) : input.end.kind === 'unknown' ? CW.unknown
      : `${WW.stoppedBy[input.end.why]}${input.writes.length === 0 ? CW.stoppedNothingSent : CW.stoppedSplit}`,
    sections,
    checks,
    notes: unknown.map(w => CW.byHand(w.line)),
  }
}

/**
 * A frame's write line for the card (the method, the path as the page sent it is never shown: only the frame's pattern; a
 * query value placeholder in plain words, `browserSkillQueryWords`). A write outside every frame: `workRefusedWriteLine`.
 */
export const workWriteLine = (method: string, framePath: string | null, frameQuery: string | null = null): string =>
  `${method} ${framePath === null ? '（枠の外）' : frameQuery === null ? framePath : `${framePath}?${browserSkillQueryWords(frameQuery)}`}`

/**
 * The card's line of a held write refused as outside every frame (incident 2026-11-27: 「POST（枠の外）」 told nobody what
 * the page had sent): the address in the recording's kept form (`browserRunAddressPattern`: digits `{n}`, other words
 * `{x}`, query names only — never a value), a name that carried a value shown as `name=…`. Another host or an address
 * that cannot be read: the bare 「（枠の外）」 as before.
 */
export function workRefusedWriteLine(method: string, url: string, host: string): string {
  const pattern = browserRunAddressPattern(url, host)
  if (pattern === null) return workWriteLine(method, null)
  const at = pattern.indexOf('?')
  if (at === -1) return `${method} ${pattern}（枠の外）`
  const valued = new Set<string>()
  try {
    for (const [k, v] of new URL(url).searchParams) if (v !== '') valued.add(k)
  } catch { /* the pattern was read from it: never here */ }
  const names = pattern.slice(at + 1).split('&').map(k => (valued.has(k) ? `${k}=…` : k))
  return `${method} ${pattern.slice(0, at)}?${names.join('&')}（枠の外）`
}

/**
 * Why a write run stopped, as the AI and the card say it: a held write refused as outside the frames comes first when the
 * operator then stopped on its own word (`blocked`, `need-person`, `not-found` — what the refusal led to), so the person
 * hears 「承認した範囲に合わなかった」 rather than 「画面が先に進めませんでした」 (incident 2026-11-27). The app's own stops (a
 * button, the time, the network…), `done` and `unknown` are kept as they are.
 */
export function workEndAfterRefusals(end: WorkEnd, outcomes: readonly BrowserRunWriteOutcome[]): WorkEnd {
  if (end.kind !== 'stopped' || !outcomes.includes('refused')) return end
  return end.why === 'blocked' || end.why === 'need-person' || end.why === 'not-found' ? { kind: 'stopped', why: 'refused' } : end
}
