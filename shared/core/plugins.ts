/**
 * Plugins that connect ACB to an outside system (milestone 3, 「つなぎ先の
 * プラグイン」): one copy of their shape for the server (the shelf, the
 * connector), the admin console (the mapping editor) and, later, the app.
 *
 * A plugin is data only (owner decision §6-1): a **declaration**
 * (`plugin.yaml`: where it may send, the fixed paths, the typed operations, the
 * recommended field policies), the **types** it brings (`types/<name>.md`,
 * same format as `.acb/types/`) and a recommended **mapping** (which ACB field
 * is which outside property). The core's one connector performs the calls; a
 * declaration has no place for a program, a destination other than its one
 * `base_url`, a key value, approval rights or a computed value — unknown keys
 * make the whole package unusable.
 *
 * Owner rules (§8, 2026-10-31):
 * 1. The declaration does not grow into a language: no conditions, loops,
 *    expressions or templating beyond `{id}`. A system it cannot describe
 *    needs the (future, sandboxed) second kind of plugin, not a new key here.
 * 2. Type names do not carry their layer (`deal`, never `pack_deal`,
 *    `company_deal` or `hubspot_deal`), so a type can move between core,
 *    industry pack and company without renaming records (`typeNameLayerProblem`).
 * 3. Imported records create no files (enforced where records are imported, P5).
 * 4. Company-specific declarations are written by div (FDE) and put on the
 *    shelf with `available_to` (the company ids that may use it); companies
 *    never upload declarations. Absent = every company.
 *
 * YAML is the strict subset of `yaml-lite.ts` (no anchors, aliases, tags…).
 */
import { isValidBrokerServiceName, parseRelayBaseUrl, builtinBrokerService } from './key-broker'
import { normalizeRepoPath } from './paths'
import { ONTOLOGY_NAME_RE, parseTypeFile, type FieldDef, type NoteRule, type TypeDefinition } from './record-types'
import { checkUpstreamPath } from './upstream-path'
import { isYamlMap, parseYamlLite, type YamlValue } from './yaml-lite'

/**
 * Who may run a plugin operation, besides the record type's person fields
 * (owner, 2026-10-31): `viewer` = anyone who can read the record (an
 * operation is never run on a record the caller cannot read), `ai` = the
 * member's AI (only on records its owner can read, only what its owner may
 * do), `dept_manager`, `admin`. (Type actions say `anyone`; a plugin says
 * `viewer`.)
 */
export const PLUGIN_ACTORS = ['viewer', 'ai', 'dept_manager', 'admin'] as const

/**
 * Fields no plugin may write in milestone 3 (review §5.3, owner 2026-10-31):
 * changing `stage` can move a deal to won / lost — the outcome a
 * pre-approval field guards — so it is not written back at all (a mapping
 * with `write: true` and an `auto` default or policy are refused; at run time
 * it is `off` whatever is stored).
 */
export const MILESTONE3_UNWRITABLE_FIELDS: readonly string[] = ['stage']

/** The plugin contract this build understands (0.17). A declaration naming another is not used. */
export const PLUGIN_CONTRACT = 1

export type PluginKind = 'official' | 'company'
/** Per-field write policy (0.21): write at once (undoable) / only after a person approves / never. */
export type FieldPolicy = 'auto' | 'prior' | 'off'
export const FIELD_POLICIES: readonly FieldPolicy[] = ['auto', 'prior', 'off']
export type OperationKind = 'read' | 'update' | 'create'
/** Whom an operation's effect reaches: the company's own systems, or people outside the company. */
export type OperationReach = 'internal' | 'external'
export type UndoKind = 'restore_previous' | 'archive' | 'none'

/**
 * The only calls a connector makes, each with its one method. A fixed list,
 * not something a declaration can extend.
 */
export const PLUGIN_ENDPOINTS = {
  get: 'GET',
  search: 'POST',
  update: 'PATCH',
  create: 'POST',
  archive: 'DELETE',
  properties_list: 'GET',
  stages_list: 'GET',
} as const
export type PluginEndpointName = keyof typeof PLUGIN_ENDPOINTS
/** Endpoints that address one object (`{id}` exactly once); the others take none. */
const ENDPOINTS_WITH_ID: readonly PluginEndpointName[] = ['get', 'update', 'archive']

export interface PluginEndpoint {
  method: string
  /** Under `base_url`; `{id}` is the only placeholder. */
  path: string
}

export interface PluginObject {
  /** The ACB type its items become; null for objects that are only written (a note). */
  recordType: string | null
  endpoints: Partial<Record<PluginEndpointName, PluginEndpoint>>
  /**
   * Outside properties the outside system sets by itself: a mapping that
   * writes one gets a warning (writing it stops the automatic value).
   */
  autoProperties: string[]
}

export interface PluginOperation {
  label: string
  kind: OperationKind
  object: string
  /** Who may: person fields of the record's type, or `viewer`, `ai`, `dept_manager`, `admin` (`PLUGIN_ACTORS`). */
  who: string[]
  /**
   * A decision (owner, 2026-10-31): the person's or AI's reason is part of the
   * ledger entry; the AI must give one (a note drafted from the consultation,
   * citing its basis). Only on operations that write.
   */
  decision: boolean
  /** update: the mapping's writable fields (the only value: 'mapped'). */
  fields: 'mapped' | null
  /** create: the object whose record the created item is attached to. */
  attachTo: string | null
  reaches: OperationReach
  undo: UndoKind
  note: NoteRule
  /** For operations that write no mapped fields (create): its policy. Never `auto` when external. */
  policy: FieldPolicy
}

