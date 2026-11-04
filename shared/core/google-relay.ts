/**
 * The Google relay with the member's own permission (「本人の許可で中継する」, owner decision
 * 2026-11-04, `.claude/rules/google-connector.md` "The relay"): a script on the member's PC calls
 * `$ACB_GOOGLE_BASE_URL/sheets/v4/spreadsheets/…` with a short-lived broker token; ACB checks the
 * token and sends the call to Google with that member's own Google permission — never a stored
 * company key or a service account.
 *
 * This module is the one copy of what may pass (server: the relay; admin and app: the words of the
 * records). Pure: imports nothing outside shared/core.
 *
 * - **No per-file designation**: any spreadsheet the member can edit; Google refuses the rest.
 * - **Never a deletion**: `values:clear`, `values:batchClear(ByDataFilter)` and a
 *   `spreadsheets:batchUpdate` with any `delete…` / `clear…` request are refused before anything
 *   leaves ACB; other batchUpdate request kinds pass only when listed in
 *   `SHEETS_BATCH_UPDATE_ALLOWED` (an unknown kind is refused, not guessed).
 * - Only the Sheets API's calls listed in `parseSheetsCall` (spreadsheets.get, values get /
 *   batchGet / update / batchUpdate / append, spreadsheets.batchUpdate), and only the query
 *   parameters in `SHEETS_QUERY_ALLOWED`.
 */

/** The Google services the relay may pass (this PR: Sheets only). The path's first segment names one. */
export const GOOGLE_RELAY_SERVICES = ['sheets'] as const
export type GoogleRelayService = typeof GOOGLE_RELAY_SERVICES[number]

/** Shown to the admin as 「あとから足せるもの」: not relayed until their own rules exist. */
export const GOOGLE_RELAY_LATER = ['drive', 'calendar', 'docs', 'slides'] as const
export type GoogleRelayLaterService = typeof GOOGLE_RELAY_LATER[number]

export function isGoogleRelayService(v: unknown): v is GoogleRelayService {
  return typeof v === 'string' && (GOOGLE_RELAY_SERVICES as readonly string[]).includes(v)
}

/** The member's daily calls (all relay services together): default 500, the admin may set 1–10000. */
export const GOOGLE_RELAY_CAP = { default: 500, min: 1, max: 10_000 } as const

export function isGoogleRelayCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= GOOGLE_RELAY_CAP.min && v <= GOOGLE_RELAY_CAP.max
}

/** The Sheets calls the relay passes. */
export const SHEETS_OPERATIONS = [
  'spreadsheets.get', 'values.get', 'values.batchGet', 'values.update', 'values.batchUpdate', 'values.append', 'spreadsheets.batchUpdate',
] as const
export type SheetsOperation = typeof SHEETS_OPERATIONS[number]

/** What each call does, in the member's words (the records). */
export const SHEETS_OPERATION_TEXT: Record<SheetsOperation, string> = {
  'spreadsheets.get': '表の情報を読む',
  'values.get': '読む',
  'values.batchGet': 'まとめて読む',
  'values.update': '書き換える',
  'values.batchUpdate': 'まとめて書き換える',
  'values.append': '行を足す',
  'spreadsheets.batchUpdate': '行・列を足す、整える',
}

/**
 * `spreadsheets:batchUpdate` request kinds that pass: adding rows / columns / cells / sheets,
 * sizing, borders, unmerging, and `copyPaste` with `pasteType: PASTE_FORMULA` only (anken-sync's
 * write_keisu.py copies the formula columns into a row it inserted). Anything else is refused — a
 * `delete…` / `clear…` kind as a deletion, any other kind as "not relayed". Left out on purpose
 * because they can wipe what is there like a deletion (review of #580): `updateCells` (`fields: *`
 * without rows clears a range), `repeatCell` (an empty cell repeated), `mergeCells` (drops every
 * value but the top-left), `updateSheetProperties` (a smaller `gridProperties.rowCount` /
 * `columnCount` deletes rows / columns), `copyPaste` of values or everything, `cutPaste`,
 * `sortRange`, `findReplace`. Writing values (`values.update`, also empty strings) stays an edit.
 * Request kinds are matched as Google names them (camelCase); a snake_case kind is unlisted.
 */
