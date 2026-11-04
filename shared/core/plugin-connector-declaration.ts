/**
 * A connector's part of `plugin.yaml` (owner decision 2026-11-01, plugins.md
 * "Two roles"): its one destination, its objects (the fixed calls) and its
 * operations — generic windows on the service, knowing no business plugin.
 * What belongs to a business plugin is refused with where it goes now.
 */
import { builtinBrokerService, isValidBrokerServiceName, parseRelayBaseUrl } from './key-broker'
import { parseConnectorV3 } from './plugin-call-declaration'
import {
  CREATE_CONTENT_SLOTS, PLUGIN_CONTRACT_V3, PLUGIN_ENDPOINTS, noFlow,
  type CommonPart, type CreateContentSlot, type OperationReach, type PluginEndpoint, type PluginEndpointName, type PluginManifest,
  type PluginObject, type PluginOperation, type PluginSearch, type UndoKind,
} from './plugin-declaration'
import { checkPluginPathTemplate, EXTERNAL_NAME_RE, isStr, SCOPE_RE, strList, unknownKeys } from './plugin-declaration-rules'
import { parseNotificationSender } from './notification-senders'
import { ONTOLOGY_NAME_RE } from './record-types'
import { isYamlMap, type YamlValue } from './yaml-lite'

export const CONNECTOR_KEYS: readonly string[] = ['service', 'base_url', 'account_info', 'scopes', 'operation_scopes', 'objects', 'operations', 'notification_senders']

/** At most this many `notification_senders` entries per connector. */
export const NOTIFICATION_SENDERS_MAX = 20

/** What a connector refuses, with where it belongs now (owner decision 2026-11-01: a connector knows no business plugin). */
export const NOT_IN_CONNECTOR: Record<string, string> = {
  types: 'つなぎ先のプラグインは型を持ちません。型は業務のプラグインが持ちます',
  maps_to: 'maps_to はなくなりました。つなぎ先はどの業務のプラグインにも縛られず、業務のプラグインが「connector: <つなぎ先> >= <版>」で使います',
  field_policy_defaults: '欄の決まりは、つなぎ先を使う業務のプラグインに書きます',
  connector: 'connector は業務のプラグインに書きます',
}
const NOT_IN_CONNECTOR_OBJECT: Record<string, string> = {
  record_type: 'record_type は、つなぎ先を使う業務のプラグインの objects に書きます（つなぎ先はどの業務の型も知りません）',
}
const operationUseKeyReason = (k: string) => `「${k}」は、つなぎ先を使う業務のプラグインの operations に書きます（誰がどう使うかは業務が決めます）`
const NOT_IN_CONNECTOR_OPERATION: Record<string, string> = {
  who: operationUseKeyReason('who'), decision: operationUseKeyReason('decision'), note: operationUseKeyReason('note'), policy: operationUseKeyReason('policy'),
  moves_money: operationUseKeyReason('moves_money'),
  fields: 'fields は書きません（書き戻せる欄は、業務のプラグインの読み替え表で「書く」にした欄です）',
}

