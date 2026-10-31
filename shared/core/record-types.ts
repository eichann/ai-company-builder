/**
 * Type definitions of the light ontology (stage 4-1, 「型の仕組み」): one file
 * per type at `.acb/types/<name>.md` in the company repository, its
 * definition in the YAML frontmatter (English keys, Japanese `label`s), its
 * body free text for people. One copy for the server's indexer, the push
 * checker (which refuses a definition that removes or renames something) and
 * the app (typed tools, later screens).
 *
 * A definition says only what the state engine may do (owner decision 案 B,
 * ontology §17.7): fields and where each value lives (`source: file` = the
 * record's text, `source: server` = the company map, written only by the
 * engine), links to other records or files, the states, and the actions
 * (from → to, who may, whom to notify, files to attach, note rule, history
 * line, decision flag). No expressions, computed fields, cascades, timers or
 * outside sends: there is nothing in the schema to write them with.
 *
 * Versions (ontology 0.18-3): additive changes (a field, link, state, action
 * or interface added; labels, `who`, `notify` changed) need a higher
 * `version`; removing or renaming anything, or changing what a value means
 * (kind, source, target, cardinality, storage), is refused until a migration
 * tool exists (`compareTypeDefinitions`).
 */
import { isYamlMap, parseYamlLite, splitFrontmatter, type YamlValue } from './yaml-lite'

/** Type, field, link, state, action and argument names: English, lower case. */
export const ONTOLOGY_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/

export const FIELD_KINDS = ['text', 'long_text', 'number', 'date', 'datetime', 'boolean', 'person', 'choice', 'record'] as const
export type FieldKind = typeof FIELD_KINDS[number]
export type FieldSource = 'file' | 'server'
export type NoteRule = 'none' | 'optional' | 'required'
/** Where a type's records live: always a file, never (server only), or server first and a file once there is content (0.6). */
export type RecordStorage = 'file' | 'server' | 'either'
/** Approval tiers (0.3-4): none (recorded only), undoable later, prior approval. */
export type ApprovalTier = 'none' | 'undoable' | 'prior'

export interface FieldDef {
  label: string
  kind: FieldKind
  source: FieldSource
  /** kind choice: the allowed values. */
  options?: string[]
  /**
   * kind choice: how an option is shown to people (YAML `option_labels`, e.g.
   * `{ a: A（高）, b: B（中） }`); an option without one is shown as it is.
   * Display only: values are stored, queried and written as the options.
   */
  optionLabels?: Record<string, string>
  /** kind record: the type of the record it names. */
  target?: string
}

export interface LinkDef {
  label: string
  /** A type name, or `file` for files of the company folder. */
  target: string
  cardinality: 'one' | 'many'
  /** The name the other side shows the link under (a label only; nothing is stored twice). */
  inverse?: string
}

export interface ActionDef {
  label: string
  /** States the action starts from; null = any state. */
  from: string[] | null
  /** The state it moves to; null = the state stays (e.g. reassigning). */
  to: string | null
  /** Who may: person fields of the record, or `ai`, `dept_manager`, `admin`, `anyone`. */
  who: string[]
  /** Whom to tell: person fields or person arguments. */
  notify: string[]
  /** Links (target `file`) whose files are sent first and whose versions are recorded. */
  attach: string[]
  note: NoteRule
  /** Append a line to the record's history (経緯) when done. */
  historyLine: boolean
  /** Keep the ledger entry as a decision (判断の記録, §13.2 案 Y). */
  decision: boolean
  approval: ApprovalTier
  /** Arguments; each names a server field of the same kind, which the action sets. */
  args: Record<string, FieldKind>
  /**
   * For a type implementing `request`: the person field or argument whose
   * value becomes `next_actor` (whose turn it is next). A copy, not an expression.
   */
  handTo: string | null
}

export interface TypeDefinition {
  name: string
  label: string
  version: number
  implements: string[]
  storage: RecordStorage
  fields: Record<string, FieldDef>
  links: Record<string, LinkDef>
  states: string[]
  initial: string | null
  /** States in which nothing is waiting for anyone (done, cancelled…): not anyone's turn. */
  final: string[]
  actions: Record<string, ActionDef>
}

/** Who-values that are not field names. */
export const ACTION_ACTORS = ['ai', 'dept_manager', 'admin', 'anyone'] as const

