/**
 * A browser connector's part of `plugin.yaml` (「ブラウザ操作」, design memo
 * 2026-11-20; plugins.md "Browser connectors (contract only)"): the site the
 * chat AI may operate in the app's browser window, and the operation types it
 * may run there — never free clicking.
 *
 * Still data only. An operation type names a reviewed adapter shipped in the
 * app (`adapter`, checked to exist by the app) that reads the target and its
 * current value from the page; the declaration fixes what the plan names
 * (`target`, `change`) and the only write requests the type may send
 * (`writes`: method, path and body fields, each a literal or one plan field).
 * The runner lets a write through only when `matchDeclaredWrite` says it is
 * one of them with exactly the approved plan's values — the guard that stops
 * an approved save from becoming something else (a broadcast).
 *
 * Contract only: nothing installs, distributes or runs a browser connector
 * yet (the shelf refuses one, `combineUse` refuses one).
 */
import {
  BROWSER_OPERATION_LIMITS, levelAllows, normalizeBrowserHost,
  type BrowserOperationEffect, type BrowserOperationSettings, type BrowserSiteSetting,
} from './browser-operation'
import { noFlow, type CommonPart, type PluginManifest } from './plugin-declaration'
import { unknownKeys } from './plugin-declaration-rules'
import { checkUpstreamPath } from './upstream-path'
import { isYamlMap, type YamlValue } from './yaml-lite'

/** The one top-level key of a browser connector besides the common ones. */
export const BROWSER_KEY = 'browser'

/** How a plan names a thing or a value: `id` a plain token (digits / ASCII), `text` plain text. */
export type BrowserFieldKind = 'id' | 'text'
export const BROWSER_FIELD_KINDS: readonly BrowserFieldKind[] = ['id', 'text']
/** Methods a declared write may use. Never GET: a read changes nothing and needs no declaration. */
export type BrowserWriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export const BROWSER_WRITE_METHODS: readonly BrowserWriteMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE']
/** How the body is sent: a form (`application/x-www-form-urlencoded`) or a flat JSON object. */
export type BrowserBodyEncoding = 'form' | 'json'
export const BROWSER_BODY_ENCODINGS: readonly BrowserBodyEncoding[] = ['form', 'json']
export const BROWSER_EFFECTS: readonly BrowserOperationEffect[] = ['read', 'write', 'delete']

export const BROWSER_DECLARATION_LIMITS = {
  operations: 30,
  fields: 10,
  writes: 5,
  bodyKeys: 30,
  ignoreBody: 10,
  label: 60,
  accountLabel: 40,
  shared: 200,
  path: 300,
  literal: 200,
  adapter: 80,
  idValue: 64,
  textValue: 2000,
} as const

/** Operation, target and change names. */
export const BROWSER_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/
/** A reviewed adapter shipped in the app: `<site>.<operation>`. */
export const BROWSER_ADAPTER_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/
/** A body field's name as a site's form sends it (`content_id`, `data[title]`, `_token`). */
export const BROWSER_BODY_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.[\]-]{0,99}$/
/** A plan's `id` value: digits or a plain ASCII token. */
export const BROWSER_ID_VALUE_RE = /^[A-Za-z0-9_-]{1,64}$/
const PATH_RE = /^\/[A-Za-z0-9/_.~-]{0,299}$/
const PLACEHOLDER_RE = /^\{([a-z][a-z0-9_]{0,39})\}$/
// Control characters and the bidirectional overrides that make text read differently from what it is.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/
// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/

/** A body value: a fixed literal, or exactly one plan field (`{name}`). */
export type BrowserBodyValue = { literal: string } | { field: string }

export interface BrowserWrite {
  method: BrowserWriteMethod
  /** Absolute, fixed (no placeholder, query or fragment), on the operated host. */
  path: string
  encoding: BrowserBodyEncoding
  /** Every key the request must carry, with its value. */
  body: Record<string, BrowserBodyValue>
  /** Keys the request may also carry with any value (a CSRF token, a session field). */
  ignoreBody: string[]
}