/** A connector: one destination, its objects (calls) and operations (generic windows on the service). */
export function parseConnector(raw: { [k: string]: YamlValue }, err: (m: string) => void, common: CommonPart): PluginManifest {
  let baseUrl = { host: '', basePath: '' }
  if (!isValidBrokerServiceName(raw.service)) err('service に「API キー」のサービス名を書いてください')
  const base = parseRelayBaseUrl(raw.base_url)
  if ('error' in base) err(`base_url: ${base.error}`)
  else {
    baseUrl = base.value
    const builtin = typeof raw.service === 'string' ? builtinBrokerService(raw.service) : undefined
    if (builtin && !builtin.defaultHosts.includes(baseUrl.host)) err(`base_url の送り先は ${builtin.defaultHosts.join(' / ')} です（サービス ${builtin.service} の送り先）`)
  }

  const scopes = strList(raw.scopes)
  if (!scopes || !scopes.every(s => SCOPE_RE.test(s))) err('scopes は権限の名前の並びで書いてください')

  const objects: Record<string, PluginObject> = {}
  const rawObjects = raw.objects ?? {}
  if (!isYamlMap(rawObjects)) err('objects は「名前: { … }」の形で書いてください')
  else for (const [oname, o] of Object.entries(rawObjects)) {
    if (!ONTOLOGY_NAME_RE.test(oname)) { err(`対象の名前「${oname}」は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(o)) { err(`対象「${oname}」は { … } の形で書いてください`); continue }
    unknownKeys(`対象「${oname}」: `, o, ['auto_properties', ...Object.keys(PLUGIN_ENDPOINTS)], err, NOT_IN_CONNECTOR_OBJECT)
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
    objects[oname] = { recordType: null, endpoints, autoProperties: autoProperties ?? [] }
  }

  const operations: Record<string, PluginOperation> = {}
  const searches: Record<string, PluginSearch> = {}
  const rawOps = raw.operations ?? {}
  if (!isYamlMap(rawOps)) err('operations は「名前: { … }」の形で書いてください')
  else for (const [opname, op] of Object.entries(rawOps)) {
    if (!ONTOLOGY_NAME_RE.test(opname)) { err(`操作の名前「${opname}」は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(op)) { err(`操作「${opname}」は { … } の形で書いてください`); continue }
    if (op.kind === 'search') {
      const s = parseSearch(`操作「${opname}」`, op, objects, err)
      if (s) searches[opname] = s
      continue
    }
    unknownKeys(`操作「${opname}」: `, op, ['label', 'kind', 'object', 'attach_to', 'reaches', 'undo', 'content', 'association_type', 'correlation_property'], err, NOT_IN_CONNECTOR_OPERATION)
    const where = `操作「${opname}」`
    if (!isStr(op.label)) err(`${where}に label を書いてください`)
    const opKind = op.kind
    if (opKind !== 'read' && opKind !== 'update' && opKind !== 'create') { err(`${where}の kind は read / update / create / search です`); continue }
    const obj = typeof op.object === 'string' ? objects[op.object] : undefined
    if (!obj) { err(`${where}の object は objects にある名前です`); continue }
    const reaches = op.reaches ?? 'internal'
    if (reaches !== 'internal' && reaches !== 'external') err(`${where}の reaches は internal か external です`)
    const undo = op.undo ?? 'none'
    if (undo !== 'none' && undo !== 'restore_previous' && undo !== 'archive') err(`${where}の undo は restore_previous / archive / none です`)
    let attachTo: string | null = null
    const content: Partial<Record<CreateContentSlot, string>> = {}
    let associationType: number | null = null
    let correlationProperty: string | null = null
    let createsRecord = false
    if (opKind !== 'create' && (op.content !== undefined || op.association_type !== undefined || op.correlation_property !== undefined)) {
      err(`${where}: content / association_type / correlation_property は作る操作だけに書けます`)
    }
    if (opKind === 'read') {
      if (!obj.endpoints.get) err(`${where}: 読む操作の対象には get が要ります`)
      if (op.attach_to !== undefined || op.undo !== undefined) err(`${where}: 読む操作に attach_to / undo は書けません`)
    } else if (opKind === 'update') {
      if (!obj.endpoints.get || !obj.endpoints.update) err(`${where}: 書き換える操作の対象には get と update が要ります`)
      if (undo === 'archive') err(`${where}: 書き換えの戻し方は restore_previous か none です`)
      if (op.attach_to !== undefined) err(`${where}: attach_to は作る操作だけに書けます`)
    } else {
      if (!obj.endpoints.create) err(`${where}: 作る操作の対象には create が要ります`)
      if (undo === 'restore_previous') err(`${where}: 作ったものの戻し方は archive か none です`)
      if (undo === 'archive' && !obj.endpoints.archive) err(`${where}: undo: archive には対象の archive が要ります`)
      if (typeof op.correlation_property !== 'string' || !EXTERNAL_NAME_RE.test(op.correlation_property)) {
        err(`${where}: 作る操作には correlation_property（ACB の操作の番号を書き込む、外の「一意の値」の項目名）が要ります`)
      } else correlationProperty = op.correlation_property
      if (op.attach_to === undefined) {
        // Creates an item that becomes a record of the object's type (create_deal) — the type is the using business plugin's.
        createsRecord = true
        if (!obj.endpoints.get) err(`${where}: 記録を作る操作の対象には get が要ります`)
        if (op.content !== undefined || op.association_type !== undefined) err(`${where}: 記録を作る操作に content / association_type は書けません`)
      } else {
        const target = typeof op.attach_to === 'string' ? objects[op.attach_to] : undefined
        if (!target?.endpoints.get) err(`${where}の attach_to は get のある対象の名前です`)
        else attachTo = op.attach_to as string
        if (!isYamlMap(op.content) || Object.keys(op.content).length === 0) err(`${where}の content は「${CREATE_CONTENT_SLOTS.join(' / ')}: 外の項目名」の形で書いてください`)
        else for (const [slot, prop] of Object.entries(op.content)) {
          if (!(CREATE_CONTENT_SLOTS as readonly string[]).includes(slot)) err(`${where}の content の「${slot}」は ${CREATE_CONTENT_SLOTS.join(' / ')} のどれかです`)
          else if (typeof prop !== 'string' || !EXTERNAL_NAME_RE.test(prop)) err(`${where}の content の「${slot}」は外の項目名です`)
          else content[slot as CreateContentSlot] = prop
        }
        const at = op.association_type
        if (typeof at !== 'number' || !Number.isInteger(at) || at < 1 || at > 1_000_000) err(`${where}の association_type は外の結びつきの種類の番号です（例：212）`)
        else associationType = at
      }
    }
    operations[opname] = {
      label: isStr(op.label) ? op.label : opname,
      kind: opKind,
      object: op.object as string,
      who: [],
      // An update writes the mapping's `write: true` fields; a create of a record fills them (the user's mapping).
      fields: opKind === 'update' || createsRecord ? 'mapped' : null,
      attachTo,
      reaches: reaches as OperationReach,
      undo: undo as UndoKind,
      note: 'none',
      policy: reaches === 'external' || createsRecord ? 'prior' : 'auto',
      decision: false,
      content,
      associationType,
      correlationProperty,
      createsRecord,
      movesMoney: false,
    }
  }

  // Contract 3's calls sit beside `operations`: an operation's kinds stay read / update / create (a released app reads them).
  const v3 = common.contract >= PLUGIN_CONTRACT_V3 ? parseConnectorV3(raw, err) : {}
  for (const name of Object.keys(v3.calls ?? {})) {
    if (name in operations || name in searches) err(`呼び出し「${name}」: 同じ名前の操作があります（AI の道具の名前が重なります）`)
  }
  const acts = Object.values(v3.calls ?? {}).some(c => c.kind === 'act')

  let accountInfo: PluginManifest['accountInfo'] = null
  if (raw.account_info !== undefined) {
    const e = raw.account_info
    if (!isYamlMap(e)) err('account_info は { method: GET, path } の形で書いてください')
    else {
      const atV3 = common.contract >= PLUGIN_CONTRACT_V3
      unknownKeys('account_info: ', e, ['method', 'path', ...(atV3 ? ['id_field'] : [])], err, { id_field: `id_field は contract: ${PLUGIN_CONTRACT_V3} の包みだけに書けます` })
      const problem = e.method !== 'GET' ? 'account_info の method は GET です' : checkPluginPathTemplate(e.path, 'properties_list')
      if (problem) err(`account_info: ${problem}`)
      else accountInfo = { method: 'GET', path: e.path as string }
      if (atV3 && e.id_field !== undefined) {
        if (typeof e.id_field !== 'string' || !EXTERNAL_NAME_RE.test(e.id_field)) err('account_info の id_field は項目名です')
        else if (accountInfo) accountInfo = { ...accountInfo, idField: e.id_field }
      }
    }
  }
  if (!accountInfo && (acts || Object.values(operations).some(op => op.kind !== 'read'))) {
    err('書き込む操作があるプラグインには account_info（鍵がどのアカウントのものかを読む道）が要ります')
  }
  // A call has no HubSpot-shaped answer to fall back on: the account must be named, or nothing binds the connection.
  if (acts && accountInfo && !accountInfo.idField) err('act の呼び出しがあるプラグインの account_info には id_field（アカウントの番号の項目名）が要ります')

  const operationScopes: Record<string, string[]> = {}
  const rawOpScopes = raw.operation_scopes ?? {}
  if (!isYamlMap(rawOpScopes)) err('operation_scopes は「操作の名前: [権限…]」の形で書いてください')
  else for (const [opname, list] of Object.entries(rawOpScopes)) {
    const l = strList(list)
    if (!(opname in operations)) err(`operation_scopes の「${opname}」は operations にありません`)
    else if (!l || l.length === 0 || !l.every(s => SCOPE_RE.test(s))) err(`operation_scopes の「${opname}」は権限の名前の並びで書いてください`)
    else operationScopes[opname] = l
  }

  // The service's own notification mails (owner FB #18, notification-senders.ts): the mail intake
  // leaves them out while the connector is installed and on. Addresses or `@domain`.
  let notificationSenders: string[] | null = null
  if (raw.notification_senders !== undefined) {
    const list = strList(raw.notification_senders)
    const parsed = list?.map(parseNotificationSender) ?? null
    if (!parsed || parsed.length > NOTIFICATION_SENDERS_MAX || parsed.some(e => e === null)) {
      err(`notification_senders は知らせのメールの送り主（アドレスか「@ドメイン」）の並びで書いてください（${NOTIFICATION_SENDERS_MAX} 個まで）`)
    } else notificationSenders = [...new Set(parsed as string[])]
  }

  return {
    ...common, role: 'connector', service: raw.service as string, baseUrl, scopes: scopes ?? [], operationScopes,
    types: [], objects, operations, ...(Object.keys(searches).length > 0 ? { searches } : {}), ...v3, fieldPolicyDefaults: {}, uses: null, accountInfo, ...noFlow(),
    ...(notificationSenders && notificationSenders.length > 0 ? { notificationSenders } : {}),
  }
}

/**
 * `kind: search` (owner decision 2026-11-02, plugins.md "Similar records"): a
 * read-only search on an object with a `search` call, used only through a
 * business plugin's `similar` before a create of a record. `counterpart: {
 * object, property }`: the connector object that is the 相手 and the outside
 * filter property matching an item to it (HubSpot: `associations.company`).
 */
function parseSearch(where: string, op: { [k: string]: YamlValue }, objects: Record<string, PluginObject>, err: (m: string) => void): PluginSearch | null {
  unknownKeys(`${where}: `, op, ['label', 'kind', 'object', 'counterpart'], err, NOT_IN_CONNECTOR_OPERATION)
  if (!isStr(op.label)) err(`${where}に label を書いてください`)
  const obj = typeof op.object === 'string' ? objects[op.object] : undefined
  if (!obj) { err(`${where}の object は objects にある名前です`); return null }
  if (!obj.endpoints.search) { err(`${where}: 探す操作の対象には search が要ります`); return null }
  let counterpart: PluginSearch['counterpart'] = null
  if (op.counterpart !== undefined) {
    const c = op.counterpart
    if (!isYamlMap(c)) { err(`${where}の counterpart は { object: 相手の対象, property: 外の絞り込みの項目名 } の形で書いてください`); return null }
    unknownKeys(`${where}の counterpart: `, c, ['object', 'property'], err)
    if (typeof c.object !== 'string' || !objects[c.object]) { err(`${where}の counterpart の object は objects にある名前です`); return null }
    if (typeof c.property !== 'string' || !EXTERNAL_NAME_RE.test(c.property)) { err(`${where}の counterpart の property は外の項目名です（例：associations.company）`); return null }
    counterpart = { object: c.object, property: c.property }
  }
  return { label: isStr(op.label) ? op.label : '', object: op.object as string, counterpart }
}
