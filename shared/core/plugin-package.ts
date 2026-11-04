/**
 * A whole package (`validatePluginPackage`: the declaration with its type
 * files and the place of its mapping) and what runs for a business plugin
 * (`combineUse`: its use of one connector version, combined).
 */
import { coreTypeDefinitions } from './core-types'
import {
  PLUGIN_ACTORS, PLUGIN_CONTRACT_V2, comparePluginVersions, priorFieldWriters, roleOfWho,
  type OperationUse, type PluginCall, type PluginEvent, type PluginManifest, type PluginStatePoint, type PluginObject, type PluginOperation, type PluginPackage, type PluginParsed,
  type SimilarRule,
} from './plugin-declaration'
import { parsePluginManifest } from './plugin-manifest'
import { isMoneyField, parseTypeFile, type TypeDefinition } from './record-types'

/**
 * A whole package as found on the shelf: the declaration and the type files
 * it lists (exactly those; a business plugin only). A business plugin's
 * recommended mapping (`mapping.yaml`) is checked against the connector it is
 * used with (`combineUse`, then `parsePluginMapping`), so here only its place
 * is: a connector has none, nor does a business plugin without `connector`.
 */
export function validatePluginPackage(input: {
  manifest: string
  types: Record<string, string>
  mapping?: string | null
  /** Contract 2: `steps/<file>.md` → its text. */
  steps?: Record<string, string>
  /** Contract 2: the paths of the files under `ui/` (`ui/index.html`, `ui/app.js`…). */
  ui?: readonly string[]
}): PluginParsed<PluginPackage> {
  const m = parsePluginManifest(input.manifest)
  if (!m.ok) return m
  const manifest = m.value
  const errors: string[] = []
  const stepFiles = Object.keys(input.steps ?? {})
  const uiFiles = input.ui ?? []
  if (manifest.contract < PLUGIN_CONTRACT_V2 || manifest.role === 'connector') {
    const why = manifest.role === 'connector' ? 'つなぎ先のプラグインには' : `contract: ${manifest.contract} の包みには`
    if (stepFiles.length > 0) errors.push(`${why}手順書（steps/）は置けません`)
    if (uiFiles.length > 0) errors.push(`${why}画面（ui/）は置けません`)
  }
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
    for (const [f, p] of Object.entries(manifest.fieldPolicyDefaults)) {
      if (!allFields.has(f)) errors.push(`field_policy_defaults の「${f}」は、どの型の欄でもありません`)
      // A money field asks first whichever operation writes it (plugins.md "Money"): `auto` cannot be written.
      else if (p === 'auto' && Object.values(owned).some(t => isMoneyField(t, f))) errors.push(`field_policy_defaults の「${f}」: お金の欄（money: true）は「自動」にできません（書くときは必ず承認のお願いになります）`)
    }
    for (const [opname, use] of Object.entries(manifest.uses?.operations ?? {})) {
      const persons = new Set(Object.values(owned).flatMap(t => Object.entries(t.fields).filter(([, f]) => f.kind === 'person').map(([n]) => n)))
      for (const w of use.who) {
        if (!persons.has(w) && !(PLUGIN_ACTORS as readonly string[]).includes(w) && !declaredRole(manifest, w)) errors.push(`操作「${opname}」の who「${w}」は人の欄でも ${PLUGIN_ACTORS.join(' / ')} でもありません`)
      }
    }
    // A type's `role:<name>` (plan C3) names a role this plugin declares (contract 2 only: contract 1 declares none).
    for (const [tname, t] of Object.entries(owned)) {
      for (const [aname, a] of Object.entries(t.actions)) {
        for (const w of a.who) {
          if (roleOfWho(w) !== null && !declaredRole(manifest, w)) errors.push(`型「${tname}」の操作「${aname}」の who「${w}」は、このプラグインの roles にない役割です`)
        }
      }
    }
    errors.push(...flowProblems(manifest, owned, stepFiles, uiFiles), ...useProblems(manifest, owned))
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { manifest, types: owned } }
}

/** `role:<name>` naming a role the business plugin declares (contract 2). */
function declaredRole(manifest: Pick<PluginManifest, 'roles'>, who: string): boolean {
  const role = roleOfWho(who)
  return role !== null && Object.prototype.hasOwnProperty.call(manifest.roles, role)
}

/**
 * Contract 3's checks of a business plugin's use that need its roles and types:
 * a call's `role:<name>` is declared; an event's `type` is the plugin's or a
 * core type, `match` one of its fields and `action` one of its actions.
 */