export interface BrowserOperation {
  label: string
  effect: BrowserOperationEffect
  /** The reviewed adapter in the app that reads (and confirms) this type: `<site>.<operation>`. */
  adapter: string
  /** A note shown on plans that use it (「前の回の人にも届きます」): a warning, nothing blocked. */
  shared: string | null
  /** True: the person confirms once more right before this step. */
  irreversible: boolean
  /** What identifies the thing changed (never empty). */
  target: Record<string, BrowserFieldKind>
  /** The values the plan sets (empty for a read, may be empty for a delete). */
  change: Record<string, BrowserFieldKind>
  /** The only write requests this type may send (none for a read). */
  writes: BrowserWrite[]
}

export interface PluginBrowser {
  /** The operated host (exact, `normalizeBrowserHost`). */
  host: string
  /** Hosts its pages load parts from (exact; never the operated host). */
  assetHosts: string[]
  /** Which outside account a plan is bound to; required once a type writes. */
  account: { label: string } | null
  operations: Record<string, BrowserOperation>
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Plain one-line text within `max` characters, or null. */
function plainText(v: YamlValue | undefined, max: number): string | null {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max || UNSAFE_TEXT_RE.test(v)) return null
  return v
}

function parseFields(where: string, raw: YamlValue | undefined, err: (m: string) => void): Record<string, BrowserFieldKind> {
  const out: Record<string, BrowserFieldKind> = {}
  if (raw === undefined) return out
  if (!isYamlMap(raw)) { err(`${where}は「名前: id か text」の形で書いてください`); return out }
  const entries = Object.entries(raw)
  if (entries.length > BROWSER_DECLARATION_LIMITS.fields) err(`${where}は ${BROWSER_DECLARATION_LIMITS.fields} 個までです`)
  for (const [name, kind] of entries) {
    if (!BROWSER_NAME_RE.test(name)) { err(`${where}の名前「${name}」は英小文字・数字・_ で書いてください`); continue }
    if (!(BROWSER_FIELD_KINDS as readonly unknown[]).includes(kind)) { err(`${where}の「${name}」は ${BROWSER_FIELD_KINDS.join(' か ')} です`); continue }
    out[name] = kind as BrowserFieldKind
  }
  return out
}