export interface PluginManifest {
  id: string
  label: string
  version: string
  kind: PluginKind
  contract: number
  description: string | null
  /** The key broker's service whose key it uses (it never sees the value). */
  service: string
  /** The one destination: https, exact host. */
  baseUrl: { host: string; basePath: string }
  scopes: string[]
  operationScopes: Record<string, string[]>
  types: string[]
  objects: Record<string, PluginObject>
  operations: Record<string, PluginOperation>
  fieldPolicyDefaults: Record<string, FieldPolicy>
  /** Company ids that may use the package; null = every company (§8-4). */
  availableTo: string[] | null
  /**
   * The one GET that names the outside account the key belongs to (HubSpot:
   * the portal id). Required when the package writes (an update or create
   * operation): a connection is bound to one account, and nothing is ever
   * written to another (review §5.7).
   */
  accountInfo: PluginEndpoint | null
}

export type PluginParsed<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export const PLUGIN_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const PLUGIN_VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/
/** Company ids as the server makes them (UUIDs today); kept loose but plain. */
const COMPANY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SCOPE_RE = /^[a-z][a-z0-9._-]{0,99}$/
/** Outside property / association / value names: plain tokens, no paths or expressions. */
const EXTERNAL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/
const PATH_TEMPLATE_RE = /^[A-Za-z0-9/_.{}-]{1,300}$/

/**
 * Words that name a layer or an origin. A type name made of several words may
 * not use one (nor the plugin's own id): `pack_deal`, `hubspot_deal` are
 * refused, `deal` and a type simply called `company` are fine (§8-2).
 */
export const TYPE_LAYER_WORDS: readonly string[] = [
  'core', 'base', 'builtin', 'std', 'standard', 'pack', 'industry', 'vertical', 'company', 'custom', 'tenant',
  'org', 'local', 'official', 'plugin', 'ext', 'external', 'acb',
]

/** Keys someone might reach for to put a program, a destination, a key or approval rights into a declaration. */
const FORBIDDEN_KEY_REASONS: Record<string, string> = {
  script: 'プログラムは書けません', scripts: 'プログラムは書けません', code: 'プログラムは書けません', program: 'プログラムは書けません',
  command: 'プログラムを起動する項目は書けません', commands: 'プログラムを起動する項目は書けません', exec: 'プログラムを起動する項目は書けません',
  run: 'プログラムを起動する項目は書けません', start: 'プログラムを起動する項目は書けません', tools: 'プログラムを起動する項目は書けません',
  hooks: 'プログラムを起動する項目は書けません', expression: '式は書けません', formula: '式は書けません', when: '条件は書けません', if: '条件は書けません',
  url: '送り先は base_url だけです', host: '送り先は base_url だけです', hosts: '送り先は base_url だけです', redirect: '送り先は base_url だけです',
  key: '鍵の値は書けません（鍵は「API キー」の金庫に入れます）', api_key: '鍵の値は書けません（鍵は「API キー」の金庫に入れます）',
  token: '鍵の値は書けません（鍵は「API キー」の金庫に入れます）', secret: '鍵の値は書けません（鍵は「API キー」の金庫に入れます）',
  approve: '承認する権限は書けません', approver: '承認する権限は書けません', approvers: '承認する権限は書けません',
}

const isStr = (v: YamlValue | undefined): v is string => typeof v === 'string' && v.trim() !== ''
const strList = (v: YamlValue | undefined): string[] | null =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : null

function unknownKeys(where: string, obj: { [k: string]: YamlValue }, allowed: readonly string[], err: (m: string) => void): void {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue
    const why = FORBIDDEN_KEY_REASONS[k.toLowerCase()]
    err(why ? `${where}「${k}」: ${why}` : `${where}知らない項目「${k}」があります`)
  }
}

/** Why a type name carries its layer, or null when it is fine (§8-2). */
export function typeNameLayerProblem(name: string, pluginId?: string): string | null {
  const words = name.split('_').filter(Boolean)
  const own = pluginId ? pluginId.replace(/-/g, '_').split('_') : []
  if (pluginId && (name === pluginId.replace(/-/g, '_') || (words.length > 1 && own.some(w => words.includes(w))))) {
    return `型の名前「${name}」にプラグインの名前を入れないでください（例：deal）`
  }
  if (words.length > 1 && words.some(w => TYPE_LAYER_WORDS.includes(w))) {
    return `型の名前「${name}」に置き場所（本体・業種のパック・会社など）を表す言葉を入れないでください（例：deal）`
  }
  return null
}

/** A path template: under the relay's path rule, `{id}` the only placeholder (exactly once where one object is addressed). */
export function checkPluginPathTemplate(path: unknown, endpoint: PluginEndpointName): string | null {
  if (typeof path !== 'string' || !PATH_TEMPLATE_RE.test(path)) return '道は / で始まる英数字・/ _ . - と {id} だけで書いてください（? や # は使えません）'
  const placeholders = path.match(/\{[^}]*\}/g) ?? []
  if (/[{}]/.test(path.replace(/\{id\}/g, ''))) return '道に書ける差し込みは {id} だけです'
  const wantsId = ENDPOINTS_WITH_ID.includes(endpoint)
  if (wantsId && placeholders.length !== 1) return `${endpoint} の道には {id} をちょうど1つ書いてください`
  if (!wantsId && placeholders.length !== 0) return `${endpoint} の道に {id} は書けません`
  if (!checkUpstreamPath(path.replace('{id}', '1'))) return '道の書き方が正しくありません（//・..・%2f などは使えません）'
  return null
}

