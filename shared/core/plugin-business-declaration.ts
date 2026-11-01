/**
 * A business plugin's part of `plugin.yaml` (owner decision 2026-11-01,
 * plugins.md "Two roles"): the types it owns and, optionally, how it uses one
 * connector (`connector: <id> >= <version>`, the objects that become its
 * types, the operations it uses and who may run them) and its recommended
 * field policies. It never talks to the outside on its own.
 */
import { CORE_TYPE_FILES } from './core-types'
import {
  FIELD_POLICIES, PLUGIN_ACTORS, PLUGIN_CONTRACT_V2, PLUGIN_ID_RE, ROLE_WHO_PREFIX, noFlow, PLUGIN_VERSION_RE, PRIOR_ONLY_FIELDS,
  type CommonPart, type ConnectorUse, type FieldPolicy, type PluginManifest,
} from './plugin-declaration'
import { strList, typeNameLayerProblem, unknownKeys } from './plugin-declaration-rules'
import { ONTOLOGY_NAME_RE, type NoteRule } from './record-types'
import { isYamlMap, type YamlValue } from './yaml-lite'

export const BUSINESS_KEYS: readonly string[] = ['types', 'connector', 'objects', 'operations', 'field_policy_defaults']

/** What a business plugin refuses: it talks to the outside only through a connector. */
export const NOT_IN_BUSINESS: Record<string, string> = Object.fromEntries(
  ['service', 'base_url', 'account_info', 'scopes', 'operation_scopes', 'maps_to'].map(k => [k, `「${k}」はつなぎ先のプラグイン（service のあるもの）だけに書けます。業務のプラグインは connector でつなぎ先を使います`]),
)

/** `connector: <id> >= <version>` — the connector a business plugin can use, from that version on. */
function parseConnectorRef(v: YamlValue | undefined): { id: string; minVersion: string } | null {
  const m = typeof v === 'string' ? /^([a-z][a-z0-9-]*)\s*>=\s*(\S+)$/.exec(v.trim()) : null
  return m && PLUGIN_ID_RE.test(m[1]) && m[1].length <= 40 && PLUGIN_VERSION_RE.test(m[2]) ? { id: m[1], minVersion: m[2] } : null
}