function useProblems(manifest: PluginManifest, owned: Record<string, TypeDefinition>): string[] {
  const errors: string[] = []
  for (const [name, use] of Object.entries(manifest.uses?.calls ?? {})) {
    for (const w of use.who) if (roleOfWho(w) !== null && !declaredRole(manifest, w)) errors.push(`呼び出し「${name}」の who「${w}」は、このプラグインの roles にない役割です`)
  }
  const core = Object.fromEntries(coreTypeDefinitions().map(t => [t.name, t]))
  for (const [name, use] of Object.entries(manifest.uses?.events ?? {})) {
    const t = Object.prototype.hasOwnProperty.call(owned, use.type) ? owned[use.type] : Object.prototype.hasOwnProperty.call(core, use.type) ? core[use.type] : undefined
    if (!t) { errors.push(`知らせ「${name}」: 型「${use.type}」は、このプラグインの types にも本体の型にもありません`); continue }
    if (!Object.prototype.hasOwnProperty.call(t.fields, use.match)) errors.push(`知らせ「${name}」の match「${use.match}」は型「${use.type}」の欄ではありません`)
    if (!Object.prototype.hasOwnProperty.call(t.actions, use.action)) errors.push(`知らせ「${name}」の action「${use.action}」は型「${use.type}」の操作ではありません`)
  }
  return errors
}

/**
 * Contract 2's checks that need the types and the files: a step's (or an
 * upgrade point's) type is the plugin's own or a core type and its state a
 * non-final state of it; each step's default procedure is in `steps/` and
 * `steps/` holds exactly the files the steps name; each frame's entry is a
 * file under `ui/`, and `ui/` exists only with a `ui` declaration.
 */
function flowProblems(manifest: PluginManifest, owned: Record<string, TypeDefinition>, stepFiles: string[], uiFiles: readonly string[]): string[] {
  const errors: string[] = []
  const core = Object.fromEntries(coreTypeDefinitions().map(t => [t.name, t]))
  const typeOf = (name: string): TypeDefinition | undefined =>
    Object.prototype.hasOwnProperty.call(owned, name) ? owned[name] : Object.prototype.hasOwnProperty.call(core, name) ? core[name] : undefined
  const point = (where: string, p: PluginStatePoint) => {
    const t = typeOf(p.type)
    if (!t) errors.push(`${where}: 型「${p.type}」は、このプラグインの types にも本体の型にもありません`)
    else if (!t.states.includes(p.state)) errors.push(`${where}: 状態「${p.state}」は型「${p.type}」の states にありません`)
    else if (t.final.includes(p.state)) errors.push(`${where}: 状態「${p.state}」は終わりの状態です`)
  }
  const named = new Set<string>()
  for (const [name, step] of Object.entries(manifest.steps)) {
    point(`手順「${name}」`, step.for)
    // The plugin's own procedure is always there, also when a company may use its Skill instead.
    if (!stepFiles.includes(step.procedure.default)) errors.push(`手順「${name}」の手順書 ${step.procedure.default} が包みにありません`)
    named.add(step.procedure.default)
    if (step.tools.includes('plugin_operations') && !manifest.uses) errors.push(`手順「${name}」: plugin_operations は、つなぎ先を使う業務のプラグイン（connector のあるもの）だけの道具です`)
  }
  for (const f of stepFiles) if (!named.has(f)) errors.push(`${f} はどの手順（steps）からも使われていません`)
  for (const [i, p] of (manifest.upgrade?.at ?? []).entries()) point(`upgrade の at の ${i + 1} 番目`, p)
  const ui = manifest.ui
  if (!ui && uiFiles.length > 0) errors.push('画面（ui/）を置くときは、宣言に ui を書いてください')
  if (ui) {
    const entries = [...(ui.tab ? [ui.tab.entry] : []), ...ui.recordSections.map(s => s.entry), ...ui.fileActions.map(a => a.entry)]
    for (const e of entries) if (e && !uiFiles.includes(e)) errors.push(`画面のファイル ${e} が包みにありません`)
    for (const s of ui.recordSections) if (!typeOf(s.type)) errors.push(`ui の record_sections: 型「${s.type}」は、このプラグインの types にも本体の型にもありません`)
  }
  return errors
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
    if (!op && connector.searches?.[opname]) { errors.push(`${where}は探す操作です。operations ではなく、記録を作る操作の similar の search に書きます`); continue }
    if (!op && own(connector.calls, opname)) { errors.push(`${where}は呼び出しです。operations ではなく calls に書きます`); continue }
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
      if (!persons.has(w) && !(PLUGIN_ACTORS as readonly string[]).includes(w) && !declaredRole(b, w)) errors.push(`${where}の who「${w}」は型「${recordObject.recordType}」の人の欄でも ${PLUGIN_ACTORS.join(' / ')} でもありません`)
    }
    if (use.decision && op.kind === 'read') errors.push(`${where}: 読む操作は decision にできません`)
    if (use.policy !== null && op.kind !== 'create') errors.push(`${where}: policy は作る操作だけに書けます（書き換えの決まりは欄ごと：field_policy_defaults と読み替え表）`)
    // Moving money asks first like reaching outside: its default is `prior`, and `auto` is refused.
    const policy = use.policy ?? (use.movesMoney && op.policy === 'auto' ? 'prior' : op.policy)
    if (op.reaches === 'external' && policy === 'auto') errors.push(`${where}: 社外の人に届く操作は「自動」にできません`)
    if (use.movesMoney && op.kind === 'read') errors.push(`${where}: 読む操作はお金を動かしません（moves_money は書く操作だけです）`)
    if (use.movesMoney && policy === 'auto') errors.push(`${where}: お金が動く操作は「自動」にできません`)
    if (op.createsRecord && policy === 'auto') errors.push(`${where}: 記録を新しく作る操作は「自動」にできません（必ず人が承認します）`)
    const similar = use.similar ? similarRule(where, use.similar, op, recordObject.recordType, connector, uses, types, useObject, errors) : null
    operations[opname] = {
      ...op, who: [...use.who], decision: use.decision, note: use.note, policy, movesMoney: use.movesMoney,
      ...(use.via ? { via: [...use.via] } : {}), ...(similar ? { similar } : {}),
    }
  }
  // Contract 3: only what the business plugin declared, as for operations; a call never becomes an operation.
  const calls: Record<string, PluginCall> = {}
  for (const [name, use] of Object.entries(uses.calls ?? {})) {
    const call = own(connector.calls, name)
    if (!call) { errors.push(`呼び出し「${name}」は「${connector.label}」${connector.version} にありません`); continue }
    if (use.decision && call.kind !== 'act') errors.push(`呼び出し「${name}」: 読む呼び出しは decision にできません`)
    calls[name] = { ...call, who: [...use.who], decision: use.decision }
  }
  const events: Record<string, PluginEvent> = {}
  for (const [name, use] of Object.entries(uses.events ?? {})) {
    const event = own(connector.events, name)
    if (!event) { errors.push(`知らせ「${name}」は「${connector.label}」${connector.version} にありません`); continue }
    if (!Object.prototype.hasOwnProperty.call(event.fields, use.match)) errors.push(`知らせ「${name}」の match「${use.match}」は「${connector.label}」の知らせの項目にありません`)
    events[name] = { ...event, use: { ...use } }
  }
  if (errors.length === 0) {
    for (const [f, p] of Object.entries(b.fieldPolicyDefaults)) {
      if (p === 'auto' && priorFieldWriters({ operations }).length > 0) errors.push(`欄「${f}」: 社外の人に届くか、お金が動く書き換えの操作があるため、欄の決まりを「自動」にできません`)
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
        ...(connector.calling ? { calling: connector.calling } : {}),
        ...(Object.keys(calls).length > 0 ? { calls } : {}),
        ...(Object.keys(events).length > 0 ? { events, ...(connector.polls ? { polls: connector.polls } : {}) } : {}),
      },
    },
  }
}