/**
 * Interfaces (4-4): fields a type must have, all server-sourced, to be
 * treated as one kind of thing across types. `request` = 「依頼」, what
 * 「あなたの番」 collects regardless of the type.
 */
export const INTERFACES: Record<string, { label: string; fields: Record<string, FieldKind> }> = {
  request: {
    label: '依頼',
    fields: { requested_by: 'person', assignee: 'person', next_actor: 'person', waiting_on: 'text', due: 'date' },
  },
}

/** Names a field may not take: the record's own keys and the index columns. */
const RESERVED_FIELD_NAMES = new Set(['id', 'type', 'links', 'state', 'version', 'title', 'summary', 'path'])

export type TypeParseResult = { ok: true; definition: TypeDefinition } | { ok: false; errors: string[] }

const isStr = (v: YamlValue | undefined): v is string => typeof v === 'string' && v.trim() !== ''
const list = (v: YamlValue | undefined): YamlValue[] | null => (v === undefined || v === null ? [] : Array.isArray(v) ? v : typeof v === 'string' ? [v] : null)

/** Parse and validate one definition file. `name` is the file name without `.md`. */
export function parseTypeFile(name: string, text: string): TypeParseResult {
  const fm = splitFrontmatter(text)
  if (!fm) return { ok: false, errors: ['先頭に「---」で囲んだ定義がありません'] }
  const yaml = parseYamlLite(fm.yaml, fm.yamlFirstLine)
  if (!yaml.ok) return { ok: false, errors: [`${yaml.line} 行目: ${yaml.error}`] }
  return validateTypeDefinition(name, yaml.value)
}