function parseWrite(where: string, raw: YamlValue, effect: BrowserOperationEffect, fields: ReadonlySet<string>, targetNames: ReadonlySet<string>, err: (m: string) => void): BrowserWrite | null {
  if (!isYamlMap(raw)) { err(`${where}は { method, path, body } の形で書いてください`); return null }
  unknownKeys(`${where}: `, raw, ['method', 'path', 'encoding', 'body', 'ignore_body'], err)
  let ok = true
  const method = raw.method
  if (!(BROWSER_WRITE_METHODS as readonly unknown[]).includes(method)) { err(`${where}の method は ${BROWSER_WRITE_METHODS.join(' / ')} のどれかです（GET は書きません）`); ok = false }
  // A DELETE request is a deletion: only a type the site's level must allow as one may send it.
  else if (method === 'DELETE' && effect !== 'delete') { err(`${where}: method DELETE は effect: delete の操作だけに書けます`); ok = false }
  const path = raw.path
  if (typeof path !== 'string' || !PATH_RE.test(path) || !checkUpstreamPath(path)) {
    err(`${where}の path は / で始まる決まった道です（英数字・/ _ . ~ - だけ。? # {…}・//・.. は使えません）`)
    ok = false
  }
  const encoding = raw.encoding ?? 'form'
  if (!(BROWSER_BODY_ENCODINGS as readonly unknown[]).includes(encoding)) { err(`${where}の encoding は form か json です`); ok = false }

  const body: Record<string, BrowserBodyValue> = {}
  const rawBody = raw.body
  if (!isYamlMap(rawBody) || Object.keys(rawBody).length === 0) { err(`${where}の body は「項目名: 値」の形で書いてください（1つ以上）`); ok = false }
  else {
    if (Object.keys(rawBody).length > BROWSER_DECLARATION_LIMITS.bodyKeys) { err(`${where}の body は ${BROWSER_DECLARATION_LIMITS.bodyKeys} 項目までです`); ok = false }
    for (const [key, value] of Object.entries(rawBody)) {
      if (!BROWSER_BODY_KEY_RE.test(key)) { err(`${where}の body の項目名「${key}」が正しくありません`); ok = false; continue }
      if (typeof value !== 'string') { err(`${where}の body の「${key}」は文字で書いてください（"1" のように引用符で囲む）`); ok = false; continue }
      const placeholder = PLACEHOLDER_RE.exec(value)
      if (placeholder) {
        if (!fields.has(placeholder[1])) { err(`${where}の body の「${key}」: {${placeholder[1]}} は target にも change にもありません`); ok = false; continue }
        body[key] = { field: placeholder[1] }
      } else if (/[{}]/.test(value)) {
        // One whole field or a literal: never text around a placeholder (that would be a template).
        err(`${where}の body の「${key}」は、決まった文字か {名前} ひとつだけです`); ok = false
      } else if (value.length > BROWSER_DECLARATION_LIMITS.literal || UNSAFE_TEXT_RE.test(value)) {
        err(`${where}の body の「${key}」の決まった文字は ${BROWSER_DECLARATION_LIMITS.literal} 文字までの1行です`); ok = false
      } else body[key] = { literal: value }
    }
    // The request must name what the plan is about, or it could be sent for any target.
    if (ok && !Object.values(body).some(v => 'field' in v && targetNames.has(v.field))) { err(`${where}の body には target の項目を1つ以上入れてください`); ok = false }
  }

  const ignoreBody: string[] = []
  if (raw.ignore_body !== undefined) {
    const list = raw.ignore_body
    if (!Array.isArray(list) || list.length > BROWSER_DECLARATION_LIMITS.ignoreBody || !list.every(k => typeof k === 'string' && BROWSER_BODY_KEY_RE.test(k))) {
      err(`${where}の ignore_body は項目名の並びです（${BROWSER_DECLARATION_LIMITS.ignoreBody} 個まで）`); ok = false
    } else {
      for (const k of list as string[]) {
        if (ignoreBody.includes(k)) { err(`${where}の ignore_body に「${k}」が2回あります`); ok = false }
        else if (isYamlMap(rawBody) && own(rawBody, k)) { err(`${where}の ignore_body の「${k}」は body にもあります`); ok = false }
        else ignoreBody.push(k)
      }
    }
  }
  return ok ? { method: method as BrowserWriteMethod, path: path as string, encoding: encoding as BrowserBodyEncoding, body, ignoreBody } : null
}

