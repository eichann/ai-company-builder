/**
 * A whole package (`validatePluginPackage`: the declaration with its type
 * files and the place of its mapping) and what runs for a business plugin
 * (`combineUse`: its use of one connector version, combined).
 */
import {
  PLUGIN_ACTORS, comparePluginVersions, externalFieldWriters,
  type PluginManifest, type PluginObject, type PluginOperation, type PluginPackage, type PluginParsed,
} from './plugin-declaration'
import { parsePluginManifest } from './plugin-manifest'
import { parseTypeFile, type TypeDefinition } from './record-types'

/**
 * A whole package as found on the shelf: the declaration and the type files
 * it lists (exactly those; a business plugin only). A business plugin's
 * recommended mapping (`mapping.yaml`) is checked against the connector it is
 * used with (`combineUse`, then `parsePluginMapping`), so here only its place
 * is: a connector has none, nor does a business plugin without `connector`.
 */
export function validatePluginPackage(input: { manifest: string; types: Record<string, string>; mapping?: string | null }): PluginParsed<PluginPackage> {
  const m = parsePluginManifest(input.manifest)
  if (!m.ok) return m
  const manifest = m.value
  const errors: string[] = []
  if (manifest.role === 'connector') {
    if (Object.keys(input.types).length > 0) errors.push('つなぎ先のプラグインは型（types/）を持ちません。型は業務のプラグインが持ちます')
    if (input.mapping != null) errors.push('つなぎ先のプラグインに読み替え表（mapping.yaml）は置けません。読み替えは、つなぎ先を使う業務のプラグインが持ちます')
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { manifest, types: {} } }
  }
  const owned: Record<string, TypeDefinition> = {}
  for (const name of Object.keys(input.types)) {
    if (!manifest.types.includes(name)) errors.push(`types/${name}.md は宣言の types にありません`)
  }
  for (const name of manifest.types) {
    const text = input.types[name]
    if (text === undefined) { errors.push(`型「${name}」のファイル types/${name}.md がありません`); continue }
    const t = parseTypeFile(name, text)
    if (!t.ok) errors.push(...t.errors.map(e => `types/${name}.md: ${e}`))
    else if (t.definition.storage !== 'server') errors.push(`型「${name}」: 取り込んだ記録はファイルを作らないため、storage は server です`)
    else owned[name] = t.definition
  }
  if (input.mapping != null && !manifest.uses) errors.push('つなぎ先を使わない業務のプラグイン（connector のないもの）に読み替え表（mapping.yaml）は置けません')
  if (errors.length === 0) {
    const allFields = new Set(Object.values(owned).flatMap(t => Object.keys(t.fields)))
    for (const f of Object.keys(manifest.fieldPolicyDefaults)) {
      if (!allFields.has(f)) errors.push(`field_policy_defaults の「${f}」は、どの型の欄でもありません`)
    }
    for (const [opname, use] of Object.entries(manifest.uses?.operations ?? {})) {
      const persons = new Set(Object.values(owned).flatMap(t => Object.entries(t.fields).filter(([, f]) => f.kind === 'person').map(([n]) => n)))
      for (const w of use.who) {
        if (!persons.has(w) && !(PLUGIN_ACTORS as readonly string[]).includes(w)) errors.push(`操作「${opname}」の who「${w}」は人の欄でも ${PLUGIN_ACTORS.join(' / ')} でもありません`)
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { manifest, types: owned } }
}

/**
 * A business plugin's use of one connector version, combined (owner decision
 * 2026-11-01): the connector's facts (service, destination, calls, account
 * check, each operation's shape) with the business plugin's choices (which
 * objects become which of its types, which operations it uses, who may run
 * them, its field policy defaults). The result is what runs for that business
 * plugin: its `id` and `version` are the business plugin's, its `label` the
 * connector's (the outside system's name), and **only the operations and
 * objects the business plugin declared are in it** — another business plugin
 * using the same connector gets its own combination, never this one's.
 * Refused when the connector is another one, too old, or lacks what is used.
 */
export function combineUse(business: PluginPackage, connector: PluginManifest): PluginParsed<PluginPackage> {
  const b = business.manifest
  const uses = b.uses
  const errors: string[] = []
  if (b.role !== 'business' || !uses) return { ok: false, errors: [`「${b.label}」は、つなぎ先を使いません`] }
  if (connector.role !== 'connector' || connector.id !== uses.connector.id) return { ok: false, errors: [`「${b.label}」が使うつなぎ先は ${uses.connector.id} です`] }
  if (comparePluginVersions(connector.version, uses.connector.minVersion) < 0) {
    return { ok: false, errors: [`「${b.label}」には「${connector.label}」${uses.connector.minVersion} 以上が要ります（いまは ${connector.version}）`] }
  }
  const types = business.types
  const objects: Record<string, PluginObject> = {}
  const useObject = (name: string): PluginObject | null => {
    const o = connector.objects[name]
    if (!o) return null
    objects[name] ??= { ...o, recordType: uses.objects[name]?.recordType ?? null }
    return objects[name]
  }
  for (const name of Object.keys(uses.objects)) {
    if (!useObject(name)) errors.push(`対象「${name}」は「${connector.label}」${connector.version} にありません`)
  }
  const operations: Record<string, PluginOperation> = {}
  for (const [opname, use] of Object.entries(uses.operations)) {
    const where = `操作「${opname}」`
    const op = connector.operations[opname]
    if (!op) { errors.push(`${where}は「${connector.label}」${connector.version} にありません`); continue }
    const obj = useObject(op.object)!
    const target = op.attachTo ? useObject(op.attachTo) : null
    const recordObject = op.kind === 'create' && op.attachTo ? target : obj
    if (!recordObject?.recordType) {
      errors.push(`${where}: 対象「${op.kind === 'create' && op.attachTo ? op.attachTo : op.object}」を objects でこの業務の型（record_type）にしてください`)
      continue
    }
    const type = types[recordObject.recordType]
    const persons = new Set(Object.entries(type?.fields ?? {}).filter(([, f]) => f.kind === 'person').map(([n]) => n))
    for (const w of use.who) {
      if (!persons.has(w) && !(PLUGIN_ACTORS as readonly string[]).includes(w)) errors.push(`${where}の who「${w}」は型「${recordObject.recordType}」の人の欄でも ${PLUGIN_ACTORS.join(' / ')} でもありません`)
    }
    if (use.decision && op.kind === 'read') errors.push(`${where}: 読む操作は decision にできません`)
    if (use.policy !== null && op.kind !== 'create') errors.push(`${where}: policy は作る操作だけに書けます（書き換えの決まりは欄ごと：field_policy_defaults と読み替え表）`)
    const policy = use.policy ?? op.policy
    if (op.reaches === 'external' && policy === 'auto') errors.push(`${where}: 社外の人に届く操作は「自動」にできません`)
    if (op.createsRecord && policy === 'auto') errors.push(`${where}: 記録を新しく作る操作は「自動」にできません（必ず人が承認します）`)
    operations[opname] = { ...op, who: [...use.who], decision: use.decision, note: use.note, policy }
  }
  if (errors.length === 0) {
    for (const [f, p] of Object.entries(b.fieldPolicyDefaults)) {
      if (p === 'auto' && externalFieldWriters({ operations }).length > 0) errors.push(`欄「${f}」: 社外の人に届く書き換えの操作があるため、欄の決まりを「自動」にできません`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      types,
      manifest: {
        ...b,
        label: connector.label,
        service: connector.service,
        baseUrl: connector.baseUrl,
        scopes: connector.scopes,
        operationScopes: Object.fromEntries(Object.entries(connector.operationScopes).filter(([n]) => n in operations)),
        objects,
        operations,
        accountInfo: connector.accountInfo,
      },
    },
  }
}