/** Validate a parsed definition (also used for the core types shipped with the server). */
export function validateTypeDefinition(name: string, raw: YamlValue): TypeParseResult {
  const errors: string[] = []
  const err = (m: string) => { if (errors.length < 50) errors.push(m) }
  if (!ONTOLOGY_NAME_RE.test(name)) err(`型の名前「${name}」は英小文字・数字・_ で書いてください`)
  if (!isYamlMap(raw)) return { ok: false, errors: ['定義は「項目名: 値」の形で書いてください'] }
  const known = new Set(['label', 'version', 'implements', 'storage', 'fields', 'links', 'states', 'initial', 'final', 'actions', 'description'])
  for (const k of Object.keys(raw)) if (!known.has(k)) err(`知らない項目「${k}」があります`)

  if (!isStr(raw.label)) err('label（画面に出す名前）を書いてください')
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 100000) err('version は 1 以上の整数で書いてください')
  const storage = raw.storage ?? 'file'
  if (storage !== 'file' && storage !== 'server' && storage !== 'either') err('storage は file / server / either のどれかです')

  const fields: Record<string, FieldDef> = {}
  const rawFields = raw.fields ?? {}
  if (!isYamlMap(rawFields)) err('fields は「名前: { … }」の形で書いてください')
  else {
    for (const [fname, f] of Object.entries(rawFields)) {
      if (!ONTOLOGY_NAME_RE.test(fname)) { err(`欄の名前「${fname}」は英小文字・数字・_ で書いてください`); continue }
      if (RESERVED_FIELD_NAMES.has(fname) && fname !== 'title' && fname !== 'summary') { err(`「${fname}」は欄の名前に使えません`); continue }
      if (!isYamlMap(f)) { err(`欄「${fname}」は { label, kind, source } の形で書いてください`); continue }
      for (const k of Object.keys(f)) if (!['label', 'kind', 'source', 'options', 'option_labels', 'target'].includes(k)) err(`欄「${fname}」に知らない項目「${k}」があります`)
      const kind = f.kind
      if (!FIELD_KINDS.includes(kind as FieldKind)) { err(`欄「${fname}」の kind は ${FIELD_KINDS.join(' / ')} のどれかです`); continue }
      const source = f.source ?? 'server'
      if (source !== 'file' && source !== 'server') { err(`欄「${fname}」の source は file か server です`); continue }
      if ((fname === 'title' || fname === 'summary') && source !== 'file') err(`欄「${fname}」は source: file です（記録の文章から読みます）`)
      if (!isStr(f.label)) err(`欄「${fname}」に label を書いてください`)
      const def: FieldDef = { label: isStr(f.label) ? f.label : fname, kind: kind as FieldKind, source }
      if (kind === 'choice') {
        const opts = list(f.options)
        if (!opts || opts.length === 0 || !opts.every(o => typeof o === 'string' && ONTOLOGY_NAME_RE.test(o))) err(`欄「${fname}」の options は英小文字の値の並びで書いてください`)
        else def.options = opts as string[]
      } else if (f.options !== undefined) err(`欄「${fname}」の options は kind: choice のときだけ書けます`)
      if (f.option_labels !== undefined) {
        const labels = f.option_labels
        if (kind !== 'choice') err(`欄「${fname}」の option_labels は kind: choice のときだけ書けます`)
        else if (!isYamlMap(labels) || Object.entries(labels).some(([o, l]) => !def.options?.includes(o) || !isStr(l) || l.length > 40)) {
          err(`欄「${fname}」の option_labels は「選択肢: 表示名（40 文字まで）」の形で、options にある値だけを書いてください`)
        } else if (Object.keys(labels).length > 0) def.optionLabels = { ...(labels as Record<string, string>) }
      }
      if (kind === 'record') {
        if (!isStr(f.target) || !ONTOLOGY_NAME_RE.test(f.target)) err(`欄「${fname}」の target に型の名前を書いてください`)
        else def.target = f.target
      } else if (f.target !== undefined) err(`欄「${fname}」の target は kind: record のときだけ書けます`)
      fields[fname] = def
    }
  }

  const links: Record<string, LinkDef> = {}
  const rawLinks = raw.links ?? {}
  if (!isYamlMap(rawLinks)) err('links は「名前: { … }」の形で書いてください')
  else {
    for (const [lname, l] of Object.entries(rawLinks)) {
      if (!ONTOLOGY_NAME_RE.test(lname)) { err(`つながりの名前「${lname}」は英小文字・数字・_ で書いてください`); continue }
      if (!isYamlMap(l)) { err(`つながり「${lname}」は { label, target, cardinality } の形で書いてください`); continue }
      for (const k of Object.keys(l)) if (!['label', 'target', 'cardinality', 'inverse'].includes(k)) err(`つながり「${lname}」に知らない項目「${k}」があります`)
      if (!isStr(l.label)) err(`つながり「${lname}」に label を書いてください`)
      if (!isStr(l.target) || !ONTOLOGY_NAME_RE.test(l.target)) { err(`つながり「${lname}」の target に型の名前か file を書いてください`); continue }
      const cardinality = l.cardinality ?? 'many'
      if (cardinality !== 'one' && cardinality !== 'many') { err(`つながり「${lname}」の cardinality は one か many です`); continue }
      if (l.inverse !== undefined && (!isStr(l.inverse) || !ONTOLOGY_NAME_RE.test(l.inverse))) err(`つながり「${lname}」の inverse は英小文字の名前で書いてください`)
      links[lname] = { label: isStr(l.label) ? l.label : lname, target: l.target, cardinality, ...(isStr(l.inverse) ? { inverse: l.inverse } : {}) }
    }
  }

  const statesRaw = list(raw.states)
  const states: string[] = []
  if (!statesRaw) err('states は状態の名前の並びで書いてください')
  else {
    for (const s of statesRaw) {
      if (typeof s !== 'string' || !ONTOLOGY_NAME_RE.test(s)) err(`状態「${String(s)}」は英小文字・数字・_ で書いてください`)
      else if (states.includes(s)) err(`状態「${s}」が2回書かれています`)
      else states.push(s)
    }
  }
  let initial: string | null = states[0] ?? null
  if (raw.initial !== undefined) {
    if (typeof raw.initial !== 'string' || !states.includes(raw.initial)) err('initial は states のどれかです')
    else initial = raw.initial
  }

  const finalRaw = list(raw.final)
  const final: string[] = []
  if (!finalRaw || !finalRaw.every(f => typeof f === 'string' && states.includes(f))) err('final は states の名前の並びで書いてください')
  else final.push(...(finalRaw as string[]))

  const implementsRaw = list(raw.implements)
  const implementsList: string[] = []
  if (!implementsRaw) err('implements は共通の型の名前の並びで書いてください')
  else {
    for (const i of implementsRaw) {
      if (typeof i !== 'string' || !(i in INTERFACES)) { err(`共通の型「${String(i)}」はありません`); continue }
      implementsList.push(i)
      for (const [fname, kind] of Object.entries(INTERFACES[i].fields)) {
        const f = fields[fname]
        if (!f || f.kind !== kind || f.source !== 'server') err(`共通の型「${i}」には欄「${fname}」（kind: ${kind}, source: server）が要ります`)
      }
    }
  }

  const personFields = new Set(Object.entries(fields).filter(([, f]) => f.kind === 'person').map(([n]) => n))
  const actions: Record<string, ActionDef> = {}
  const rawActions = raw.actions ?? {}
  if (!isYamlMap(rawActions)) err('actions は「名前: { … }」の形で書いてください')
  else {
    for (const [aname, a] of Object.entries(rawActions)) {
      if (!ONTOLOGY_NAME_RE.test(aname)) { err(`操作の名前「${aname}」は英小文字・数字・_ で書いてください`); continue }
      if (!isYamlMap(a)) { err(`操作「${aname}」は { label, from, to, who } の形で書いてください`); continue }
      const allowed = ['label', 'from', 'to', 'who', 'notify', 'attach', 'note', 'history_line', 'decision', 'approval', 'args', 'hand_to']
      for (const k of Object.keys(a)) if (!allowed.includes(k)) err(`操作「${aname}」に知らない項目「${k}」があります（式・連鎖・自動実行は書けません）`)
      if (!isStr(a.label)) err(`操作「${aname}」に label を書いてください`)
      let from: string[] | null = null
      if (a.from !== undefined && a.from !== null) {
        const f = list(a.from)
        if (!f || !f.every(s => typeof s === 'string' && states.includes(s))) err(`操作「${aname}」の from は states の名前で書いてください`)
        else from = f as string[]
      }
      let to: string | null = null
      if (a.to !== undefined && a.to !== null) {
        if (typeof a.to !== 'string' || !states.includes(a.to)) err(`操作「${aname}」の to は states のどれかです`)
        else to = a.to
      }
      const args: Record<string, FieldKind> = {}
      const rawArgs = a.args ?? {}
      if (!isYamlMap(rawArgs)) err(`操作「${aname}」の args は「名前: 種類」の形で書いてください`)
      else {
        for (const [arg, kind] of Object.entries(rawArgs)) {
          const field = fields[arg]
          if (!field || field.source !== 'server') { err(`操作「${aname}」の引数「${arg}」は、同じ名前の欄（source: server）を決めるものです`); continue }
          if (kind !== field.kind) { err(`操作「${aname}」の引数「${arg}」の種類は欄と同じ ${field.kind} です`); continue }
          args[arg] = field.kind
        }
      }
      const who = list(a.who)
      const whoOk = !!who && who.length > 0 && who.every(w => typeof w === 'string' && (personFields.has(w) || (ACTION_ACTORS as readonly string[]).includes(w)))
      if (!whoOk) err(`操作「${aname}」の who は人の欄の名前か ${ACTION_ACTORS.join(' / ')} で書いてください`)
      const notify = list(a.notify)
      const notifyOk = !!notify && notify.every(n => typeof n === 'string' && (personFields.has(n) || args[n] === 'person'))
      if (!notifyOk) err(`操作「${aname}」の notify は人の欄か人の引数の名前で書いてください`)
      const attach = list(a.attach)
      const attachOk = !!attach && attach.every(n => typeof n === 'string' && links[n]?.target === 'file')
      if (!attachOk) err(`操作「${aname}」の attach はファイルへのつながりの名前で書いてください`)
      const note = a.note ?? 'none'
      if (note !== 'none' && note !== 'optional' && note !== 'required') err(`操作「${aname}」の note は none / optional / required です`)
      const approval = a.approval ?? 'none'
      if (approval !== 'none' && approval !== 'undoable' && approval !== 'prior') err(`操作「${aname}」の approval は none / undoable / prior です`)
      for (const flag of ['history_line', 'decision'] as const) {
        if (a[flag] !== undefined && typeof a[flag] !== 'boolean') err(`操作「${aname}」の ${flag} は true か false です`)
      }
      let handTo: string | null = null
      if (a.hand_to !== undefined && a.hand_to !== null) {
        if (!implementsList.includes('request')) err(`操作「${aname}」の hand_to は共通の型 request を持つ型だけに書けます`)
        else if (typeof a.hand_to !== 'string' || !(personFields.has(a.hand_to) || args[a.hand_to] === 'person')) err(`操作「${aname}」の hand_to は人の欄か人の引数の名前で書いてください`)
        else handTo = a.hand_to
      }
      if (to === null && Object.keys(args).length === 0) err(`操作「${aname}」は状態を変える（to）か欄を決める（args）かのどちらかが要ります`)
      actions[aname] = {
        label: isStr(a.label) ? a.label : aname,
        from,
        to,
        who: whoOk ? (who as string[]) : [],
        notify: notifyOk ? (notify as string[]) : [],
        attach: attachOk ? (attach as string[]) : [],
        note: note as NoteRule,
        historyLine: a.history_line === true,
        decision: a.decision === true,
        approval: approval as ApprovalTier,
        args,
        handTo,
      }
    }
  }
  if (Object.keys(actions).length > 0 && states.length === 0) err('操作があるときは states を書いてください')

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    definition: {
      name,
      label: raw.label as string,
      version: version as number,
      implements: implementsList,
      storage: storage as RecordStorage,
      fields,
      links,
      states,
      initial,
      final,
      actions,
    },
  }
}