/** Parse and validate `plugin.yaml`. Type-dependent checks are in `validatePluginPackage`. */
export function parsePluginManifest(text: string): PluginParsed<PluginManifest> {
  const yaml = parseYamlLite(text)
  if (!yaml.ok) return { ok: false, errors: [`${yaml.line} 行目: ${yaml.error}`] }
  const raw = yaml.value
  if (!isYamlMap(raw)) return { ok: false, errors: ['宣言は「項目名: 値」の形で書いてください'] }
  const errors: string[] = []
  const err = (m: string) => { if (errors.length < 50) errors.push(m) }
  unknownKeys('', raw, ['id', 'label', 'version', 'kind', 'contract', 'description', 'service', 'base_url', 'scopes', 'operation_scopes', 'types', 'objects', 'operations', 'field_policy_defaults', 'available_to', 'account_info'], err)

  const id = raw.id
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id) || id.length > 40) err('id は英小文字・数字・- で書いてください（40文字まで）')
  if (!isStr(raw.label)) err('label（画面に出す名前）を書いてください')
  if (typeof raw.version !== 'string' || !PLUGIN_VERSION_RE.test(raw.version)) err('version は "0.1.0" のように書いてください')
  if (raw.contract !== PLUGIN_CONTRACT) err(`contract が ${String(raw.contract)} です。このサーバーが分かるのは ${PLUGIN_CONTRACT} です`)
  const kind = raw.kind ?? 'official'
  if (kind !== 'official' && kind !== 'company') err('kind は official か company です')
  if (raw.description !== undefined && typeof raw.description !== 'string') err('description は文字で書いてください')

  let availableTo: string[] | null = null
  if (raw.available_to !== undefined) {
    const list = strList(raw.available_to)
    if (!list || list.length === 0 || list.length > 200 || !list.every(c => COMPANY_ID_RE.test(c))) err('available_to は使える会社の id の並び（1〜200件）で書いてください')
    else if (new Set(list).size !== list.length) err('available_to に同じ会社が2回書かれています')
    else availableTo = list
  }
  if (kind === 'company' && availableTo === null) err('kind: company の包みには available_to（使える会社）が要ります')

  if (!isValidBrokerServiceName(raw.service)) err('service に「API キー」のサービス名を書いてください')
  const base = parseRelayBaseUrl(raw.base_url)
  let baseUrl = { host: '', basePath: '' }
  if ('error' in base) err(`base_url: ${base.error}`)
  else {
    baseUrl = base.value
    const builtin = typeof raw.service === 'string' ? builtinBrokerService(raw.service) : undefined
    if (builtin && !builtin.defaultHosts.includes(baseUrl.host)) err(`base_url の送り先は ${builtin.defaultHosts.join(' / ')} です（サービス ${builtin.service} の送り先）`)
  }

  const scopes = strList(raw.scopes)
  if (!scopes || !scopes.every(s => SCOPE_RE.test(s))) err('scopes は権限の名前の並びで書いてください')

  const types = strList(raw.types)
  if (!types || !types.every(t => ONTOLOGY_NAME_RE.test(t))) err('types は型の名前の並びで書いてください')
  else for (const t of types) {
    const problem = typeNameLayerProblem(t, typeof id === 'string' ? id : undefined)
    if (problem) err(problem)
  }

  const objects: Record<string, PluginObject> = {}
  const rawObjects = raw.objects ?? {}
  if (!isYamlMap(rawObjects)) err('objects は「名前: { … }」の形で書いてください')
  else for (const [oname, o] of Object.entries(rawObjects)) {
    if (!ONTOLOGY_NAME_RE.test(oname)) { err(`対象の名前「${oname}」は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(o)) { err(`対象「${oname}」は { … } の形で書いてください`); continue }
    unknownKeys(`対象「${oname}」: `, o, ['record_type', 'auto_properties', ...Object.keys(PLUGIN_ENDPOINTS)], err)
    let recordType: string | null = null
    if (o.record_type !== undefined && o.record_type !== null) {
      if (typeof o.record_type !== 'string' || !types?.includes(o.record_type)) err(`対象「${oname}」の record_type は types にある型の名前です`)
      else recordType = o.record_type
    }
    const autoProperties = strList(o.auto_properties)
    if (!autoProperties || !autoProperties.every(p => EXTERNAL_NAME_RE.test(p))) err(`対象「${oname}」の auto_properties は項目名の並びです`)
    const endpoints: Partial<Record<PluginEndpointName, PluginEndpoint>> = {}
    for (const ename of Object.keys(PLUGIN_ENDPOINTS) as PluginEndpointName[]) {
      const e = o[ename]
      if (e === undefined) continue
      if (!isYamlMap(e)) { err(`対象「${oname}」の ${ename} は { method, path } の形で書いてください`); continue }
      unknownKeys(`対象「${oname}」の ${ename}: `, e, ['method', 'path'], err)
      if (e.method !== PLUGIN_ENDPOINTS[ename]) { err(`対象「${oname}」の ${ename} の method は ${PLUGIN_ENDPOINTS[ename]} です`); continue }
      const problem = checkPluginPathTemplate(e.path, ename)
      if (problem) { err(`対象「${oname}」の ${ename}: ${problem}`); continue }
      endpoints[ename] = { method: e.method, path: e.path as string }
    }
    objects[oname] = { recordType, endpoints, autoProperties: autoProperties ?? [] }
  }

  const operations: Record<string, PluginOperation> = {}
  const rawOps = raw.operations ?? {}
  if (!isYamlMap(rawOps)) err('operations は「名前: { … }」の形で書いてください')
  else for (const [opname, op] of Object.entries(rawOps)) {
    if (!ONTOLOGY_NAME_RE.test(opname)) { err(`操作の名前「${opname}」は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(op)) { err(`操作「${opname}」は { … } の形で書いてください`); continue }
    unknownKeys(`操作「${opname}」: `, op, ['label', 'kind', 'object', 'who', 'fields', 'attach_to', 'reaches', 'undo', 'note', 'policy', 'decision'], err)
    const where = `操作「${opname}」`
    if (!isStr(op.label)) err(`${where}に label を書いてください`)
    const opKind = op.kind
    if (opKind !== 'read' && opKind !== 'update' && opKind !== 'create') { err(`${where}の kind は read / update / create です`); continue }
    const obj = typeof op.object === 'string' ? objects[op.object] : undefined
    if (!obj) { err(`${where}の object は objects にある名前です`); continue }
    const who = strList(op.who)
    if (!who || who.length === 0 || !who.every(w => ONTOLOGY_NAME_RE.test(w))) err(`${where}の who は人の欄の名前か ${PLUGIN_ACTORS.join(' / ')} で書いてください`)
    else if (who.includes('anyone')) err(`${where}の who に anyone は書けません。記録を読める人なら viewer です`)
    const decision = op.decision ?? false
    if (typeof decision !== 'boolean') err(`${where}の decision は true か false です`)
    else if (decision && opKind === 'read') err(`${where}: 読む操作は decision にできません`)
    const reaches = op.reaches ?? 'internal'
    if (reaches !== 'internal' && reaches !== 'external') err(`${where}の reaches は internal か external です`)
    const note = op.note ?? 'none'
    if (note !== 'none' && note !== 'optional' && note !== 'required') err(`${where}の note は none / optional / required です`)
    const undo = op.undo ?? 'none'
    if (undo !== 'none' && undo !== 'restore_previous' && undo !== 'archive') err(`${where}の undo は restore_previous / archive / none です`)
    let fields: 'mapped' | null = null
    let attachTo: string | null = null
    if (opKind === 'read') {
      if (!obj.endpoints.get || !obj.recordType) err(`${where}: 読む操作の対象には get と record_type が要ります`)
      if (op.fields !== undefined || op.attach_to !== undefined || op.undo !== undefined || op.policy !== undefined) err(`${where}: 読む操作に fields / attach_to / undo / policy は書けません`)
    } else if (opKind === 'update') {
      if (!obj.endpoints.get || !obj.endpoints.update || !obj.recordType) err(`${where}: 書き換える操作の対象には get・update・record_type が要ります`)
      if (op.fields !== 'mapped') err(`${where}の fields は mapped です（書けるのは読み替え表で「書く」にした欄だけ）`)
      else fields = 'mapped'
      if (undo === 'archive') err(`${where}: 書き換えの戻し方は restore_previous か none です`)
      if (op.attach_to !== undefined) err(`${where}: attach_to は作る操作だけに書けます`)
      if (op.policy !== undefined) err(`${where}: 書き換える操作の決まりは欄ごとです（field_policy_defaults と読み替え表）`)
    } else {
      if (!obj.endpoints.create) err(`${where}: 作る操作の対象には create が要ります`)
      if (op.fields !== undefined) err(`${where}: 作る操作に fields は書けません`)
      if (undo === 'restore_previous') err(`${where}: 作ったものの戻し方は archive か none です`)
      if (undo === 'archive' && !obj.endpoints.archive) err(`${where}: undo: archive には対象の archive が要ります`)
      const target = typeof op.attach_to === 'string' ? objects[op.attach_to] : undefined
      if (!target?.recordType) err(`${where}の attach_to は record_type のある対象の名前です`)
      else attachTo = op.attach_to as string
    }
    let policy: FieldPolicy = reaches === 'external' ? 'prior' : 'auto'
    if (op.policy !== undefined) {
      if (!FIELD_POLICIES.includes(op.policy as FieldPolicy)) err(`${where}の policy は auto / prior / off です`)
      else policy = op.policy as FieldPolicy
    }
    if (reaches === 'external' && policy === 'auto') err(`${where}: 社外の人に届く操作は「自動」にできません`)
    operations[opname] = {
      label: isStr(op.label) ? op.label : opname,
      kind: opKind,
      object: op.object as string,
      who: who ?? [],
      fields,
      attachTo,
      reaches: reaches as OperationReach,
      undo: undo as UndoKind,
      note: note as NoteRule,
      policy,
      decision: decision === true,
    }
  }

  let accountInfo: PluginEndpoint | null = null
  if (raw.account_info !== undefined) {
    const e = raw.account_info
    if (!isYamlMap(e)) err('account_info は { method: GET, path } の形で書いてください')
    else {
      unknownKeys('account_info: ', e, ['method', 'path'], err)
      const problem = e.method !== 'GET' ? 'account_info の method は GET です' : checkPluginPathTemplate(e.path, 'properties_list')
      if (problem) err(`account_info: ${problem}`)
      else accountInfo = { method: 'GET', path: e.path as string }
    }
  }
  if (!accountInfo && Object.values(operations).some(op => op.kind !== 'read')) {
    err('書き込む操作があるプラグインには account_info（鍵がどのアカウントのものかを読む道）が要ります')
  }

  const operationScopes: Record<string, string[]> = {}
  const rawOpScopes = raw.operation_scopes ?? {}
  if (!isYamlMap(rawOpScopes)) err('operation_scopes は「操作の名前: [権限…]」の形で書いてください')
  else for (const [opname, list] of Object.entries(rawOpScopes)) {
    const l = strList(list)
    if (!(opname in operations)) err(`operation_scopes の「${opname}」は operations にありません`)
    else if (!l || l.length === 0 || !l.every(s => SCOPE_RE.test(s))) err(`operation_scopes の「${opname}」は権限の名前の並びで書いてください`)
    else operationScopes[opname] = l
  }

  const fieldPolicyDefaults: Record<string, FieldPolicy> = {}
  const rawDefaults = raw.field_policy_defaults ?? {}
  if (!isYamlMap(rawDefaults)) err('field_policy_defaults は「欄の名前: auto / prior / off」の形で書いてください')
  else for (const [f, p] of Object.entries(rawDefaults)) {
    if (!ONTOLOGY_NAME_RE.test(f) || !FIELD_POLICIES.includes(p as FieldPolicy)) err(`field_policy_defaults の「${f}」は auto / prior / off です`)
    else if (p === 'auto' && MILESTONE3_UNWRITABLE_FIELDS.includes(f)) err(`field_policy_defaults の「${f}」: 節目3ではこの欄は書き戻せないため、auto にできません`)
    else fieldPolicyDefaults[f] = p as FieldPolicy
  }
  for (const [f, p] of Object.entries(fieldPolicyDefaults)) {
    if (p === 'auto' && externalFieldWriters({ operations }).length > 0) err(`欄「${f}」: 社外の人に届く書き換えの操作があるため、欄の決まりを「自動」にできません`)
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      id: id as string,
      label: raw.label as string,
      version: raw.version as string,
      kind: kind as PluginKind,
      contract: PLUGIN_CONTRACT,
      description: typeof raw.description === 'string' ? raw.description : null,
      service: raw.service as string,
      baseUrl,
      scopes: scopes ?? [],
      operationScopes,
      types: types ?? [],
      objects,
      operations,
      fieldPolicyDefaults,
      availableTo,
      accountInfo,
    },
  }
}