function parseOperation(name: string, raw: YamlValue, err: (m: string) => void): BrowserOperation | null {
  const where = `操作「${name}」`
  if (!isYamlMap(raw)) { err(`${where}は { … } の形で書いてください`); return null }
  unknownKeys(`${where}: `, raw, ['label', 'effect', 'adapter', 'shared', 'irreversible', 'target', 'change', 'writes'], err)
  let failed = false
  const e = (m: string) => { failed = true; err(m) }
  const label = plainText(raw.label, BROWSER_DECLARATION_LIMITS.label)
  if (!label) e(`${where}の label は ${BROWSER_DECLARATION_LIMITS.label} 文字までの1行で書いてください`)
  const effect = raw.effect
  if (!(BROWSER_EFFECTS as readonly unknown[]).includes(effect)) { e(`${where}の effect は read / write / delete のどれかです`); return null }
  const adapter = raw.adapter
  if (typeof adapter !== 'string' || adapter.length > BROWSER_DECLARATION_LIMITS.adapter || !BROWSER_ADAPTER_RE.test(adapter)) e(`${where}の adapter は「サイト.操作」の名前です（英小文字・数字・_）`)
  let shared: string | null = null
  if (raw.shared !== undefined) {
    shared = plainText(raw.shared, BROWSER_DECLARATION_LIMITS.shared)
    if (!shared) e(`${where}の shared は ${BROWSER_DECLARATION_LIMITS.shared} 文字までの1行の注意書きです`)
  }
  const irreversible = raw.irreversible ?? false
  if (typeof irreversible !== 'boolean') e(`${where}の irreversible は true か false です`)
  else if (irreversible && effect === 'read') e(`${where}: 読むだけの操作に irreversible は書けません`)

  const target = parseFields(`${where}の target`, raw.target, e)
  const change = parseFields(`${where}の change`, raw.change, e)
  if (Object.keys(target).length === 0) e(`${where}の target（何を変えるか）を1つ以上書いてください`)
  for (const n of Object.keys(change)) if (own(target, n)) e(`${where}: 「${n}」が target と change の両方にあります`)

  const writes: BrowserWrite[] = []
  if (effect === 'read') {
    if (raw.change !== undefined) e(`${where}: 読むだけの操作に change は書けません`)
    if (raw.writes !== undefined) e(`${where}: 読むだけの操作に writes は書けません`)
  } else {
    const list = raw.writes
    if (!Array.isArray(list) || list.length === 0 || list.length > BROWSER_DECLARATION_LIMITS.writes) {
      e(`${where}の writes（送ってよい書き込み）を1〜${BROWSER_DECLARATION_LIMITS.writes} 個書いてください`)
    } else {
      const fields = new Set([...Object.keys(target), ...Object.keys(change)])
      const targetNames = new Set(Object.keys(target))
      list.forEach((w, i) => {
        const write = parseWrite(`${where}の writes ${i + 1} 番目`, w, effect as BrowserOperationEffect, fields, targetNames, e)
        if (write) writes.push(write)
      })
      if (writes.length === list.length) {
        const used = new Set(writes.flatMap(w => Object.values(w.body).flatMap(v => 'field' in v ? [v.field] : [])))
        // Every plan field reaches a request: what the plan names is what the runner can hold the request to.
        for (const n of fields) if (!used.has(n)) e(`${where}の「${n}」は writes のどの body にも入っていません`)
      }
    }
  }
  if (failed) return null
  return { label: label as string, effect: effect as BrowserOperationEffect, adapter: adapter as string, shared, irreversible: irreversible as boolean, target, change, writes }
}

/** The `browser` map: the site and its operation types. */
export function parseBrowserPart(raw: YamlValue | undefined, err: (m: string) => void): PluginBrowser | null {
  if (!isYamlMap(raw)) { err('browser は { host, operations, … } の形で書いてください'); return null }
  unknownKeys('browser: ', raw, ['host', 'asset_hosts', 'account', 'operations'], err)
  const host = normalizeBrowserHost(raw.host)
  // Exact spelling only: what the admin approves is what the declaration says, no case or dot folding.
  if (!host || host !== raw.host) err('browser の host は操作するサイトのホスト名です（英小文字。*. は使えません）')
  const assetHosts: string[] = []
  if (raw.asset_hosts !== undefined) {
    const list = raw.asset_hosts
    if (!Array.isArray(list) || list.length > BROWSER_OPERATION_LIMITS.assetHosts) err(`browser の asset_hosts はホスト名の並びです（${BROWSER_OPERATION_LIMITS.assetHosts} 個まで）`)
    else for (const item of list) {
      const asset = normalizeBrowserHost(item)
      if (!asset || asset !== item) err(`browser の asset_hosts の「${String(item)}」はホスト名ではありません（*. は使えません）`)
      else if (asset === host) err('browser の asset_hosts に、操作するサイトのホストは書けません')
      else if (assetHosts.includes(asset)) err(`browser の asset_hosts に「${asset}」が2回あります`)
      else assetHosts.push(asset)
    }
  }
  let account: PluginBrowser['account'] = null
  if (raw.account !== undefined) {
    const a = raw.account
    if (!isYamlMap(a)) err('browser の account は { label } の形で書いてください')
    else {
      unknownKeys('browser の account: ', a, ['label'], err)
      const label = plainText(a.label, BROWSER_DECLARATION_LIMITS.accountLabel)
      if (!label) err(`browser の account の label は ${BROWSER_DECLARATION_LIMITS.accountLabel} 文字までの1行です`)
      else account = { label }
    }
  }
  const operations: Record<string, BrowserOperation> = {}
  const rawOps = raw.operations
  if (!isYamlMap(rawOps) || Object.keys(rawOps).length === 0) err('browser の operations（操作の種類）を1つ以上書いてください')
  else {
    if (Object.keys(rawOps).length > BROWSER_DECLARATION_LIMITS.operations) err(`browser の operations は ${BROWSER_DECLARATION_LIMITS.operations} 個までです`)
    for (const [name, op] of Object.entries(rawOps)) {
      if (!BROWSER_NAME_RE.test(name)) { err(`操作の名前「${name}」は英小文字・数字・_ で書いてください`); continue }
      const parsed = parseOperation(name, op, err)
      if (parsed) operations[name] = parsed
    }
    // A plan that changes something is bound to one outside account.
    if (raw.account === undefined && Object.values(rawOps).some(op => isYamlMap(op) && op.effect !== 'read')) err('書き込む操作があるときは browser の account（どのアカウントの操作か）を書いてください')
  }
  return host ? { host, assetHosts, account, operations } : null
}

