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
 * (from → to, who may — and who may with someone's OK —, whom to notify, files to attach, note rule, history
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

export const FIELD_KINDS = ['text', 'long_text', 'number', 'date', 'datetime', 'boolean', 'person', 'choice', 'record', 'tags'] as const
export type FieldKind = typeof FIELD_KINDS[number]

/**
 * Kind `tags` (owner decision 2026-11-01, 「何個も値を持てる項目」): a list of
 * short words (タグ), server-sourced only. A value is given as an array of
 * strings; each is NFC-normalized, trimmed, its inner whitespace runs made
 * one space; empty entries and repeats are dropped (first one kept, order
 * kept). Stored — and kept in the ledger — as the JSON text of that array
 * (`["急ぎ","見積"]`; no tags = null), so every record value stays one scalar.
 */
export const TAGS_MAX_COUNT = 20
export const TAG_MAX_LENGTH = 40
// eslint-disable-next-line no-control-regex
const TAG_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** One tag as stored, or null when it is not a usable tag (empty, too long, control characters). */
export function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > TAG_MAX_LENGTH * 4) return null
  if (TAG_FORBIDDEN_RE.test(value.replace(/[\t\n\r]/g, ' '))) return null
  const t = value.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (t === '' || [...t].length > TAG_MAX_LENGTH) return null
  return t
}

/** A tags value as stored (JSON text, or null for none), or an error text (Japanese, for the member). */
export function normalizeTagsValue(value: unknown): string | null | { error: string } {
  if (value === null) return null
  const problem = { error: `タグは ${TAG_MAX_LENGTH} 文字までの言葉を ${TAGS_MAX_COUNT} 個まで、文字の並びで入れてください` }
  if (!Array.isArray(value) || value.length > TAGS_MAX_COUNT * 2) return problem
  const out: string[] = []
  for (const v of value) {
    const t = normalizeTag(v)
    if (t === null) return problem
    if (!out.includes(t)) out.push(t)
  }
  if (out.length > TAGS_MAX_COUNT) return problem
  return out.length === 0 ? null : JSON.stringify(out)
}

