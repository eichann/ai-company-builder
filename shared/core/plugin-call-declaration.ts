/**
 * Contract 3's part of `plugin.yaml` (plugins.md "Contract 3"): a connector's
 * `calls`, how it is called and what the outside tells, and a business plugin's
 * use of them. Declaration only — nothing here runs yet.
 *
 * ```yaml
 * contract: 3
 * auth: { type: company_key, header: authorization, format: bearer, slots: [read, act] }
 * account_info: { method: GET, path: /account, id_field: account_id }
 * actor: { member_header: X-Sample-Actor, email_header: X-Sample-Email }
 * limits: { per_minute: 60 }
 * errors: { field: code, map: { STATE_CHANGED: check_wait } }
 * result: { path: "/operations/{operation_id}", status_field: status, map: { done: applied } }
 * calls:
 *   diagnose:
 *     label: 状態を調べる
 *     kind: read
 *     path: "/people/{person_ref}/diagnosis"
 *     inputs: { person_ref: { kind: id, class: personal } }
 *     returns: { name: { class: personal, keep: summary, outside: true } }
 * events:
 *   recovered: { fields: { person_ref: { class: personal, keep: pointer } } }
 * ```
 *
 * The declaration does not grow into a language (owner rule §8-1): every value
 * is one of a closed list or a plain name; there is no condition, computation
 * or transformation, and `{name}` is only ever a whole path segment.
 */
import {
  CALL_ACTORS, CALL_AUTH_FORMATS, CALL_AUTH_SLOTS, CALL_FAILURE_KINDS, CALL_IDEMPOTENCY_STYLES, CALL_INPUT_KINDS, CALL_NATURES, CALL_RESULT_STATES,
  CALL_SIGNATURE_SCHEMES, DATA_CLASSES, KEEP_RULES, ROLE_WHO_PREFIX,
  type CallUse, type EventUse, type PluginCall, type PluginCallInput, type PluginCallListing, type PluginCallRequest, type PluginCalling, type PluginCursor,
  type PluginDataField, type PluginEvent, type PluginManifest, type PluginPoll,
} from './plugin-declaration'
import { EXTERNAL_NAME_RE, isStr, strList, unknownKeys } from './plugin-declaration-rules'
import { settingDurationMinutes } from './plugin-settings'
import { ONTOLOGY_NAME_RE } from './record-types'
import { checkUpstreamPath } from './upstream-path'
import { isYamlMap, type YamlValue } from './yaml-lite'

type Raw = { [k: string]: YamlValue }
type Err = (m: string) => void

/** Top-level keys only a contract-3 connector may write. */
export const CONNECTOR_V3_KEYS: readonly string[] = ['auth', 'actor', 'limits', 'errors', 'result', 'calls', 'events', 'signature', 'polls']
/** Top-level keys only a contract-3 business plugin may write. */
export const BUSINESS_V3_KEYS: readonly string[] = ['calls', 'events']

const CALL_PATH_RE = /^[A-Za-z0-9/_.{}-]{1,300}$/
const PLACEHOLDER_RE = /^\{([a-z][a-z0-9_]{0,39})\}$/
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const RETURN_SEGMENT_RE = /^(?:[A-Za-z0-9_-]{1,64}|\{[a-z][a-z0-9_]{0,39}\})$/
const RETURN_MAX_DEPTH = 6
const PER_MINUTE_MAX = 600
const SIGNATURE_MAX_AGE_MINUTES = 60
const POLL_EVERY_MAX_MINUTES = 1440
/** Headers the core's way out owns: a declaration naming one could change where or how a request goes. */
const RESERVED_HEADERS: readonly string[] = [
  'host', 'connection', 'keep-alive', 'content-length', 'content-type', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'cookie', 'set-cookie',
  'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-http-method', 'x-http-method-override', 'x-method-override',
]
/** The idempotency style `header` sends this one; no other header may take its place. */
const IDEMPOTENCY_HEADER = 'idempotency-key'