export const SHEETS_BATCH_UPDATE_ALLOWED: readonly string[] = [
  'insertDimension', 'insertRange', 'appendDimension', 'appendCells', 'addSheet',
  'autoResizeDimensions', 'updateDimensionProperties', 'updateBorders', 'unmergeCells', 'copyPaste',
]

/** Google's JSON accepts both `pasteType` and `paste_type`: compare field names in one form. */
const fieldKey = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/** `copyPaste` passes only as a formula copy (exactly one paste type field, PASTE_FORMULA). */
function copyPasteAllowed(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const types = Object.entries(v as Record<string, unknown>).filter(([k]) => fieldKey(k) === 'pasteType')
  return types.length === 1 && types[0][1] === 'PASTE_FORMULA'
}

/** Query parameters the relay passes on (Google's documented ones for these calls); any other is refused. */
export const SHEETS_QUERY_ALLOWED: readonly string[] = [
  'ranges', 'majorDimension', 'valueRenderOption', 'dateTimeRenderOption', 'valueInputOption', 'insertDataOption',
  'includeValuesInResponse', 'responseValueRenderOption', 'responseDateTimeRenderOption', 'includeGridData',
  'excludeTablesInBandedRanges', 'fields', 'prettyPrint',
]

/**
 * Refused calls of one member per day that are recorded (a looping AI would otherwise fill the
 * action log, since refusals do not count against the cap). Later refusals that day are still
 * refused, but not recorded; calls that pass are always recorded.
 */
export const GOOGLE_RELAY_REFUSALS_PER_DAY = 200

/** At most this many requests in one batchUpdate (Google allows more; a script's batch is small). */
export const SHEETS_BATCH_LIMIT = 500

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{1,200}$/

export interface SheetsCall {
  operation: SheetsOperation
  spreadsheetId: string
  /** The A1 range of a values call (`'案件'!A1:K220`), null otherwise. */
  range: string | null
  write: boolean
}

export type SheetsRefusal =
  /** A clear or delete: never relayed. */
  | 'deletion'
  /** A call or request kind the relay does not pass. */
  | 'not-relayed'

/**
 * One Sheets call from its method and decoded path on sheets.googleapis.com
 * (`/v4/spreadsheets/<id>/values/<range>:append`), or why it is refused. The body of a
 * `spreadsheets.batchUpdate` is checked separately (`checkSheetsBatchUpdate`).
 */
export function parseSheetsCall(method: string, path: string): { ok: true; call: SheetsCall } | { ok: false; refusal: SheetsRefusal; spreadsheetId: string | null } {
  const seg = path.split('/')
  if (seg[0] !== '' || seg[1] !== 'v4' || seg[2] !== 'spreadsheets' || seg.length < 4 || seg.length > 6) {
    return { ok: false, refusal: 'not-relayed', spreadsheetId: null }
  }
  const head = seg[3]
  const colon = head.indexOf(':')
  const id = colon < 0 ? head : head.slice(0, colon)
  const verb = colon < 0 ? null : head.slice(colon + 1)
  if (!SPREADSHEET_ID.test(id)) return { ok: false, refusal: 'not-relayed', spreadsheetId: null }
  const not = (refusal: SheetsRefusal = 'not-relayed') => ({ ok: false as const, refusal, spreadsheetId: id })
  const call = (operation: SheetsOperation, range: string | null = null) => ({
    ok: true as const,
    call: { operation, spreadsheetId: id, range, write: !['spreadsheets.get', 'values.get', 'values.batchGet'].includes(operation) },
  })
  if (seg.length === 4) {
    if (verb === null) return method === 'GET' ? call('spreadsheets.get') : not()
    if (verb === 'batchUpdate') return method === 'POST' ? call('spreadsheets.batchUpdate') : not()
    return not()
  }
  if (verb !== null) return not()
  const sub = seg[4]
  if (seg.length === 5) {
    if (sub === 'values:batchGet') return method === 'GET' ? call('values.batchGet') : not()
    if (sub === 'values:batchUpdate') return method === 'POST' ? call('values.batchUpdate') : not()
    if (/^values:batchClear/.test(sub)) return not('deletion')
    return not()
  }
  // /v4/spreadsheets/<id>/values/<range>[:append | :clear]
  if (sub !== 'values') return not()
  const tail = seg[5]
  if (tail === '') return not()
  if (method === 'POST') {
    if (tail.endsWith(':append') && tail.length > ':append'.length) return call('values.append', tail.slice(0, -':append'.length))
    if (tail.endsWith(':clear')) return not('deletion')
    return not()
  }
  if (method === 'GET') return call('values.get', tail)
  if (method === 'PUT') return call('values.update', tail)
  return not()
}

