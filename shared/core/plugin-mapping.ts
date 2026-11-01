/**
 * The mapping (読み替え表): per company and business plugin, versioned on the
 * server (P4). Its shape, `parsePluginMapping` against the combined use it
 * configures, and the check against the outside system's real property list
 * (「HubSpot に聞いて確かめる」, `checkMappingAgainstProperties`).
 */
import { APPROVER_RULES, type ApproverRule, type ApproverSpec } from './approvals'
import { roleRefName } from './plugin-roles'
import { FIELD_POLICIES, PRIOR_ONLY_FIELDS, externalFieldWriters, type FieldPolicy, type PluginManifest, type PluginParsed } from './plugin-declaration'
import { EXTERNAL_NAME_RE, strList, unknownKeys } from './plugin-declaration-rules'
import { normalizeRepoPath } from './paths'
import { ONTOLOGY_NAME_RE, type FieldDef, type TypeDefinition } from './record-types'
import { isYamlMap, parseYamlLite } from './yaml-lite'

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
  /**
   * The company's field policies (only where they differ from the
   * declaration's defaults); a create operation's name sets that operation's
   * policy (`log_meeting: auto`).
   */
  policy: Record<string, FieldPolicy>
  /**
   * Who approves a `prior` field or create operation (design 節目4 §3-4, §9 q3):
   * `self` (the member the request is for), `dept_manager`, `admin`, or
   * `role:<name>` — a role the business plugin declares (plan C3). Absent:
   * `DEFAULT_APPROVERS`, else `dept_manager`.
   */
  approvalBy: Record<string, ApproverSpec>
  /** ACB values of `stage` that close a deal (won / lost): moving there needs at least a department manager. */
  closingStages: string[]
}

/** The recommended approvers (design §9 q3): 確度・段階 the member, 受注失注・金額 the department manager. */
export const DEFAULT_APPROVERS: Readonly<Record<string, ApproverRule>> = { stage: 'self', confidence: 'self', amount: 'dept_manager', closed: 'dept_manager' }

export const MAPPING_IMPORT_MAX = 10_000
const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

/** Fields a mapping may name: the type's server fields, and the record's title / summary. */
export function mappableField(type: TypeDefinition, name: string): FieldDef | null {
  const f = type.fields[name]
  if (f && (f.source === 'server' || name === 'title' || name === 'summary')) return f
  if (!f && (name === 'title' || name === 'summary')) return { label: name, kind: 'text', source: 'file' }
  return null
}

/** Parse and validate a company's mapping against the package it configures. */
/** `role:<name>` of a role the business plugin declares (plan C3). */
const isDeclaredRole = (roles: Record<string, unknown>, who: unknown): boolean => {
  const name = typeof who === 'string' ? roleRefName(who) : null
  return name !== null && Object.prototype.hasOwnProperty.call(roles, name)
}

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
    if (MAPPING_SECTIONS.includes(oname)) continue
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
      // A list of tags has no outside counterpart in the mapping yet (no translation either way).
      if (def.kind === 'tags') { err(`${where}: タグの欄はまだ外の項目と読み替えられません`); continue }
      unknownKeys(`${where}: `, f, ['from', 'write', 'values', 'people'], err)
      if (typeof f.from !== 'string' || !EXTERNAL_NAME_RE.test(f.from)) { err(`${where}の from は外の項目名です`); continue }
      const write = f.write ?? false
      if (typeof write !== 'boolean') { err(`${where}の write は true か false です`); continue }
      if (write && !writable) err(`${where}: このプラグインには「${oname}」を書き換える操作がないため、write: true にできません`)
      if (write && def.source === 'file') err(`${where}: 件名・要約は書き戻せません`)
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

  const createOps = Object.entries(manifest.operations).filter(([, op]) => op.kind === 'create')
  const policy: Record<string, FieldPolicy> = {}
  const rawPolicy = raw.policy ?? {}
  if (!isYamlMap(rawPolicy)) err('policy は「欄の名前: auto / prior / off」の形で書いてください')
  else for (const [f, p] of Object.entries(rawPolicy)) {
    if (!FIELD_POLICIES.includes(p as FieldPolicy)) { err(`policy の「${f}」は auto / prior / off です`); continue }
    const createOp = createOps.find(([n]) => n === f)?.[1]
    if (createOp) {
      if (p === 'auto' && (createOp.reaches === 'external' || createOp.createsRecord)) { err(`policy の「${f}」: この操作は「自動」にできません（必ず人が承認します）`); continue }
      policy[f] = p as FieldPolicy
      continue
    }
    if (p === 'auto' && PRIOR_ONLY_FIELDS.includes(f)) { err(`policy の「${f}」: この欄は受注・失注につながるため、承認なし（auto）にできません`); continue }
    if (!Object.values(objects).some(o => o.fields[f])) { err(`policy の「${f}」は読み替え表にない欄です`); continue }
    if (p === 'auto' && Object.entries(objects).some(([on, o]) => o.fields[f]?.write && externalFieldWriters(manifest, on).length > 0)) {
      err(`policy の「${f}」: 社外の人に届く操作で書かれる欄は「自動」にできません`)
      continue
    }
    policy[f] = p as FieldPolicy
  }

  const approvalBy: Record<string, ApproverSpec> = {}
  const rawApprovalBy = raw.approval_by ?? {}
  if (!isYamlMap(rawApprovalBy)) err(`approval_by は「欄の名前: ${APPROVER_RULES.join(' / ')}」の形で書いてください`)
  else for (const [f, who] of Object.entries(rawApprovalBy)) {
    if (!(APPROVER_RULES as readonly string[]).includes(who as string) && !isDeclaredRole(manifest.roles, who)) {
      err(`approval_by の「${f}」は ${APPROVER_RULES.join(' / ')} か、このプラグインの役割（role:<名前>）です`)
      continue
    }
    if (!createOps.some(([n]) => n === f) && !Object.values(objects).some(o => o.fields[f]?.write)) { err(`approval_by の「${f}」は、書き戻す欄か作る操作の名前です`); continue }
    approvalBy[f] = who as ApproverSpec
  }

  const closingStages: string[] = []
  if (raw.closing_stages !== undefined) {
    const list = strList(raw.closing_stages)
    const stageOptions = new Set(Object.values(types).flatMap(t => t.fields.stage?.options ?? []))
    if (!list || !list.every(v => stageOptions.has(v))) err(`closing_stages は段階（stage）の選択肢の並びです（受注・失注になる段階）`)
    else closingStages.push(...list)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { objects, people, policy, approvalBy, closingStages } }
}

/** Top-level mapping keys that are not objects. */
export const MAPPING_SECTIONS: readonly string[] = ['people', 'policy', 'approval_by', 'closing_stages']

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