/** Update operations reaching people outside the company (they write mapped fields), optionally of one object. */
function externalFieldWriters(manifest: Pick<PluginManifest, 'operations'>, objectName?: string): string[] {
  return Object.entries(manifest.operations)
    .filter(([, op]) => op.reaches === 'external' && op.fields === 'mapped' && (objectName === undefined || op.object === objectName))
    .map(([n]) => n)
}

/** Whether the package may be used by `companyId` (§8-4): no list = every company. The shelf filters with it (P4). */
export function pluginAvailableTo(manifest: Pick<PluginManifest, 'availableTo'>, companyId: string): boolean {
  return manifest.availableTo === null || manifest.availableTo.includes(companyId)
}

export interface PluginPackage {
  manifest: PluginManifest
  types: Record<string, TypeDefinition>
  /** The recommended mapping, when the package has one. */
  mapping: PluginMapping | null
}

/**
 * A whole package as found on the shelf: the declaration, the type files it
 * lists (exactly those) and an optional recommended mapping. Everything that
 * depends on the types — `record_type`, `who`, the field policy defaults — is
 * checked here.
 */
export function validatePluginPackage(input: { manifest: string; types: Record<string, string>; mapping?: string | null }): PluginParsed<PluginPackage> {
  const m = parsePluginManifest(input.manifest)
  if (!m.ok) return m
  const manifest = m.value
  const errors: string[] = []
  const types: Record<string, TypeDefinition> = {}
  for (const name of Object.keys(input.types)) {
    if (!manifest.types.includes(name)) errors.push(`types/${name}.md は宣言の types にありません`)
  }
  for (const name of manifest.types) {
    const text = input.types[name]
    if (text === undefined) { errors.push(`型「${name}」のファイル types/${name}.md がありません`); continue }
    const t = parseTypeFile(name, text)
    if (!t.ok) errors.push(...t.errors.map(e => `types/${name}.md: ${e}`))
    else if (t.definition.storage !== 'server') errors.push(`型「${name}」: 取り込んだ記録はファイルを作らないため、storage は server です`)
    else types[name] = t.definition
  }
  if (errors.length === 0) {
    for (const [opname, op] of Object.entries(manifest.operations)) {
      const typeName = manifest.objects[op.kind === 'create' ? op.attachTo! : op.object].recordType!
      const type = types[typeName]
      const persons = new Set(Object.entries(type.fields).filter(([, f]) => f.kind === 'person').map(([n]) => n))
      for (const w of op.who) {
        if (!persons.has(w) && !(PLUGIN_ACTORS as readonly string[]).includes(w)) errors.push(`操作「${opname}」の who「${w}」は型「${typeName}」の人の欄でも ${PLUGIN_ACTORS.join(' / ')} でもありません`)
      }
    }
    const allFields = new Set(Object.values(types).flatMap(t => Object.keys(t.fields)))
    for (const f of Object.keys(manifest.fieldPolicyDefaults)) {
      if (!allFields.has(f)) errors.push(`field_policy_defaults の「${f}」は、どの型の欄でもありません`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  let mapping: PluginMapping | null = null
  if (input.mapping != null) {
    const r = parsePluginMapping(input.mapping, { manifest, types })
    if (!r.ok) return { ok: false, errors: r.errors.map(e => `おすすめの読み替え表: ${e}`) }
    mapping = r.value
  }
  return { ok: true, value: { manifest, types, mapping } }
}

// ── The mapping (読み替え表): per company, versioned on the server (P4) ──

export interface MappingField {
  /** The outside property. */
  from: string
  /** The connector may write this field back. */
  write: boolean
  /** Outside value → ACB value (a choice field's options). */
  values: Record<string, string> | null
  /** For a person field: the name of the `people` table translating outside ids to member ids. */
  people: string | null
}

export interface MappingObject {
  /** Records are readable by members who can read this folder; null = everyone. Not a private folder (checked by the server). */
  visibleToFolder: string | null
  import: { pipelines: string[]; updatedWithinDays: number | null; max: number }
  fields: Record<string, MappingField>
  /** Links of the record's type, filled from the outside system's associations. */
  links: Record<string, { fromAssociation: string }>
}

export interface PluginMapping {
  objects: Record<string, MappingObject>
  /** Outside person id → ACB member id, per table (names never, ids only: 13.10). */
  people: Record<string, Record<string, string>>
  /** The company's field policies (only where they differ from the declaration's defaults). */
  policy: Record<string, FieldPolicy>
}

export const MAPPING_IMPORT_MAX = 10_000
const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

/** Fields a mapping may name: the type's server fields, and the record's title / summary. */
function mappableField(type: TypeDefinition, name: string): FieldDef | null {
  const f = type.fields[name]
  if (f && (f.source === 'server' || name === 'title' || name === 'summary')) return f
  if (!f && (name === 'title' || name === 'summary')) return { label: name, kind: 'text', source: 'file' }
  return null
}

/** Parse and validate a company's mapping against the package it configures. */
export function parsePluginMapping(text: string, pkg: { manifest: PluginManifest; types: Record<string, TypeDefinition> }): PluginParsed<PluginMapping> {
  const yaml = parseYamlLite(text)
  if (!yaml.ok) return { ok: false, errors: [`${yaml.line} 行目: ${yaml.error}`] }
  const raw = yaml.value
  if (!isYamlMap(raw)) return { ok: false, errors: ['読み替え表は「項目名: 値」の形で書いてください'] }
  const { manifest, types } = pkg
  const errors: string[] = []
  const err = (m: string) => { if (errors.length < 50) errors.push(m) }

  const people: Record<string, Record<string, string>> = {}
  const rawPeople = raw.people ?? {}
  if (!isYamlMap(rawPeople)) err('people は「表の名前: { 外の番号: メンバーの id }」の形で書いてください')
  else for (const [table, rows] of Object.entries(rawPeople)) {
    if (!ONTOLOGY_NAME_RE.test(table) || !isYamlMap(rows)) { err(`people の「${table}」は { 外の番号: メンバーの id } の形で書いてください`); continue }
    const out: Record<string, string> = {}
    for (const [ext, member] of Object.entries(rows)) {
      if (!EXTERNAL_NAME_RE.test(ext) || typeof member !== 'string' || !MEMBER_ID_RE.test(member)) err(`people の「${table}」の「${ext}」はメンバーの id で書いてください（名前は書きません）`)
      else out[ext] = member
    }
    const members = Object.values(out)
    if (new Set(members).size !== members.length) err(`people の「${table}」で、同じメンバーが2回書かれています（書き戻すときに外の番号が決まりません）`)
    people[table] = out
  }

  const objects: Record<string, MappingObject> = {}
  for (const [oname, o] of Object.entries(raw)) {
    if (oname === 'people' || oname === 'policy') continue
    const obj = manifest.objects[oname]
    const type = obj?.recordType ? types[obj.recordType] : undefined
    if (!obj || !type) { err(`「${oname}」は、このプラグインの取り込む対象ではありません`); continue }
    if (!isYamlMap(o)) { err(`「${oname}」は { … } の形で書いてください`); continue }
    unknownKeys(`「${oname}」: `, o, ['visible_to_folder', 'import', 'fields', 'links'], err)
    const writable = Object.values(manifest.operations).some(op => op.kind === 'update' && op.object === oname)

    let visibleToFolder: string | null = null
    if (o.visible_to_folder !== undefined && o.visible_to_folder !== null) {
      const p = typeof o.visible_to_folder === 'string' ? normalizeRepoPath(o.visible_to_folder) : null
      if (!p || p.startsWith('.')) err(`「${oname}」の visible_to_folder は会社のフォルダの道で書いてください`)
      else visibleToFolder = p
    }

    const imp = o.import ?? {}
    const importRule = { pipelines: [] as string[], updatedWithinDays: null as number | null, max: 500 }
    if (!isYamlMap(imp)) err(`「${oname}」の import は { pipelines, updated_within_days, max } の形で書いてください`)
    else {
      unknownKeys(`「${oname}」の import: `, imp, ['pipelines', 'updated_within_days', 'max'], err)
      const pipelines = strList(imp.pipelines)
      if (!pipelines || !pipelines.every(p => EXTERNAL_NAME_RE.test(p))) err(`「${oname}」の import.pipelines は名前の並びです`)
      else importRule.pipelines = pipelines
      const days = imp.updated_within_days
      if (days !== undefined && days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) err(`「${oname}」の import.updated_within_days は 1〜3650 の整数です`)
      else if (typeof days === 'number') importRule.updatedWithinDays = days
      const max = imp.max
      if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAPPING_IMPORT_MAX)) err(`「${oname}」の import.max は 1〜${MAPPING_IMPORT_MAX} の整数です`)
      else if (typeof max === 'number') importRule.max = max
    }

    const fields: Record<string, MappingField> = {}
    const rawFields = o.fields ?? {}
    if (!isYamlMap(rawFields)) err(`「${oname}」の fields は「欄の名前: { from, write }」の形で書いてください`)
    else for (const [fname, f] of Object.entries(rawFields)) {
      const where = `「${oname}」の欄「${fname}」`
      const def = mappableField(type, fname)
      if (!def) { err(`${where}は、型「${type.name}」のサーバーの欄ではありません`); continue }
      if (!isYamlMap(f)) { err(`${where}は { from, write } の形で書いてください`); continue }
      unknownKeys(`${where}: `, f, ['from', 'write', 'values', 'people'], err)
      if (typeof f.from !== 'string' || !EXTERNAL_NAME_RE.test(f.from)) { err(`${where}の from は外の項目名です`); continue }
      const write = f.write ?? false
      if (typeof write !== 'boolean') { err(`${where}の write は true か false です`); continue }
      if (write && !writable) err(`${where}: このプラグインには「${oname}」を書き換える操作がないため、write: true にできません`)
      if (write && def.source === 'file') err(`${where}: 件名・要約は書き戻せません`)
      if (write && MILESTONE3_UNWRITABLE_FIELDS.includes(fname)) err(`${where}: 節目3ではこの欄は書き戻せません（受注・失注への変更を承認なしにできてしまうため）。write: false にしてください`)
      let values: Record<string, string> | null = null
      if (f.values !== undefined) {
        if (def.kind !== 'choice') err(`${where}: values は選択肢の欄だけに書けます`)
        else if (!isYamlMap(f.values)) err(`${where}の values は { 外の値: ACB の値 } の形で書いてください`)
        else {
          values = {}
          for (const [ext, acb] of Object.entries(f.values)) {
            if (!EXTERNAL_NAME_RE.test(ext)) err(`${where}の values の「${ext}」は外の値として書けません`)
            else if (typeof acb !== 'string' || !def.options?.includes(acb)) err(`${where}の values の「${ext}」の右側は ${def.options?.join(' / ')} のどれかです`)
            else values[ext] = acb
          }
          const acbValues = Object.values(values)
          if (write && new Set(acbValues).size !== acbValues.length) err(`${where}: 2つの外の値が同じ ACB の値になっているため、書き戻せません（write: false にするか、1対1にしてください）`)
        }
      } else if (def.kind === 'choice') err(`${where}: 選択肢の欄には values（外の値 → ACB の値）が要ります`)
      let peopleTable: string | null = null
      if (f.people !== undefined) {
        if (def.kind !== 'person') err(`${where}: people は人の欄だけに書けます`)
        else if (typeof f.people !== 'string' || !(f.people in people)) err(`${where}の people は people にある表の名前です`)
        else peopleTable = f.people
      } else if (def.kind === 'person') err(`${where}: 人の欄には people（外の番号 → メンバーの id の表）が要ります`)
      fields[fname] = { from: f.from, write, values, people: peopleTable }
    }
    const writtenFrom = Object.values(fields).filter(f => f.write).map(f => f.from)
    if (new Set(writtenFrom).size !== writtenFrom.length) err(`「${oname}」: 同じ外の項目に2つの欄から書き戻すことはできません`)

    const links: Record<string, { fromAssociation: string }> = {}
    const rawLinks = o.links ?? {}
    if (!isYamlMap(rawLinks)) err(`「${oname}」の links は「つながりの名前: { from_association }」の形で書いてください`)
    else for (const [lname, l] of Object.entries(rawLinks)) {
      if (!type.links[lname]) { err(`「${oname}」の links の「${lname}」は型「${type.name}」のつながりではありません`); continue }
      if (!isYamlMap(l) || typeof l.from_association !== 'string' || !EXTERNAL_NAME_RE.test(l.from_association) || Object.keys(l).length !== 1) {
        err(`「${oname}」の links の「${lname}」は { from_association: 外の結びつきの名前 } の形で書いてください`)
        continue
      }
      links[lname] = { fromAssociation: l.from_association }
    }
    objects[oname] = { visibleToFolder, import: importRule, fields, links }
  }

  const policy: Record<string, FieldPolicy> = {}
  const rawPolicy = raw.policy ?? {}
  if (!isYamlMap(rawPolicy)) err('policy は「欄の名前: auto / prior / off」の形で書いてください')
  else for (const [f, p] of Object.entries(rawPolicy)) {
    if (!FIELD_POLICIES.includes(p as FieldPolicy)) { err(`policy の「${f}」は auto / prior / off です`); continue }
    if (p === 'auto' && MILESTONE3_UNWRITABLE_FIELDS.includes(f)) { err(`policy の「${f}」: 節目3ではこの欄は書き戻せないため、auto にできません`); continue }
    if (!Object.values(objects).some(o => o.fields[f])) { err(`policy の「${f}」は読み替え表にない欄です`); continue }
    if (p === 'auto' && Object.entries(objects).some(([on, o]) => o.fields[f]?.write && externalFieldWriters(manifest, on).length > 0)) {
      err(`policy の「${f}」: 社外の人に届く操作で書かれる欄は「自動」にできません`)
      continue
    }
    policy[f] = p as FieldPolicy
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { objects, people, policy } }
}

/**
 * The policy that applies when operation `operationName` writes `field`:
 * `off` unless the mapping writes it (and always for
 * `MILESTONE3_UNWRITABLE_FIELDS`), else the company's choice, else the
 * declaration's default, else `prior` — and at least as strict as any other
 * field read from the same outside property; never `auto` for an operation
 * that reaches people outside the company, whatever the settings say (0.21).
 */
export function effectiveFieldPolicy(manifest: PluginManifest, mapping: PluginMapping, operationName: string, field: string): FieldPolicy {
  const op = manifest.operations[operationName]
  if (!op || op.kind !== 'update') return 'off'
  const rule = mapping.objects[op.object]?.fields[field]
  if (!rule?.write || MILESTONE3_UNWRITABLE_FIELDS.includes(field)) return 'off'
  // Judged on the outside property written, not only the ACB field (review §5.3): every field read
  // from the same property brings its own policy, and the strictest wins (a field another field
  // reads as `prior` cannot be reached through an `auto` one).
  let chosen: FieldPolicy = mapping.policy[field] ?? manifest.fieldPolicyDefaults[field] ?? 'prior'
  for (const [other, r] of Object.entries(mapping.objects[op.object]?.fields ?? {})) {
    if (other === field || r.from !== rule.from) continue
    const theirs: FieldPolicy = MILESTONE3_UNWRITABLE_FIELDS.includes(other) ? 'off' : mapping.policy[other] ?? manifest.fieldPolicyDefaults[other] ?? 'prior'
    if (POLICY_STRICTNESS[theirs] > POLICY_STRICTNESS[chosen]) chosen = theirs
  }
  return op.reaches === 'external' && chosen === 'auto' ? 'prior' : chosen
}

const POLICY_STRICTNESS: Record<FieldPolicy, number> = { auto: 0, prior: 1, off: 2 }

/** An operation's own policy (create): never `auto` when it reaches outside people. */
export function effectiveOperationPolicy(manifest: PluginManifest, operationName: string): FieldPolicy {
  const op = manifest.operations[operationName]
  if (!op) return 'off'
  return op.reaches === 'external' && op.policy === 'auto' ? 'prior' : op.policy
}

// ── Translating values (both directions) ──

export type AcbValue = string | number | boolean | null

/** Outside values as the API returns them (HubSpot: strings). */
export type ExternalProperties = Record<string, unknown>

function toAcb(kind: FieldDef['kind'], raw: unknown): AcbValue | undefined {
  if (raw === null || raw === undefined || raw === '') return null
  const s = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined
  if (s === undefined) return undefined
  switch (kind) {
    case 'number': { const n = Number(s); return Number.isFinite(n) ? n : undefined }
    case 'boolean': return s === 'true' ? true : s === 'false' ? false : undefined
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
      if (/^\d{10,15}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10)
      return undefined
    }
    default: return s
  }
}