/** A browser connector: the common part and `browser`; nothing of an API connector. */
export function parseBrowserConnector(raw: { [k: string]: YamlValue }, err: (m: string) => void, common: CommonPart): PluginManifest {
  const browser = parseBrowserPart(raw.browser, err) ?? { host: '', assetHosts: [], account: null, operations: {} }
  return {
    ...common, role: 'connector', service: '', baseUrl: { host: '', basePath: '' }, scopes: [], operationScopes: {},
    types: [], objects: {}, operations: {}, fieldPolicyDefaults: {}, uses: null, accountInfo: null, ...noFlow(), browser,
  }
}

// ---------------------------------------------------------------------------
// A plan and the one write rule the runner applies
// ---------------------------------------------------------------------------

/** An approved plan's values for one operation type: target and change field → value. */
export interface BrowserPlanValues {
  target: Readonly<Record<string, string>>
  change: Readonly<Record<string, string>>
}

function valueProblem(kind: BrowserFieldKind, v: unknown): boolean {
  if (typeof v !== 'string') return true
  if (kind === 'id') return !BROWSER_ID_VALUE_RE.test(v)
  return v.length > BROWSER_DECLARATION_LIMITS.textValue || UNSAFE_MULTILINE_RE.test(v)
}

/** Why a plan's values do not fit the operation type (exactly its fields, each of its kind), or null. */
export function browserPlanProblem(operation: BrowserOperation, plan: BrowserPlanValues): string | null {
  for (const [part, declared] of [['target', operation.target], ['change', operation.change]] as const) {
    const given = plan[part]
    if (!given || typeof given !== 'object') return `${part} がありません`
    for (const k of Object.keys(given)) if (!own(declared, k)) return `${part} の「${k}」はこの操作にありません`
    for (const [k, kind] of Object.entries(declared)) {
      if (!own(given, k)) return `${part} の「${k}」がありません`
      if (valueProblem(kind, given[k])) return `${part} の「${k}」の値が ${kind} の形ではありません`
    }
  }
  return null
}

/** A write request as the runner intercepted it (CDP Fetch): the path without query, the body parsed by its encoding. */
export interface BrowserWriteRequest {
  method: string
  path: string
  /** From the request's Content-Type; anything that is neither is refused before this is asked. */
  encoding: BrowserBodyEncoding
  /** In order as sent, a repeated key included (a form may repeat one), or a parsed flat object. */
  body: ReadonlyArray<readonly [string, string]> | Readonly<Record<string, string>>
}

export type BrowserWriteMismatch =
  | 'plan' // the plan's values do not fit the type
  | 'not-declared' // no declared write with this method and path
  | 'encoding'
  | 'repeated-key'
  | 'missing-key'
  | 'wrong-value'
  | 'extra-key'

export type BrowserWriteMatch = { match: true; write: number } | { match: false; reason: BrowserWriteMismatch; key?: string }