const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined =>
  map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined

/**
 * A create of a record's `similar`, checked against the connector and the
 * types and resolved (plugins.md "Similar records"): only on a create of a
 * record; `status` a choice field of its type; `search` a search of the
 * connector on the same object — asked by 相手 only when the search says how
 * (`counterpart`) and that object is one of the business plugin's types.
 */
function similarRule(
  where: string, use: NonNullable<OperationUse['similar']>, op: PluginOperation, recordType: string, connector: PluginManifest,
  uses: NonNullable<PluginManifest['uses']>, types: PluginPackage['types'], useObject: (name: string) => PluginObject | null, errors: string[],
): SimilarRule | null {
  if (!op.createsRecord) { errors.push(`${where}: similar は記録を新しく作る操作だけに書けます`); return null }
  if (use.status !== null) {
    const f = types[recordType]?.fields[use.status]
    if (!f || f.kind !== 'choice') { errors.push(`${where}の similar の status「${use.status}」は型「${recordType}」の選ぶ欄（choice）ではありません`); return null }
  }
  let search: SimilarRule['search'] = null
  if (use.search !== null) {
    const s = Object.prototype.hasOwnProperty.call(connector.searches ?? {}, use.search) ? connector.searches![use.search] : undefined
    if (!s) { errors.push(`${where}の similar の search「${use.search}」は「${connector.label}」${connector.version} の探す操作（kind: search）にありません`); return null }
    if (s.object !== op.object) { errors.push(`${where}の similar の search「${use.search}」は対象「${op.object}」を探すものではありません`); return null }
    if (use.by.includes('counterpart') && s.counterpart) {
      if (!uses.objects[s.counterpart.object]?.recordType) { errors.push(`${where}の similar: 相手で探すには、対象「${s.counterpart.object}」を objects でこの業務の型（record_type）にしてください`); return null }
      useObject(s.counterpart.object)
    }
    if (!use.by.includes('name') && !(use.by.includes('counterpart') && s.counterpart)) { errors.push(`${where}の similar の search「${use.search}」は by のどれでも探せません（相手で探すには、探す操作に counterpart が要ります）`); return null }
    search = { operation: use.search, ...s }
  }
  return { by: [...use.by], status: use.status, search }
}