/** The tags of a stored value (anything unreadable = none). */
export function parseTagsValue(stored: unknown): string[] {
  if (typeof stored !== 'string') return []
  try {
    const v: unknown = JSON.parse(stored)
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/**
 * A value of kind `date`: a day (`2026-11-05`) or a day with a time of day
 * (`2026-11-05T15:00`, the company's own clock, no zone — a due 「15時まで」).
 * Both sort correctly as text (a day before its own times), so existing
 * date-only values stay valid and ordered.
 */
export const DATE_VALUE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/

export function isDateValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DATE_VALUE_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(Date.UTC(y, mo - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d
}
export type FieldSource = 'file' | 'server'
export type NoteRule = 'none' | 'optional' | 'required'
/** Where a type's records live: always a file, never (server only), or server first and a file once there is content (0.6). */
export type RecordStorage = 'file' | 'server' | 'either'
/** Approval tiers (0.3-4): none (recorded only), undoable later, prior approval. */
export type ApprovalTier = 'none' | 'undoable' | 'prior'

/**
 * Where an action (or a business plugin's operation) may be called from (plan 4b §5-13,
 * `.claude/rules/plugin-frame.md`): `screen` = the core app's own screens and the member's
 * consultation, `plugin` = a plugin's screen through its bridge, `run` = an automated run
 * (S10b) under the member's authority. Approving and sending are never any of these: they
 * stay on the core's cards (their own services).
 */
export const ACTION_VIA = ['screen', 'plugin', 'run'] as const
export type ActionVia = typeof ACTION_VIA[number]
/** Without `via`: the core's screens and automated runs, never a plugin's screen. */
export const DEFAULT_ACTION_VIA: readonly ActionVia[] = ['screen', 'run']
/** Where this action / operation may be called from (`via`, else the default). */
export const viaOf = (a: { via?: ActionVia[] }): readonly ActionVia[] => a.via ?? DEFAULT_ACTION_VIA

/**
 * Parse a `via` list: a non-empty list of `ACTION_VIA` without repeats. A string is the
 * problem (Japanese, naming `where`).
 */
export function parseVia(v: unknown, where: string): ActionVia[] | string {
  const l = Array.isArray(v) ? v : typeof v === 'string' ? [v] : null
  if (!l || l.length === 0 || !l.every(x => typeof x === 'string' && (ACTION_VIA as readonly string[]).includes(x)) || new Set(l).size !== l.length) {
    return `${where}の via は ${ACTION_VIA.join(' / ')} の並びで書いてください（同じものは1回だけ）`
  }
  return l as ActionVia[]
}

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
  /**
   * YAML `money: true` (kind number, source server): the field holds money (a
   * deal's 金額). Whoever writes it — any plugin operation, in any step,
   * through any mapping — asks a person first: never `auto`, never `ok_from`,
   * only an approval request (plugins.md "Money"). A type's action cannot set
   * it and a create cannot fill it. Absent = not money (left out, so stored
   * definitions compare equal); removing it is a breaking change.
   */
  money?: true
}

/** Whether `field` of the type holds money (`money: true`). */
export const isMoneyField = (def: Pick<TypeDefinition, 'fields'> | undefined, field: string): boolean =>
  def !== undefined && Object.prototype.hasOwnProperty.call(def.fields, field) && def.fields[field].money === true

export interface LinkDef {
  label: string
  /**
   * A type name, or `file` for files of the company folder — or, with
   * `targetIsInterface`, an interface name (YAML `interface: bundle`): any
   * record whose type implements it (owner decision 2026-11-01, 「まとまり」).
   */
  target: string
  /** The target is an interface in `INTERFACES` (absent otherwise, so stored definitions compare equal). */
  targetIsInterface?: true
  cardinality: 'one' | 'many'
  /** The name the other side shows the link under (a label only; nothing is stored twice). */
  inverse?: string
  /**
   * YAML `origin: true` (出どころ, owner decision 2026-11-02): where the record came from — the
   * meeting a task is homework of, the message it answers, what the AI made for it. History, not
   * filing: set when the record is made (or by the action that makes it), never linked or
   * removed afterwards by hand (records.md "Linking records later"). Absent otherwise (so
   * stored definitions compare equal); adding or dropping it is not breaking.
   */
  origin?: true
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
  /**
   * YAML `ok_from`: person fields whose holder may ALSO do this action when
   * they say whose OK it was (owner decision 2026-11-01: the assignee
   * completes a task the boss OK'd). The engine then requires `ok.by` (a
   * member who reads the record, not the actor) or `ok.note` (an OK from
   * outside ACB) and writes them into the type's `ok_by` / `ok_note` fields,
   * which the parser requires. Never the AI. Absent = nobody beyond `who`
   * (left out of the definition then, so existing stored JSON compares equal).
   */
  okFrom?: string[]
  /**
   * YAML `who_unless` (task version 9, 「終わったら：確かめてから」): `who` entries that do NOT
   * qualify while the record's server choice fields hold the given options —
   * `{ assignee: { when_done: check } }`: the assignee completes a task unless it is to be
   * checked first. Every condition of an entry must hold for it to be dropped; an empty value
   * matches no option. The entry is dropped for the person and for their delegate alike; an
   * `ok_from` naming the same field still applies (the OK path). Absent = `who` as written
   * (left out of the definition then, so existing stored JSON compares equal). `actionWho`.
   */
  whoUnless?: Record<string, Record<string, string>>
  /**
   * YAML `links`: record links (not file links) the action may set (task
   * version 5: `set_bundle` → `bundle`, `finish_prep` → `prepared`). The body
   * gives `links: { <name>: id | [ids] | null }`; a link left out stays as it
   * is. Each target must be a live record of this company the actor reads,
   * of the link's type (or implementing its interface). Absent = none.
   */
  links?: string[]
  /**
   * YAML `via`: where the action may be called from (`ACTION_VIA`). Absent =
   * `DEFAULT_ACTION_VIA` (left out of the definition then, so existing stored
   * JSON compares equal). `plugin` is refused on an action with `approval: prior`.
   */
  via?: ActionVia[]
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
  /**
   * YAML `create_states`: states a create may start in instead of `initial`
   * (task version 5: `preparing`, the AI's turn before the person's). Absent = only `initial`.
   */
  createStates?: string[]
  /**
   * YAML `proposal_states` (task version 11, owner decision 2026-11-02 「AI のタスクの案」): states
   * where the record is only a proposal (案) — nobody's turn, nobody told on entering it, left out
   * of 「あなたの番」 and the turn lists, until a person takes it up. Not final (it can still
   * become work). Absent = none (so stored definitions compare equal). `noTurnStates`.
   */
  proposalStates?: string[]
  actions: Record<string, ActionDef>
}

/**
 * The `who` of an action on a record holding `fields` (its `who_unless` applied): what the engine
 * checks and what a screen offers from. Pure.
 */
export function actionWho(action: Pick<ActionDef, 'who' | 'whoUnless'>, fields: Readonly<Record<string, unknown>>): string[] {
  const unless = action.whoUnless
  if (!unless) return action.who
  return action.who.filter(w => {
    const when = Object.prototype.hasOwnProperty.call(unless, w) ? unless[w] : undefined
    return !when || !Object.entries(when).every(([field, option]) => fields[field] === option)
  })
}

/** The server fields an action with `ok_from` writes (whose OK it was / an OK from outside ACB). */
export const OK_FIELDS = { by: 'ok_by', note: 'ok_note' } as const

/** Who-values that are not field names. */
export const ACTION_ACTORS = ['ai', 'dept_manager', 'admin', 'anyone'] as const

/** `role:<name>` in an action's `who` (plan C3; the same name rule as a plugin's declared roles). */
export const ROLE_REF_RE = /^role:[a-z][a-z0-9_]{0,39}$/

/**
 * What an interface asks of a type that claims it (`implements`): server
 * fields of these kinds, a choice field offering at least these options, and
 * — `finishes` — final states (whether one is finished must be answerable).
 * Nothing else: an interface is a promise of a few required fields, not a
 * parent type (no inheritance, no shared actions).
 */
export interface InterfaceDef {
  label: string
  fields: Record<string, FieldKind>
  /** Choice fields among `fields`: the options the type must offer (it may offer more). */
  options?: Record<string, readonly string[]>
  /** The type must name final states (「終わったかどうか」). */
  finishes?: true
}

/**
 * Interfaces (4-4): the fixed, small set of kinds of thing the core works
 * with across types. **Only the core defines them** — a plugin or a company's
 * own type may implement one, never add one (the parser refuses an unknown
 * name), so 「型の型」 never becomes a source of ambiguity (owner decision
 * 2026-11-01 night). Core types link to an interface, never to a business
 * plugin's type by name (`shared/core/core-types.ts`).
 *
 * - `request` = 「依頼」, what 「あなたの番」 collects regardless of the type.
 * - `prepared` = 「AI が用意したもの」, what a person checks and presses.
 * - `bundle` = 「まとまり」: what work is gathered under — a core 取り組み, a
 *   business plugin's 案件 or 企画 — with whose it is (`owner`), what for
 *   (`purpose`) and whether it is finished (final states).
 * - `counterpart` = 「相手」: who the company deals with outside — a 顧客, a
 *   guest, a 受講企業, an applicant. Its display name is the record's title;
 *   `counterpart_kind` says company or person; `domain` / `email` are the keys
 *   later matching (名寄せ) uses (either may be empty).
 * - `outside_event` = 「外で起きたこと」 (owner decision 2026-11-01 「流れを測れる
 *   記録」): a record of something that happened outside ACB — a mail or call
 *   received, a meeting — with `occurred_at`, when it happened there. When ACB
 *   learned of it is the record's first ledger entry (`create`'s `at`), so the
 *   two are always told apart. Core `interaction` and `meeting` implement it; a
 *   business plugin's type of incoming things may too.
 */
export const INTERFACES: Record<string, InterfaceDef> = {
  request: {
    label: '依頼',
    fields: { requested_by: 'person', assignee: 'person', next_actor: 'person', waiting_on: 'text', due: 'date' },
  },
  bundle: {
    label: 'まとまり',
    fields: { owner: 'person', purpose: 'text' },
    finishes: true,
  },
  counterpart: {
    label: '相手',
    fields: { counterpart_kind: 'choice', domain: 'text', email: 'text' },
    options: { counterpart_kind: ['company', 'person'] },
  },
  /**
   * 「AI が用意したもの」 (stage 2 S2): what an AI made for a person to check
   * and act on — a draft to send (`outbound_message`), an approval request — that
   * a task links under `prepared`. Who made it and whose it is to act on.
   */
  prepared: {
    label: 'AI が用意したもの',
    fields: { requested_by: 'person', assignee: 'person' },
  },
  outside_event: {
    label: '外で起きたこと',
    fields: { occurred_at: 'datetime' },
  },
}

/**
 * Why a definition does not keep the promise of interface `name` (empty =
 * it does): the parser's check of `implements`.
 */
export function interfaceProblems(name: string, def: Pick<TypeDefinition, 'fields' | 'final'>): string[] {
  const i = Object.prototype.hasOwnProperty.call(INTERFACES, name) ? INTERFACES[name] : undefined
  if (!i) return [`共通の型「${name}」はありません`]
  const out: string[] = []
  for (const [fname, kind] of Object.entries(i.fields)) {
    const f = def.fields[fname]
    if (!f || f.kind !== kind || f.source !== 'server') { out.push(`共通の型「${name}」には欄「${fname}」（kind: ${kind}, source: server）が要ります`); continue }
    const need = i.options?.[fname]
    if (need && !need.every(o => f.options?.includes(o))) out.push(`共通の型「${name}」の欄「${fname}」には選択肢 ${need.join(' / ')} が要ります`)
  }
  if (i.finishes && def.final.length === 0) out.push(`共通の型「${name}」には final（終わった状態）が要ります`)
  return out
}

/**
 * The states where no person's turn is waiting: final, the AI's turn, and proposals (案,
 * `proposal_states`). 「あなたの番」, the turn holder and the create's notice use it.
 */
export function noTurnStates(def: TypeDefinition): Set<string> {
  return new Set([...def.final, ...aiTurnStates(def), ...(def.proposalStates ?? [])])
}

/**
 * The states where it is the AI's turn: a state some action only the AI may
 * do (`who` exactly `[ai]`) starts from (from null = every non-final state).
 * 「AI の番」 lists them; 「あなたの番」 leaves them out (the person's turn
 * comes when the AI hands the record over).
 */
export function aiTurnStates(def: TypeDefinition): Set<string> {
  const states = new Set<string>()
  for (const a of Object.values(def.actions)) {
    if (a.who.length !== 1 || a.who[0] !== 'ai') continue
    for (const s of a.from ?? def.states.filter(x => !def.final.includes(x))) states.add(s)
  }
  return states
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
  const known = new Set(['label', 'version', 'implements', 'storage', 'fields', 'links', 'states', 'initial', 'final', 'create_states', 'proposal_states', 'actions', 'description'])
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
      for (const k of Object.keys(f)) if (!['label', 'kind', 'source', 'options', 'option_labels', 'target', 'money'].includes(k)) err(`欄「${fname}」に知らない項目「${k}」があります`)
      const kind = f.kind
      if (!FIELD_KINDS.includes(kind as FieldKind)) { err(`欄「${fname}」の kind は ${FIELD_KINDS.join(' / ')} のどれかです`); continue }
      const source = f.source ?? 'server'
      if (source !== 'file' && source !== 'server') { err(`欄「${fname}」の source は file か server です`); continue }
      if ((fname === 'title' || fname === 'summary') && source !== 'file') err(`欄「${fname}」は source: file です（記録の文章から読みます）`)
      if (kind === 'tags' && source !== 'server') err(`欄「${fname}」の kind: tags は source: server だけです（記録のファイルには書きません）`)
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
      if (f.money !== undefined) {
        if (typeof f.money !== 'boolean') err(`欄「${fname}」の money は true か false です`)
        else if (f.money && (kind !== 'number' || source !== 'server')) err(`欄「${fname}」の money: true は kind: number, source: server の欄だけに書けます`)
        else if (f.money) def.money = true
      }
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
      for (const k of Object.keys(l)) if (!['label', 'target', 'interface', 'cardinality', 'inverse', 'origin'].includes(k)) err(`つながり「${lname}」に知らない項目「${k}」があります`)
      if (!isStr(l.label)) err(`つながり「${lname}」に label を書いてください`)
      let target: string
      let toInterface = false
      if (l.interface !== undefined) {
        // An interface target: any type implementing it. Named explicitly, so an unknown one is an error (a type target is only a label).
        if (l.target !== undefined) { err(`つながり「${lname}」には target か interface のどちらか一方を書いてください`); continue }
        if (typeof l.interface !== 'string' || !Object.prototype.hasOwnProperty.call(INTERFACES, l.interface)) { err(`つながり「${lname}」の interface「${String(l.interface)}」という共通の型はありません（${Object.keys(INTERFACES).join(' / ')}）`); continue }
        target = l.interface
        toInterface = true
      } else {
        if (!isStr(l.target) || !ONTOLOGY_NAME_RE.test(l.target)) { err(`つながり「${lname}」の target に型の名前か file を書いてください`); continue }
        target = l.target
      }
      const cardinality = l.cardinality ?? 'many'
      if (cardinality !== 'one' && cardinality !== 'many') { err(`つながり「${lname}」の cardinality は one か many です`); continue }
      if (l.inverse !== undefined && (!isStr(l.inverse) || !ONTOLOGY_NAME_RE.test(l.inverse))) err(`つながり「${lname}」の inverse は英小文字の名前で書いてください`)
      if (l.origin !== undefined && typeof l.origin !== 'boolean') err(`つながり「${lname}」の origin は true か false です`)
      links[lname] = {
        label: isStr(l.label) ? l.label : lname, target, cardinality, ...(toInterface ? { targetIsInterface: true as const } : {}), ...(isStr(l.inverse) ? { inverse: l.inverse } : {}),
        ...(l.origin === true ? { origin: true as const } : {}),
      }
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

  let createStates: string[] | undefined
  if (raw.create_states !== undefined && raw.create_states !== null) {
    const c = list(raw.create_states)
    if (!c || !c.every(s => typeof s === 'string' && states.includes(s) && !final.includes(s))) err('create_states は states のうち final でない状態の名前の並びで書いてください')
    else if (c.length > 0) createStates = [...new Set(c as string[])]
  }
  let proposalStates: string[] | undefined
  if (raw.proposal_states !== undefined && raw.proposal_states !== null) {
    const c = list(raw.proposal_states)
    if (!c || !c.every(s => typeof s === 'string' && states.includes(s) && !final.includes(s))) err('proposal_states は states のうち final でない状態の名前の並びで書いてください')
    else if (c.length > 0) proposalStates = [...new Set(c as string[])]
  }

  const implementsRaw = list(raw.implements)
  const implementsList: string[] = []
  if (!implementsRaw) err('implements は共通の型の名前の並びで書いてください')
  else {
    for (const i of implementsRaw) {
      if (typeof i !== 'string' || !Object.prototype.hasOwnProperty.call(INTERFACES, i)) { err(`共通の型「${String(i)}」はありません`); continue }
      implementsList.push(i)
      for (const problem of interfaceProblems(i, { fields, final })) err(problem)
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
      const allowed = ['label', 'from', 'to', 'who', 'notify', 'attach', 'note', 'history_line', 'decision', 'approval', 'args', 'hand_to', 'ok_from', 'who_unless', 'links', 'via']
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
          // Money is written only through an approval request (plugins.md "Money"): never by an action, so never through `ok_from`.
          if (field.money) { err(`操作「${aname}」の引数「${arg}」はお金の欄（money: true）です。お金の欄は承認のお願いを通してだけ書けます`); continue }
          args[arg] = field.kind
        }
      }
      const who = list(a.who)
      // `role:<name>` (plan C3): a business role, held by whom the company assigns (plugin-roles.ts);
      // a plugin package may name only roles it declares (validatePluginPackage).
      const whoOk = !!who && who.length > 0 && who.every(w => typeof w === 'string' && (personFields.has(w) || (ACTION_ACTORS as readonly string[]).includes(w) || ROLE_REF_RE.test(w)))
      if (!whoOk) err(`操作「${aname}」の who は人の欄の名前か ${ACTION_ACTORS.join(' / ')} か role:<役割の名前> で書いてください`)
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
      let okFrom: string[] | undefined
      if (a.ok_from !== undefined && a.ok_from !== null) {
        const o = list(a.ok_from)
        if (!o || o.length === 0 || !o.every(w => typeof w === 'string' && personFields.has(w))) err(`操作「${aname}」の ok_from は人の欄の名前で書いてください`)
        else if (fields[OK_FIELDS.by]?.kind !== 'person' || fields[OK_FIELDS.by]?.source !== 'server' || fields[OK_FIELDS.note]?.kind !== 'text' || fields[OK_FIELDS.note]?.source !== 'server') {
          err(`操作「${aname}」に ok_from を書くときは、欄「${OK_FIELDS.by}」（kind: person, source: server）と「${OK_FIELDS.note}」（kind: text, source: server）が要ります`)
        } else okFrom = o as string[]
      }
      let whoUnless: Record<string, Record<string, string>> | undefined
      if (a.who_unless !== undefined && a.who_unless !== null) {
        const wu = a.who_unless
        const bad = () => err(`操作「${aname}」の who_unless は「who の名前: { 選択の欄（source: server）: その選択肢 }」の形で書いてください`)
        if (!isYamlMap(wu) || Object.keys(wu).length === 0) bad()
        else {
          const parsed: Record<string, Record<string, string>> = {}
          let fine = true
          for (const [w, cond] of Object.entries(wu)) {
            if (!(who ?? []).includes(w) || !isYamlMap(cond) || Object.keys(cond).length === 0) { fine = false; continue }
            const c: Record<string, string> = {}
            for (const [field, option] of Object.entries(cond)) {
              const fd = fields[field]
              if (!fd || fd.kind !== 'choice' || fd.source !== 'server' || typeof option !== 'string' || !(fd.options ?? []).includes(option)) { fine = false; continue }
              c[field] = option
            }
            parsed[w] = c
          }
          if (!fine) bad()
          else whoUnless = parsed
        }
      }
      let actionLinks: string[] | undefined
      if (a.links !== undefined && a.links !== null) {
        const l = list(a.links)
        if (!l || l.length === 0 || !l.every(n => typeof n === 'string' && links[n] !== undefined && links[n].target !== 'file')) err(`操作「${aname}」の links は記録へのつながり（file でないもの）の名前で書いてください`)
        else actionLinks = [...new Set(l as string[])]
      }
      let via: ActionVia[] | undefined
      if (a.via !== undefined && a.via !== null) {
        const v = parseVia(a.via, `操作「${aname}」`)
        if (typeof v === 'string') err(v)
        // A plugin's screen can only ask (an approval request); an action that needs prior approval is the core's.
        else if (v.includes('plugin') && approval === 'prior') err(`操作「${aname}」は承認が要る（approval: prior）ため、via に plugin は書けません。承認は本体の画面だけです`)
        else via = v
      }
      if (to === null && Object.keys(args).length === 0 && !actionLinks) err(`操作「${aname}」は状態を変える（to）か欄を決める（args）かつながりを決める（links）かのどれかが要ります`)
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
        ...(okFrom ? { okFrom } : {}),
        ...(whoUnless ? { whoUnless } : {}),
        ...(actionLinks ? { links: actionLinks } : {}),
        ...(via ? { via } : {}),
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
      ...(createStates ? { createStates } : {}),
      ...(proposalStates ? { proposalStates } : {}),
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
    else if (f.money && !g.money) breaking.push(`欄「${n}」のお金の印（money: true）を外す`)
  }
  for (const [n, l] of Object.entries(prev.links)) {
    const m = next.links[n]
    if (!m) breaking.push(`つながり「${n}」を消す（名前を変える）`)
    else if (m.target !== l.target || !!m.targetIsInterface !== !!l.targetIsInterface || m.cardinality !== l.cardinality) breaking.push(`つながり「${n}」の相手・数を変える`)
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