function checkOne(write: BrowserWrite, plan: BrowserPlanValues, request: BrowserWriteRequest, sent: Map<string, string>): BrowserWriteMatch | null {
  if (request.encoding !== write.encoding) return { match: false, reason: 'encoding' }
  for (const [key, value] of Object.entries(write.body)) {
    if (!sent.has(key)) return { match: false, reason: 'missing-key', key }
    const expected = 'literal' in value ? value.literal : own(plan.target, value.field) ? plan.target[value.field] : plan.change[value.field]
    if (sent.get(key) !== expected) return { match: false, reason: 'wrong-value', key }
  }
  for (const key of sent.keys()) {
    if (!own(write.body, key) && !write.ignoreBody.includes(key)) return { match: false, reason: 'extra-key', key }
  }
  return null
}

/**
 * Is this request one of the writes the operation type declares, carrying
 * exactly the approved plan's values? Exact method and path; every declared
 * body key present with its literal or its plan value; no other key but the
 * declared `ignore_body` ones; a repeated key refuses (a server may read either
 * copy). Anything else is a refusal with its reason (and the body key, a
 * declared name — never a value).
 */
export function matchDeclaredWrite(operation: BrowserOperation, plan: BrowserPlanValues, request: BrowserWriteRequest): BrowserWriteMatch {
  if (browserPlanProblem(operation, plan)) return { match: false, reason: 'plan' }
  const candidates = operation.writes.map((w, i) => [w, i] as const).filter(([w]) => w.method === request.method && w.path === request.path)
  if (candidates.length === 0) return { match: false, reason: 'not-declared' }
  const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(request.body)
    ? request.body as ReadonlyArray<readonly [string, string]>
    : request.body && typeof request.body === 'object' ? Object.entries(request.body) : []
  const sent = new Map<string, string>()
  for (const [k, v] of entries) {
    if (sent.has(k)) return { match: false, reason: 'repeated-key', key: k }
    // A value that is not a string (a JSON number, an object) never equals a declared one.
    sent.set(k, typeof v === 'string' ? v : '\u0000not-a-string')
  }
  let first: BrowserWriteMatch | null = null
  for (const [write, index] of candidates) {
    const refused = checkOne(write, plan, request, sent)
    if (!refused) return { match: true, write: index }
    first ??= refused
  }
  return first as BrowserWriteMatch
}

// ---------------------------------------------------------------------------
// The declaration against the company's setting
// ---------------------------------------------------------------------------

export type BrowserOperationRefusal = 'off' | 'site-not-allowed' | 'asset-host-not-allowed' | 'level'

export interface BrowserDeclarationUse {
  /** The company's entry for the declaration's host, or null. */
  site: BrowserSiteSetting | null
  /** Operation types that may run under this setting. */
  usable: string[]
  refused: Array<{ operation: string; reason: BrowserOperationRefusal }>
  /** Declared asset hosts the company's site does not list (the reason for `asset-host-not-allowed`). */
  missingAssetHosts: string[]
}

/**
 * Which of a browser connector's operation types the company's browser setting
 * lets run: the setting on, the operated host an allowed site, every declared
 * asset host among that site's, and each type's effect within the site's level
 * (`levelAllows`). The rest come back with their reason.
 */
export function browserOperationsAllowed(browser: PluginBrowser, settings: BrowserOperationSettings): BrowserDeclarationUse {
  const names = Object.keys(browser.operations)
  const site = settings.sites.find(s => s.host === browser.host) ?? null
  const missingAssetHosts = site ? browser.assetHosts.filter(h => !site.assetHosts.includes(h)) : []
  const all = (reason: BrowserOperationRefusal): BrowserDeclarationUse => ({ site, usable: [], refused: names.map(operation => ({ operation, reason })), missingAssetHosts })
  if (settings.mode !== 'on') return all('off')
  if (!site) return all('site-not-allowed')
  if (missingAssetHosts.length > 0) return all('asset-host-not-allowed')
  const usable: string[] = []
  const refused: BrowserDeclarationUse['refused'] = []
  for (const [name, op] of Object.entries(browser.operations)) {
    if (levelAllows(site.level, op.effect)) usable.push(name)
    else refused.push({ operation: name, reason: 'level' })
  }
  return { site, usable, refused, missingAssetHosts }
}