/**
 * The `requests` of a `spreadsheets:batchUpdate` body: refused when any of them deletes or
 * clears, or is a kind not in `SHEETS_BATCH_UPDATE_ALLOWED`; `kinds` names them (for the record,
 * never their content).
 */
export function checkSheetsBatchUpdate(body: unknown): { ok: true; kinds: string[] } | { ok: false; refusal: SheetsRefusal | 'bad-body'; kinds: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, refusal: 'bad-body', kinds: [] }
  const requests = (body as { requests?: unknown }).requests
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > SHEETS_BATCH_LIMIT) return { ok: false, refusal: 'bad-body', kinds: [] }
  const kinds: string[] = []
  for (const r of requests) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, refusal: 'bad-body', kinds }
    const keys = Object.keys(r)
    // Google reads one kind per request; more than one would hide a kind behind another.
    if (keys.length !== 1) return { ok: false, refusal: 'bad-body', kinds }
    kinds.push(keys[0])
  }
  const named = [...new Set(kinds)].map(k => k.slice(0, 40))
  if (kinds.some(k => /^(delete|clear)/i.test(k))) return { ok: false, refusal: 'deletion', kinds: named }
  if (kinds.some(k => !SHEETS_BATCH_UPDATE_ALLOWED.includes(k))) return { ok: false, refusal: 'not-relayed', kinds: named }
  if (requests.some(r => 'copyPaste' in (r as object) && !copyPasteAllowed((r as { copyPaste: unknown }).copyPaste))) {
    return { ok: false, refusal: 'not-relayed', kinds: named }
  }
  return { ok: true, kinds: named }
}

/**
 * The query of a Sheets call, as passed on: `key` (where a script may have put the token) is
 * dropped; any parameter not in `SHEETS_QUERY_ALLOWED` (e.g. `access_token`) refuses the call.
 */
export function sheetsQuery(query: URLSearchParams): { ok: true; query: Record<string, string[]> } | { ok: false; name: string } {
  const out: Record<string, string[]> = {}
  for (const [name, value] of query) {
    if (name === 'key') continue
    if (!SHEETS_QUERY_ALLOWED.includes(name)) return { ok: false, name: name.slice(0, 40) }
    ;(out[name] ??= []).push(value)
  }
  return { ok: true, query: out }
}

/**
 * The spreadsheet id and A1 range named by a recorded path (`/v4/spreadsheets/<id>/values/<range>:append`),
 * for the records' words; nulls when the path names none.
 */
export function sheetsPathParts(path: string): { spreadsheetId: string | null; range: string | null } {
  const seg = path.split('/')
  if (seg[1] !== 'v4' || seg[2] !== 'spreadsheets' || !seg[3]) return { spreadsheetId: null, range: null }
  const id = seg[3].split(':')[0]
  const spreadsheetId = SPREADSHEET_ID.test(id) ? id : null
  const range = seg[4] === 'values' && seg[5] ? seg[5].replace(/:(append|clear)$/, '') : null
  return { spreadsheetId, range }
}