/** A stable JSON form (sorted keys) for comparing and storing definitions. */
export function canonicalTypeJson(def: TypeDefinition): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
    return v
  }
  return JSON.stringify(sort(def))
}

export interface TypeChange {
  /** Anything differs apart from the version number. */
  changed: boolean
  /** Removals / renames / changed meaning: refused until a migration tool exists. */
  breaking: string[]
  /** The version number does not go up although the definition changed (or goes down). */
  versionProblem: string | null
}

/** How `next` differs from the definition in force (`prev`). */
export function compareTypeDefinitions(prev: TypeDefinition, next: TypeDefinition): TypeChange {
  const breaking: string[] = []
  for (const [n, f] of Object.entries(prev.fields)) {
    const g = next.fields[n]
    if (!g) breaking.push(`欄「${n}」を消す（名前を変える）`)
    else if (g.kind !== f.kind || g.source !== f.source || g.target !== f.target) breaking.push(`欄「${n}」の種類・置き場所を変える`)
    else if (f.options && !f.options.every(o => g.options?.includes(o))) breaking.push(`欄「${n}」の選択肢を消す`)
  }
  for (const [n, l] of Object.entries(prev.links)) {
    const m = next.links[n]
    if (!m) breaking.push(`つながり「${n}」を消す（名前を変える）`)
    else if (m.target !== l.target || m.cardinality !== l.cardinality) breaking.push(`つながり「${n}」の相手・数を変える`)
  }
  for (const s of prev.states) if (!next.states.includes(s)) breaking.push(`状態「${s}」を消す（名前を変える）`)
  for (const a of Object.keys(prev.actions)) if (!(a in next.actions)) breaking.push(`操作「${a}」を消す（名前を変える）`)
  for (const i of prev.implements) if (!next.implements.includes(i)) breaking.push(`共通の型「${i}」をやめる`)
  if (prev.storage !== next.storage) breaking.push('記録の置き場所（storage）を変える')

  const strip = (d: TypeDefinition) => canonicalTypeJson({ ...d, version: 0 })
  const changed = strip(prev) !== strip(next)
  let versionProblem: string | null = null
  if (next.version < prev.version) versionProblem = `版の番号が下がっています（${prev.version} → ${next.version}）`
  else if (changed && next.version === prev.version) versionProblem = `定義を変えたときは version を上げてください（今は ${prev.version}）`
  return { changed, breaking, versionProblem }
}

/**
 * A stored definition read back (JSON of an older build may lack keys added
 * since: they get their defaults).
 */
export function storedTypeDefinition(json: string): TypeDefinition {
  const d = JSON.parse(json) as TypeDefinition
  return {
    ...d,
    final: d.final ?? [],
    actions: Object.fromEntries(Object.entries(d.actions ?? {}).map(([n, a]) => [n, { ...a, handTo: a.handTo ?? null }])),
  }
}

/** `.acb/types/<name>.md` → name; null for any other path (only direct children count). */
export function typeNameOfPath(path: string): string | null {
  const m = /^\.acb\/types\/([^/]+)\.md$/.exec(path)
  return m ? m[1] : null
}