function toExternal(value: AcbValue): string {
  if (value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/**
 * Outside properties → ACB field values through the mapping. Values the
 * mapping cannot translate are left out and reported (`problems`: field
 * names only, never the value).
 */
export function externalToAcb(
  pkg: { manifest: PluginManifest; types: Record<string, TypeDefinition> },
  mapping: PluginMapping,
  objectName: string,
  properties: ExternalProperties,
): { values: Record<string, AcbValue>; problems: string[] } {
  const obj = mapping.objects[objectName]
  const type = pkg.types[pkg.manifest.objects[objectName]?.recordType ?? '']
  const values: Record<string, AcbValue> = {}
  const problems: string[] = []
  if (!obj || !type) return { values, problems: [`「${objectName}」は読み替え表にありません`] }
  for (const [field, rule] of Object.entries(obj.fields)) {
    const def = mappableField(type, field)!
    const raw = properties[rule.from]
    if (raw === undefined) continue
    if (raw === null || raw === '') { values[field] = null; continue }
    if (rule.values) {
      const v = typeof raw === 'string' || typeof raw === 'number' ? rule.values[String(raw)] : undefined
      if (v === undefined) problems.push(`欄「${field}」: 読み替え表にない値です`)
      else values[field] = v
      continue
    }
    if (rule.people) {
      const member = typeof raw === 'string' || typeof raw === 'number' ? mapping.people[rule.people]?.[String(raw)] : undefined
      if (member === undefined) problems.push(`欄「${field}」: 担当者の対応表にない番号です`)
      else values[field] = member
      continue
    }
    const v = toAcb(def.kind, raw)
    if (v === undefined) problems.push(`欄「${field}」: 値を読めません`)
    else values[field] = v
  }
  return { values, problems }
}

/**
 * ACB field values → the outside properties to write. Only fields the
 * mapping writes; anything else is refused (no partial write).
 */
export function acbToExternal(
  pkg: { manifest: PluginManifest; types: Record<string, TypeDefinition> },
  mapping: PluginMapping,
  objectName: string,
  changes: Record<string, AcbValue>,
): { ok: true; properties: Record<string, string> } | { ok: false; errors: string[] } {
  const obj = mapping.objects[objectName]
  const type = pkg.types[pkg.manifest.objects[objectName]?.recordType ?? '']
  if (!obj || !type) return { ok: false, errors: [`「${objectName}」は読み替え表にありません`] }
  const properties: Record<string, string> = {}
  const errors: string[] = []
  for (const [field, value] of Object.entries(changes)) {
    const rule = obj.fields[field]
    if (!rule?.write) { errors.push(`欄「${field}」は書き戻さない欄です`); continue }
    const def = mappableField(type, field)!
    if (rule.values) {
      const ext = Object.entries(rule.values).find(([, acb]) => acb === value)?.[0]
      if (ext === undefined) errors.push(`欄「${field}」: 読み替え表にない値です`)
      else properties[rule.from] = ext
      continue
    }
    if (rule.people) {
      const ext = Object.entries(mapping.people[rule.people] ?? {}).find(([, m]) => m === value)?.[0]
      if (ext === undefined) errors.push(`欄「${field}」: 担当者の対応表にないメンバーです`)
      else properties[rule.from] = ext
      continue
    }
    const kindOk = value === null
      || (def.kind === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : def.kind === 'boolean' ? typeof value === 'boolean'
          : def.kind === 'date' ? typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
            : typeof value === 'string')
    if (!kindOk) { errors.push(`欄「${field}」の値の種類が違います（${def.kind}）`); continue }
    properties[rule.from] = toExternal(value)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, properties }
}

/** One outside property as its system lists it (HubSpot `GET …/properties/deals`). */
export interface ExternalPropertyInfo {
  name: string
  /** The system will not take a written value (read-only or computed). */
  readOnly: boolean
  /** Allowed values of an enumeration; null for free values. */
  options: string[] | null
}

/**
 * The mapping against the outside system's real property list (「HubSpot に
 * 聞いて確かめる」): unknown properties and values are errors, writing a
 * read-only property is an error, writing one the system sets by itself is a
 * warning.
 */
export function checkMappingAgainstProperties(
  manifest: PluginManifest,
  mapping: PluginMapping,
  objectName: string,
  properties: readonly ExternalPropertyInfo[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const byName = new Map(properties.map(p => [p.name, p]))
  const auto = new Set(manifest.objects[objectName]?.autoProperties ?? [])
  for (const [field, rule] of Object.entries(mapping.objects[objectName]?.fields ?? {})) {
    const p = byName.get(rule.from)
    if (!p) { errors.push(`欄「${field}」の項目「${rule.from}」は、つなぎ先にありません`); continue }
    if (rule.write && p.readOnly) errors.push(`欄「${field}」の項目「${rule.from}」は、つなぎ先で書き換えられない項目です（write: false にしてください）`)
    if (rule.write && auto.has(rule.from)) warnings.push(`欄「${field}」の項目「${rule.from}」は、つなぎ先が自動で決める項目です。書き込むと、その件だけ自動で決まらなくなります`)
    if (rule.values && p.options) {
      for (const ext of Object.keys(rule.values)) if (!p.options.includes(ext)) errors.push(`欄「${field}」の値「${ext}」は、つなぎ先の選択肢にありません`)
    }
  }
  return { errors, warnings }
}