const inList = <T extends string>(v: YamlValue | undefined, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)
const plainName = (v: YamlValue | undefined): v is string => typeof v === 'string' && EXTERNAL_NAME_RE.test(v)

/**
 * A call's path template: the relay's path rule, and `{name}` placeholders each
 * a whole segment, none twice. Relaxes the fixed calls' `{id}`-only rule
 * (`checkPluginPathTemplate`) for `calls`, `result` and nothing else.
 */
export function callPathPlaceholders(path: unknown): { names: string[] } | { problem: string } {
  if (typeof path !== 'string' || !CALL_PATH_RE.test(path)) return { problem: '道は / で始まる英数字・/ _ . - と {名前} だけで書いてください（? や # は使えません）' }
  const names: string[] = []
  for (const segment of path.split('/')) {
    if (!/[{}]/.test(segment)) continue
    const m = PLACEHOLDER_RE.exec(segment)
    if (!m) return { problem: '差し込みは /{名前}/ のように、区切りの間まるごとに書いてください' }
    if (names.includes(m[1])) return { problem: `差し込み {${m[1]}} が2回書かれています` }
    names.push(m[1])
  }
  if (!checkUpstreamPath(path.replace(/\{[a-z0-9_]+\}/g, '1'))) return { problem: '道の書き方が正しくありません（//・..・%2f などは使えません）' }
  return { names }
}

function parseDataField(where: string, v: YamlValue, err: Err, eventOnly: boolean): PluginDataField | null {
  if (!isYamlMap(v)) { err(`${where}は { class, keep } の形で書いてください`); return null }
  unknownKeys(`${where}: `, v, ['class', 'keep', 'outside'], err)
  const { class: dataClass, keep } = v
  const outside = v.outside ?? false
  if (!inList(dataClass, DATA_CLASSES)) { err(`${where}の class は ${DATA_CLASSES.join(' / ')} です`); return null }
  if (!inList(keep, KEEP_RULES)) { err(`${where}の keep は ${KEEP_RULES.join(' / ')} です`); return null }
  if (typeof outside !== 'boolean') { err(`${where}の outside は true か false です`); return null }
  if (eventOnly && dataClass !== 'normal' && keep !== 'pointer') { err(`${where}: 外から届く知らせに書けるのは class: normal か keep: pointer の項目だけです（中身は読みに行きます）`); return null }
  return { dataClass, keep, outside }
}

function parseReturnKey(key: string): boolean {
  const segments = key.split('/')
  return segments.length <= RETURN_MAX_DEPTH && segments.every(s => RETURN_SEGMENT_RE.test(s))
}

/** `returns`: the allow-list of what is taken from an answer. */
function parseReturns(where: string, v: YamlValue | undefined, err: Err): Record<string, PluginDataField> {
  const out: Record<string, PluginDataField> = {}
  if (v === undefined) return out
  if (!isYamlMap(v)) { err(`${where}の returns は「項目: { class, keep }」の形で書いてください`); return out }
  for (const [key, field] of Object.entries(v)) {
    if (!parseReturnKey(key)) { err(`${where}の returns の「${key}」は項目名か、a/{item}/b のような項目の道です`); continue }
    const f = parseDataField(`${where}の returns の「${key}」`, field, err, false)
    if (f) out[key] = f
  }
  return out
}

/** The plain-named fields an event or a poll carries: only normal ones or pointers. */
function parseEventFields(where: string, v: YamlValue | undefined, err: Err): Record<string, PluginDataField> {
  const out: Record<string, PluginDataField> = {}
  if (v === undefined) return out
  if (!isYamlMap(v)) { err(`${where}の fields は「項目: { class, keep }」の形で書いてください`); return out }
  for (const [key, field] of Object.entries(v)) {
    if (!EXTERNAL_NAME_RE.test(key)) { err(`${where}の fields の「${key}」は項目名です`); continue }
    const f = parseDataField(`${where}の fields の「${key}」`, field, err, true)
    if (f) out[key] = f
  }
  return out
}