/** A business plugin: the types it owns and, optionally, how it uses one connector. */
export function parseBusiness(raw: { [k: string]: YamlValue }, err: (m: string) => void, common: CommonPart): PluginManifest {
  const id = common.id
  const types = strList(raw.types)
  if (!types || !types.every(t => ONTOLOGY_NAME_RE.test(t))) err('types は型の名前の並びで書いてください')
  else if (types.length === 0) err('業務のプラグインには types（持つ型の名前）が要ります')
  else for (const t of types) {
    const problem = typeNameLayerProblem(t, typeof id === 'string' ? id : undefined)
    if (problem) err(problem)
    // Exactly one owner per type name: the core's types are the core's.
    else if (Object.prototype.hasOwnProperty.call(CORE_TYPE_FILES, t)) err(`型「${t}」は本体の型です。業務のプラグインは同じ名前の型を持てません`)
  }

  let uses: ConnectorUse | null = null
  if (raw.connector === undefined) {
    for (const k of ['objects', 'operations', 'field_policy_defaults']) {
      if (raw[k] !== undefined) err(`「${k}」は、つなぎ先を使う業務のプラグイン（connector のあるもの）だけに書けます`)
    }
  } else {
    const connector = parseConnectorRef(raw.connector)
    if (!connector) err('connector は「つなぎ先の id >= 版」で書いてください（例：hubspot >= 0.3.0）')
    else if (connector.id === id) err('connector に自分自身は書けません')
    const objects: ConnectorUse['objects'] = {}
    const rawObjects = raw.objects ?? {}
    if (!isYamlMap(rawObjects)) err('objects は「つなぎ先の対象: { record_type: 型 }」の形で書いてください')
    else for (const [oname, o] of Object.entries(rawObjects)) {
      if (!ONTOLOGY_NAME_RE.test(oname)) { err(`対象の名前「${oname}」は英小文字・数字・_ で書いてください`); continue }
      if (!isYamlMap(o)) { err(`対象「${oname}」は { record_type: 型 } の形で書いてください（型にしないものは {}）`); continue }
      unknownKeys(`対象「${oname}」: `, o, ['record_type'], err)
      let recordType: string | null = null
      if (o.record_type !== undefined && o.record_type !== null) {
        if (typeof o.record_type !== 'string' || !(types ?? []).includes(o.record_type)) err(`対象「${oname}」の record_type は、この業務のプラグインの types にある型です`)
        else recordType = o.record_type
      }
      objects[oname] = { recordType }
    }
    const operations: ConnectorUse['operations'] = {}
    const rawOps = raw.operations ?? {}
    if (!isYamlMap(rawOps)) err('operations は「つなぎ先の操作: { who, … }」の形で書いてください')
    else for (const [opname, op] of Object.entries(rawOps)) {
      const where = `操作「${opname}」`
      if (!ONTOLOGY_NAME_RE.test(opname)) { err(`操作の名前「${opname}」は英小文字・数字・_ で書いてください`); continue }
      if (!isYamlMap(op)) { err(`${where}は { who, … } の形で書いてください`); continue }
      unknownKeys(`${where}: `, op, ['who', 'decision', 'note', 'policy'], err)
      const who = strList(op.who)
      // `role:<name>` (a declared role) only from contract 2 on; parseFlow checks the name is declared.
      const whoNameOk = (w: string) => ONTOLOGY_NAME_RE.test(w) || (common.contract >= PLUGIN_CONTRACT_V2 && w.startsWith(ROLE_WHO_PREFIX) && ONTOLOGY_NAME_RE.test(w.slice(ROLE_WHO_PREFIX.length)))
      if (!who || who.length === 0 || !who.every(whoNameOk)) err(`${where}の who は人の欄の名前か ${PLUGIN_ACTORS.join(' / ')} で書いてください`)
      else if (who.includes('anyone')) err(`${where}の who に anyone は書けません。記録を読める人なら viewer です`)
      const decision = op.decision ?? false
      if (typeof decision !== 'boolean') err(`${where}の decision は true か false です`)
      const note = op.note ?? 'none'
      if (note !== 'none' && note !== 'optional' && note !== 'required') err(`${where}の note は none / optional / required です`)
      let policy: FieldPolicy | null = null
      if (op.policy !== undefined) {
        if (!FIELD_POLICIES.includes(op.policy as FieldPolicy)) err(`${where}の policy は auto / prior / off です`)
        else policy = op.policy as FieldPolicy
      }
      operations[opname] = { who: who ?? [], decision: decision === true, note: note as NoteRule, policy }
    }
    if (Object.keys(operations).length === 0 && Object.keys(objects).length === 0) err('connector を書いたら、使う objects か operations を書いてください')
    if (connector) uses = { connector, objects, operations }
  }

  const fieldPolicyDefaults: Record<string, FieldPolicy> = {}
  const rawDefaults = raw.field_policy_defaults ?? {}
  if (!isYamlMap(rawDefaults)) err('field_policy_defaults は「欄の名前: auto / prior / off」の形で書いてください')
  else for (const [f, p] of Object.entries(rawDefaults)) {
    if (!ONTOLOGY_NAME_RE.test(f) || !FIELD_POLICIES.includes(p as FieldPolicy)) err(`field_policy_defaults の「${f}」は auto / prior / off です`)
    else if (p === 'auto' && PRIOR_ONLY_FIELDS.includes(f)) err(`field_policy_defaults の「${f}」: この欄は受注・失注につながるため、承認なし（auto）にできません`)
    else fieldPolicyDefaults[f] = p as FieldPolicy
  }

  return {
    ...common, role: 'business', service: '', baseUrl: { host: '', basePath: '' }, scopes: [], operationScopes: {},
    types: types ?? [], objects: {}, operations: {}, fieldPolicyDefaults, uses, accountInfo: null, ...noFlow(),
  }
}