function parseInputs(where: string, v: YamlValue | undefined, err: Err): Record<string, PluginCallInput> {
  const out: Record<string, PluginCallInput> = {}
  if (v === undefined) return out
  if (!isYamlMap(v)) { err(`${where}の inputs は「名前: { kind, class }」の形で書いてください`); return out }
  for (const [name, input] of Object.entries(v)) {
    const at = `${where}の入力「${name}」`
    if (!ONTOLOGY_NAME_RE.test(name)) { err(`${at}: 名前は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(input)) { err(`${at}は { kind, class } の形で書いてください`); continue }
    unknownKeys(`${at}: `, input, ['kind', 'class', 'required', 'label'], err)
    const required = input.required ?? true
    if (!inList(input.kind, CALL_INPUT_KINDS)) { err(`${at}の kind は ${CALL_INPUT_KINDS.join(' / ')} です`); continue }
    if (!inList(input.class, DATA_CLASSES)) { err(`${at}の class は ${DATA_CLASSES.join(' / ')} です`); continue }
    if (typeof required !== 'boolean') { err(`${at}の required は true か false です`); continue }
    if (input.label !== undefined && !isStr(input.label)) { err(`${at}の label は文字で書いてください`); continue }
    out[name] = { kind: input.kind, dataClass: input.class, required, label: isStr(input.label) ? input.label : null }
  }
  return out
}

/** `path`, `inputs`, `returns`: each placeholder is a required `id` input, so only a plain outside id ever fills a path. */
function parseRequest(where: string, v: Raw, err: Err): PluginCallRequest | null {
  const placeholders = callPathPlaceholders(v.path)
  if ('problem' in placeholders) { err(`${where}: ${placeholders.problem}`); return null }
  const inputs = parseInputs(where, v.inputs, err)
  for (const name of placeholders.names) {
    const input = Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : undefined
    if (!input) err(`${where}: 道の差し込み {${name}} が inputs にありません`)
    else if (input.kind !== 'id' || !input.required) err(`${where}: 道の差し込み {${name}} は kind: id の必須の入力です`)
  }
  return { path: v.path as string, inputs, returns: parseReturns(where, v.returns, err) }
}

function parseCursor(where: string, v: YamlValue | undefined, err: Err): PluginCursor | null {
  if (!isYamlMap(v)) { err(`${where}の cursor は { param, next } の形で書いてください`); return null }
  unknownKeys(`${where}の cursor: `, v, ['param', 'next'], err)
  if (!plainName(v.param) || !plainName(v.next)) { err(`${where}の cursor の param / next は項目名です`); return null }
  return { param: v.param, next: v.next }
}

function parseListing(where: string, v: YamlValue | undefined, err: Err): PluginCallListing | null {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err(`${where}は { path, inputs, returns } の形で書いてください`); return null }
  unknownKeys(`${where}: `, v, ['path', 'inputs', 'returns', 'items', 'cursor'], err)
  const request = parseRequest(where, v, err)
  if (!request) return null
  if (Object.keys(request.returns).length === 0) err(`${where}に returns（受け取る項目）を書いてください`)
  if (v.items !== undefined && !plainName(v.items)) err(`${where}の items は項目名です`)
  return { ...request, items: plainName(v.items) ? v.items : null, cursor: v.cursor === undefined ? null : parseCursor(where, v.cursor, err) }
}

function parseCall(name: string, raw: YamlValue, err: Err): PluginCall | null {
  const where = `呼び出し「${name}」`
  if (!ONTOLOGY_NAME_RE.test(name)) { err(`${where}: 名前は英小文字・数字・_ で書いてください`); return null }
  if (!isYamlMap(raw)) { err(`${where}は { … } の形で書いてください`); return null }
  if (!isStr(raw.label)) err(`${where}に label を書いてください`)
  const base = { label: isStr(raw.label) ? raw.label : name, who: [], decision: false }
  if (raw.kind === 'read') {
    unknownKeys(`${where}: `, raw, ['label', 'kind', 'path', 'inputs', 'returns'], err)
    const request = parseRequest(where, raw, err)
    if (!request) return null
    if (Object.keys(request.returns).length === 0) err(`${where}に returns（受け取る項目）を書いてください`)
    return { ...base, kind: 'read', ...request }
  }
  if (raw.kind === 'act') {
    unknownKeys(`${where}: `, raw, ['label', 'kind', 'nature', 'path', 'inputs', 'returns', 'idempotency', 'undo'], err)
    const request = parseRequest(where, raw, err)
    if (!inList(raw.nature, CALL_NATURES)) { err(`${where}の nature は ${CALL_NATURES.join(' / ')} です`); return null }
    if ((raw.undo ?? 'none') !== 'none') { err(`${where}の undo は none だけです（呼び出しを取り消す道はありません）`); return null }
    const idem = raw.idempotency
    if (!isYamlMap(idem)) { err(`${where}に idempotency（同じ呼び出しが二重にならない仕組み）を書いてください`); return null }
    unknownKeys(`${where}の idempotency: `, idem, ['style'], err)
    if (!inList(idem.style, CALL_IDEMPOTENCY_STYLES)) { err(`${where}の idempotency の style は ${CALL_IDEMPOTENCY_STYLES.join(' / ')} です`); return null }
    return request && { ...base, kind: 'act', ...request, nature: raw.nature, idempotency: { style: idem.style }, undo: 'none' }
  }
  if (raw.kind === 'document') {
    unknownKeys(`${where}: `, raw, ['label', 'kind', 'page', 'list', 'search'], err)
    const rawPage = raw.page
    if (!isYamlMap(rawPage)) { err(`${where}に page（1ページを読む道）を書いてください`); return null }
    unknownKeys(`${where}の page: `, rawPage, ['path', 'inputs', 'returns'], err)
    const page = parseRequest(`${where}の page`, rawPage, err)
    if (page && Object.keys(page.returns).length === 0) err(`${where}の page に returns（受け取る項目）を書いてください`)
    const list = parseListing(`${where}の list`, raw.list, err)
    const search = parseListing(`${where}の search`, raw.search, err)
    return page && { ...base, kind: 'document', page, list, search }
  }
  err(`${where}の kind は read / act / document です`)
  return null
}

/** Why a declared header cannot be used, or null. `taken`: names already used for something else. */
function headerProblem(v: YamlValue | undefined, taken: readonly string[]): string | null {
  if (typeof v !== 'string' || !HEADER_NAME_RE.test(v)) return 'ヘッダーの名前で書いてください'
  const key = v.toLowerCase()
  if (RESERVED_HEADERS.includes(key)) return `「${v}」は本体が決めるヘッダーです`
  if (taken.includes(key)) return `「${v}」はほかの役目に使われています`
  return null
}

function parseAuth(v: YamlValue | undefined, err: Err): PluginCalling['auth'] {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err('auth は { type, header, format, slots } の形で書いてください'); return null }
  unknownKeys('auth: ', v, ['type', 'header', 'format', 'slots'], err)
  if (v.type !== 'company_key') { err('auth の type は company_key です（鍵は「API キー」の金庫に入れます）'); return null }
  const problem = headerProblem(v.header, [IDEMPOTENCY_HEADER])
  if (problem) { err(`auth の header: ${problem}`); return null }
  if (!inList(v.format, CALL_AUTH_FORMATS)) { err(`auth の format は ${CALL_AUTH_FORMATS.join(' / ')} です`); return null }
  const slots = strList(v.slots)
  if (!slots || slots.length === 0 || new Set(slots).size !== slots.length || !slots.every(s => inList(s, CALL_AUTH_SLOTS))) { err(`auth の slots は ${CALL_AUTH_SLOTS.join(' / ')} の並びです（重ねずに 1 つ以上）`); return null }
  return { type: 'company_key', header: v.header as string, format: v.format, slots: slots as Array<typeof CALL_AUTH_SLOTS[number]> }
}

function parseActor(v: YamlValue | undefined, taken: string[], err: Err): PluginCalling['actor'] {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err('actor は { member_header, email_header } の形で書いてください'); return null }
  unknownKeys('actor: ', v, ['member_header', 'email_header'], err)
  const out: Array<string | null> = []
  for (const k of ['member_header', 'email_header']) {
    if (v[k] === undefined) { out.push(null); continue }
    const problem = headerProblem(v[k], taken)
    if (problem) { err(`actor の ${k}: ${problem}`); out.push(null); continue }
    taken.push((v[k] as string).toLowerCase())
    out.push(v[k] as string)
  }
  if (v.member_header === undefined && v.email_header === undefined) err('actor には member_header か email_header を書いてください')
  return { memberHeader: out[0], emailHeader: out[1] }
}

function parseLimits(v: YamlValue | undefined, err: Err): PluginCalling['limits'] {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err('limits は { per_minute } の形で書いてください'); return null }
  unknownKeys('limits: ', v, ['per_minute'], err)
  const n = v.per_minute
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > PER_MINUTE_MAX) { err(`limits の per_minute は 1〜${PER_MINUTE_MAX} の整数です`); return null }
  return { perMinute: n }
}

/** `map: { <outside word>: <one of targets> }`: a table, never a rule. */
function parseWordMap<T extends string>(where: string, v: YamlValue | undefined, targets: readonly T[], err: Err): Record<string, T> | null {
  if (!isYamlMap(v) || Object.keys(v).length === 0) { err(`${where}は「外の言葉: ${targets.join(' / ')}」の形で書いてください`); return null }
  const out: Record<string, T> = {}
  for (const [word, target] of Object.entries(v)) {
    if (!EXTERNAL_NAME_RE.test(word)) err(`${where}の「${word}」は外の言葉（英数字）で書いてください`)
    else if (!inList(target, targets)) err(`${where}の「${word}」は ${targets.join(' / ')} のどれかです`)
    else out[word] = target
  }
  return out
}

function parseErrors(v: YamlValue | undefined, err: Err): PluginCalling['errors'] {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err('errors は { field, map } の形で書いてください'); return null }
  unknownKeys('errors: ', v, ['field', 'map'], err)
  if (!plainName(v.field)) { err('errors の field は項目名です'); return null }
  const map = parseWordMap('errors の map', v.map, CALL_FAILURE_KINDS, err)
  return map && { field: v.field, map }
}

function parseResult(v: YamlValue | undefined, err: Err): PluginCalling['result'] {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err('result は { path, status_field, map } の形で書いてください'); return null }
  unknownKeys('result: ', v, ['path', 'status_field', 'map'], err)
  const placeholders = callPathPlaceholders(v.path)
  if ('problem' in placeholders) { err(`result: ${placeholders.problem}`); return null }
  if (placeholders.names.length !== 1 || placeholders.names[0] !== 'operation_id') { err('result の道には {operation_id} をちょうど1つ書いてください'); return null }
  if (!plainName(v.status_field)) { err('result の status_field は項目名です'); return null }
  const map = parseWordMap('result の map', v.map, CALL_RESULT_STATES, err)
  return map && { path: v.path as string, statusField: v.status_field, map }
}

function parseSignature(v: YamlValue | undefined, taken: string[], err: Err): PluginCalling['signature'] {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err('signature は { scheme, header, timestamp_header, max_age } の形で書いてください'); return null }
  unknownKeys('signature: ', v, ['scheme', 'header', 'timestamp_header', 'max_age'], err)
  if (!inList(v.scheme, CALL_SIGNATURE_SCHEMES)) { err(`signature の scheme は ${CALL_SIGNATURE_SCHEMES.join(' / ')} です`); return null }
  const header = headerProblem(v.header, taken)
  if (header) { err(`signature の header: ${header}`); return null }
  const timestamp = headerProblem(v.timestamp_header, [...taken, (v.header as string).toLowerCase()])
  if (timestamp) { err(`signature の timestamp_header: ${timestamp}`); return null }
  const age = settingDurationMinutes(v.max_age)
  if (age === null || age > SIGNATURE_MAX_AGE_MINUTES) { err(`signature の max_age は 5m のような時間です（${SIGNATURE_MAX_AGE_MINUTES} 分まで）`); return null }
  return { scheme: v.scheme, header: v.header as string, timestampHeader: v.timestamp_header as string, maxAge: v.max_age as string }
}

function parseEvents(v: YamlValue | undefined, err: Err): Record<string, PluginEvent> {
  const out: Record<string, PluginEvent> = {}
  if (v === undefined) return out
  if (!isYamlMap(v)) { err('events は「知らせの名前: { fields }」の形で書いてください'); return out }
  for (const [name, e] of Object.entries(v)) {
    const where = `知らせ「${name}」`
    if (!ONTOLOGY_NAME_RE.test(name)) { err(`${where}: 名前は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(e)) { err(`${where}は { fields } の形で書いてください`); continue }
    unknownKeys(`${where}: `, e, ['fields'], err)
    out[name] = { fields: parseEventFields(where, e.fields, err), use: null }
  }
  return out
}

function parsePolls(v: YamlValue | undefined, err: Err): Record<string, PluginPoll> {
  const out: Record<string, PluginPoll> = {}
  if (v === undefined) return out
  if (!isYamlMap(v)) { err('polls は「名前: { path, cursor, items, every }」の形で書いてください'); return out }
  for (const [name, p] of Object.entries(v)) {
    const where = `見に行く道「${name}」`
    if (!ONTOLOGY_NAME_RE.test(name)) { err(`${where}: 名前は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(p)) { err(`${where}は { path, cursor, items, every } の形で書いてください`); continue }
    unknownKeys(`${where}: `, p, ['path', 'cursor', 'items', 'every', 'type_field', 'fields'], err)
    const placeholders = callPathPlaceholders(p.path)
    if ('problem' in placeholders) { err(`${where}: ${placeholders.problem}`); continue }
    if (placeholders.names.length > 0) { err(`${where}: 道に差し込みは書けません`); continue }
    const cursor = parseCursor(where, p.cursor, err)
    if (!plainName(p.items)) err(`${where}の items は項目名です`)
    if (p.type_field !== undefined && !plainName(p.type_field)) err(`${where}の type_field は項目名です`)
    const every = settingDurationMinutes(p.every)
    if (every === null || every > POLL_EVERY_MAX_MINUTES) err(`${where}の every は 5m のような時間です（1 日まで）`)
    const fields = parseEventFields(where, p.fields, err)
    if (cursor && plainName(p.items) && every !== null) out[name] = { path: p.path as string, cursor, items: p.items, typeField: plainName(p.type_field) ? p.type_field : null, every: p.every as string, fields }
  }
  return out
}

/** A contract-3 connector's part; absent keys leave the manifest as a contract-2 connector's. */
export function parseConnectorV3(raw: Raw, err: Err): Pick<PluginManifest, 'calling' | 'calls' | 'events' | 'polls'> {
  const auth = parseAuth(raw.auth, err)
  // The key's own header, and the one idempotency sends, can never carry anything else.
  const taken = ['authorization', IDEMPOTENCY_HEADER, ...(auth ? [auth.header.toLowerCase()] : [])]
  const actor = parseActor(raw.actor, taken, err)
  const signature = parseSignature(raw.signature, taken, err)
  const calling: PluginCalling = { auth, actor, limits: parseLimits(raw.limits, err), errors: parseErrors(raw.errors, err), result: parseResult(raw.result, err), signature }
  const calls: Record<string, PluginCall> = {}
  if (raw.calls !== undefined && !isYamlMap(raw.calls)) err('calls は「名前: { kind, … }」の形で書いてください')
  else for (const [name, c] of Object.entries(raw.calls ?? {})) {
    const call = parseCall(name, c, err)
    if (call) calls[name] = call
  }
  const events = parseEvents(raw.events, err)
  const polls = parsePolls(raw.polls, err)
  if (!auth && (raw.calls !== undefined || raw.polls !== undefined)) err('calls / polls を書いたら auth（鍵の渡し方）を書いてください')
  return {
    ...(Object.values(calling).some(v => v !== null) ? { calling } : {}),
    ...(Object.keys(calls).length > 0 ? { calls } : {}),
    ...(Object.keys(events).length > 0 ? { events } : {}),
    ...(Object.keys(polls).length > 0 ? { polls } : {}),
  }
}

/**
 * A call's `who`. Narrower than an operation's on purpose: a call has no record,
 * so no person field and no `viewer` (which the engine reads as `anyone`), and
 * at least one person: `mayAct` lets `[ai]` alone pass for any member's AI.
 */
function callWhoProblem(where: string, who: string[] | null): string | null {
  const allowed = `role:<名前> / ${CALL_ACTORS.join(' / ')}`
  if (!who || who.length === 0) return `${where}の who は ${allowed} で書いてください`
  for (const w of who) {
    const role = w.startsWith(ROLE_WHO_PREFIX) && ONTOLOGY_NAME_RE.test(w.slice(ROLE_WHO_PREFIX.length))
    if (!role && !inList(w, CALL_ACTORS)) return `${where}の who「${w}」は書けません（書けるのは ${allowed} です）`
  }
  if (who.every(w => w === 'ai')) return `${where}の who には人（role:<名前> か admin）も書いてください（ai だけだと、どのメンバーの AI でも動かせてしまいます）`
  return null
}

/** A business plugin's `calls`: which of the connector's calls it uses and who may. Checked against the connector by `combineUse`. */
export function parseCallUses(v: YamlValue | undefined, err: Err): Record<string, CallUse> {
  const out: Record<string, CallUse> = {}
  if (v === undefined) return out
  if (!isYamlMap(v)) { err('calls は「つなぎ先の呼び出し: { who, … }」の形で書いてください'); return out }
  for (const [name, use] of Object.entries(v)) {
    const where = `呼び出し「${name}」`
    if (!ONTOLOGY_NAME_RE.test(name)) { err(`${where}: 名前は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(use)) { err(`${where}は { who, … } の形で書いてください`); continue }
    unknownKeys(`${where}: `, use, ['who', 'decision'], err)
    const who = strList(use.who)
    const problem = callWhoProblem(where, who)
    if (problem) { err(problem); continue }
    const decision = use.decision ?? false
    if (typeof decision !== 'boolean') { err(`${where}の decision は true か false です`); continue }
    out[name] = { who: who as string[], decision }
  }
  return out
}

/** A business plugin's `events`: which of the connector's events it reacts to. Checked by `validatePluginPackage` (type, field, action) and `combineUse` (the event). */
export function parseEventUses(v: YamlValue | undefined, err: Err): Record<string, EventUse> {
  const out: Record<string, EventUse> = {}
  if (v === undefined) return out
  if (!isYamlMap(v)) { err('events は「つなぎ先の知らせ: { type, match, action }」の形で書いてください'); return out }
  for (const [name, use] of Object.entries(v)) {
    const where = `知らせ「${name}」`
    if (!ONTOLOGY_NAME_RE.test(name)) { err(`${where}: 名前は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(use)) { err(`${where}は { type, match, action } の形で書いてください`); continue }
    unknownKeys(`${where}: `, use, ['type', 'match', 'action'], err)
    const { type, match, action } = use
    if (typeof type !== 'string' || typeof match !== 'string' || typeof action !== 'string' || ![type, match, action].every(n => ONTOLOGY_NAME_RE.test(n))) {
      err(`${where}の type / match / action は名前で書いてください`)
      continue
    }
    out[name] = { type, match, action }
  }
  return out
}
