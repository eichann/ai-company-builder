/**
 * The shape of a plugin declaration (`plugin.yaml`) once parsed: the two roles
 * (connector, business plugin), their objects and operations, a business
 * plugin's use of its connector, and the small facts every other plugin module
 * reads (contract, actors, the fixed endpoints, `available_to`). Parsing is in
 * `plugin-manifest.ts`; the overview and owner rules are in `plugins.ts`.
 */
import { AI_RUN_FAILURE_CLASSES, type AiRunFailureClass } from './ai-runs'
import { isMoneyField, type ActionVia, type NoteRule, type TypeDefinition } from './record-types'

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
 * Fields a plugin writes only after a person approves (milestone 4, design
 * 節目4 §9 q2, replacing milestone 3's "never"): changing `stage` can move a
 * deal to won / lost, so it is never `auto` — an `auto` default or policy is
 * refused, and at run time it is at least `prior` whatever is stored. A
 * mapping may now say `write: true` on it (div's 確度 is HubSpot's stage).
 */
export const PRIOR_ONLY_FIELDS: readonly string[] = ['stage']

/**
 * What an attached create (a meeting or a note on a deal) may fill: fixed
 * slots, each named to one outside property by the declaration's `content`.
 * `at` is a time (sent as epoch milliseconds, HubSpot's `hs_timestamp`).
 */
export const CREATE_CONTENT_SLOTS = ['title', 'body', 'at', 'outcome'] as const
export type CreateContentSlot = typeof CREATE_CONTENT_SLOTS[number]

/**
 * The plugin contract of milestone 3 (0.17): a connector or a business plugin
 * that is data only — declaration, types, mapping. Packages written for it keep
 * working unchanged (same keys, same files, same fingerprint).
 */
export const PLUGIN_CONTRACT = 1
/**
 * Contract 2 (stages 4a / 4b, plan C1): contract 1 plus a business plugin's
 * `roles`, `steps` (the AI's turn, run on the member's PC), `ui` (isolated
 * frames, unused until 4b), `upgrade` (where pinned work may move to this
 * version), the package folders `steps/` and `ui/`, the signature slot
 * (`signature.yaml`) and fingerprint v2 (`plugin-fingerprint.ts`).
 * `plugin-flow-declaration.ts` holds its rules; the syntax is fixed here once.
 */
export const PLUGIN_CONTRACT_V2 = 2
/**
 * Contract 3 (plugins.md "Contract 3"): contract 2 plus a connector's `calls`
 * (a map beside `operations`, so a connector's objects, operations and fixed
 * calls stay as they are), how it is called (`auth`, `actor`, `limits`,
 * `errors`, `result`), what the outside tells (`events`, `polls`, `signature`)
 * and a business plugin's use of them (`calls`, `events`). Declaration only:
 * nothing runs these yet. `plugin-call-declaration.ts` holds its rules.
 */
export const PLUGIN_CONTRACT_V3 = 3
/** The contracts this build understands. A declaration naming another is not used. */
export const PLUGIN_CONTRACTS: readonly number[] = [PLUGIN_CONTRACT, PLUGIN_CONTRACT_V2, PLUGIN_CONTRACT_V3]

export type PluginKind = 'official' | 'company'
/**
 * A connector talks to one outside system and owns no type; a business plugin
 * owns types and talks to the outside only through a connector it names.
 * Decided by the declaration: one with a `service` is a connector.
 */
export type PluginRole = 'connector' | 'business'
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
  /** For operations that write no mapped fields (create): its policy. Never `auto` when external or when it creates a record. */
  policy: FieldPolicy
  /**
   * create attached to a record (`attach_to`): which outside property each
   * content slot goes to. Empty for other kinds.
   */
  content: Partial<Record<CreateContentSlot, string>>
  /** create attached to a record: the outside association type linking the new item to it (HubSpot: 212 meeting → deal). */
  associationType: number | null
  /**
   * create: the outside property (a unique-value custom property the company
   * made, e.g. `acb_operation_id`) where the core writes the operation id, so
   * a create whose answer was lost can be looked up instead of re-sent
   * (design 節目4 §3-6, §4-4). Required on every create.
   */
  correlationProperty: string | null
  /**
   * create with no `attach_to`: the item becomes a new record of the object's
   * own type (`create_deal`). Such an operation is never `auto`.
   */
  createsRecord: boolean
  /**
   * The business plugin declared that it moves money (`moves_money: true`,
   * contract 2): treated like an operation reaching outside — never `auto`,
   * in a step's run only an approval request. False on a connector's own.
   */
  movesMoney: boolean
  /** The business plugin's `via` for its use of the operation (absent: `[screen, run]`; never on a connector's own). */
  via?: ActionVia[]
  /**
   * A create of a record: how similar existing records are found before it is
   * approved (the business plugin's `similar`, with the connector's search
   * resolved). Absent: by name through the object's `search` call (as before).
   */
  similar?: SimilarRule
}

/**
 * What "similar" means before a create of a record (owner decision 2026-11-02,
 * plugins.md "Similar records"): `counterpart` = records of the same type
 * linked to the same 相手 (its 名寄せ identity, the same company domain);
 * `name` = the title's words.
 */
export const SIMILAR_BY = ['counterpart', 'name'] as const
export type SimilarBy = typeof SIMILAR_BY[number]

/**
 * A connector's search (`kind: search`): read only, on an object with a
 * `search` call. `counterpart`: which connector object the 相手 is and the
 * outside filter property that matches an item to it (HubSpot:
 * `associations.company`). Not an operation: nobody runs it directly — a
 * business plugin's `similar` names it.
 */
export interface PluginSearch {
  label: string
  object: string
  counterpart: { object: string; property: string } | null
}

/** A business plugin's `similar` on a create of a record, as combined with its connector. */
export interface SimilarRule {
  by: SimilarBy[]
  /** A choice field of the record's type shown as each candidate's status (null: the record's state). */
  status: string | null
  /** The connector's search to ask as well (null: only records already in ACB). */
  search: (PluginSearch & { operation: string }) | null
}

/** What a call does to the world when it acts: stays in the company, reaches people, moves money, cannot be taken back. */
export const CALL_NATURES = ['internal', 'people', 'money', 'irreversible'] as const
export type CallNature = typeof CALL_NATURES[number]
/** How sensitive a value is. */
export const DATA_CLASSES = ['normal', 'personal', 'sensitive'] as const
export type DataClass = typeof DATA_CLASSES[number]
/** What ACB may keep of a value: nothing, a pointer to it, a summary of it. */
export const KEEP_RULES = ['none', 'pointer', 'summary'] as const
export type KeepRule = typeof KEEP_RULES[number]
/** What a call's input is; an input filling a path placeholder is an `id` (a plain outside id). */
export const CALL_INPUT_KINDS = ['id', 'text', 'number', 'boolean', 'date'] as const
export type CallInputKind = typeof CALL_INPUT_KINDS[number]
/** What an outside error code means to ACB (`errors.map`): the core's own failure classes, each with its place to go (`failureDestination`). */
export const CALL_FAILURE_KINDS = AI_RUN_FAILURE_CLASSES
export type CallFailureKind = AiRunFailureClass
/** What an outside status means to ACB (`result.map`). */
export const CALL_RESULT_STATES = ['applied', 'pending', 'failed', 'not_found'] as const
export type CallResultState = typeof CALL_RESULT_STATES[number]
export const CALL_AUTH_FORMATS = ['bearer', 'plain'] as const
export const CALL_AUTH_SLOTS = ['read', 'act'] as const
export const CALL_SIGNATURE_SCHEMES = ['hmac_sha256_ts_body'] as const
export const CALL_IDEMPOTENCY_STYLES = ['header'] as const
/** What the member header says on a run with no member. Fixed: the service conforms. */
export const ACTOR_SYSTEM = 'system'
/** Besides `role:<name>`, all a call's `who` may say: there is no record, so no person field and no `viewer`. */
export const CALL_ACTORS = ['admin', 'ai'] as const

/** A value a call answers with or an event carries. Anything not listed is dropped (`returns` is an allow-list). */
export interface PluginDataField {
  dataClass: DataClass
  keep: KeepRule
  /** Text someone outside wrote: handed on wrapped as outside text, never as an instruction. */
  outside: boolean
}

export interface PluginCallInput {
  kind: CallInputKind
  dataClass: DataClass
  required: boolean
  label: string | null
}

/** A list of entries with fixed fields, one level deep (`each`). */
export interface PluginReturnList { each: Record<string, PluginDataField> }
export type PluginReturn = PluginDataField | PluginReturnList

/** One request: a path under `base_url` (`{id}` its only placeholder, filled by the input `id`), its inputs and what is kept of the answer. */
export interface PluginCallRequest {
  path: string
  inputs: Record<string, PluginCallInput>
  /** A fixed field of the answer → its rule. */
  returns: Record<string, PluginReturn>
}

/** Paging of a list, a search or a poll: the query parameter sent and the answer's field holding the next value. */
export interface PluginCursor { param: string; next: string }
export interface PluginCallListing extends PluginCallRequest {
  /** The answer's field holding the entries (null: the answer is the list). */
  items: string | null
  cursor: PluginCursor | null
}

interface PluginCallBase {
  label: string
  /** The business plugin's `who`: `role:<name>`, `admin`, `ai`, at least one person. Empty on a connector's own. */
  who: string[]
  /** The business plugin's `decision` (act only). False on a connector's own. */
  decision: boolean
}
/** GET: inputs in the query, so all `class: normal`. */
export interface PluginReadCall extends PluginCallBase, PluginCallRequest { kind: 'read' }
/** POST, reading only: inputs in the body, the way to look something up by personal data. */
export interface PluginSearchCall extends PluginCallBase, PluginCallListing { kind: 'search' }
/** POST: it changes something outside. */
export interface PluginActCall extends PluginCallBase, PluginCallRequest {
  kind: 'act'
  nature: CallNature
  idempotency: { style: typeof CALL_IDEMPOTENCY_STYLES[number] }
  undo: 'none'
}
/** A document store: `page` and `list` GET, `search` POST. */
export interface PluginDocumentCall extends PluginCallBase {
  kind: 'document'
  page: PluginCallRequest
  list: PluginCallListing | null
  search: PluginCallListing | null
  /** The field of `page`'s answer holding the link to cite (a https URL on the declared host); null: none. */
  cite: string | null
}
export type PluginCall = PluginReadCall | PluginSearchCall | PluginActCall | PluginDocumentCall

/** How a contract-3 connector is called. Every part is the core's to carry out; a declaration only chooses. */
export interface PluginCalling {
  auth: { type: 'company_key'; header: string; format: typeof CALL_AUTH_FORMATS[number]; slots: Array<typeof CALL_AUTH_SLOTS[number]> } | null
  /** Headers telling the outside who acted; the member header says `ACTOR_SYSTEM` on a run with no member. */
  actor: { memberHeader: string; emailHeader: string | null } | null
  limits: { perMinute: number } | null
  /** The `code` at the top level of an error answer → what it means. */
  errors: { map: Record<string, CallFailureKind> } | null
  /** Where the outcome of an act is asked for: `{id}` once. */
  result: { path: string; statusField: string; map: Record<string, CallResultState> } | null
  signature: { scheme: typeof CALL_SIGNATURE_SCHEMES[number]; header: string; timestampHeader: string; maxAge: string } | null
}

/** What the outside can tell ACB happened. `use`: a business plugin's reaction, in a combined use only. */
export interface PluginEvent {
  fields: Record<string, PluginDataField>
  use: EventUse | null
}

/** Asking the outside what happened since the cursor. */
export interface PluginPoll {
  path: string
  cursor: PluginCursor
  items: string
  /** The entries' field naming the event (null: every entry is the same). */
  typeField: string | null
  every: string
  fields: Record<string, PluginDataField>
}

/** A business plugin's use of a connector's call. */
export interface CallUse { who: string[]; decision: boolean }
/** A business plugin's reaction to an event: the type's record whose `match` field equals the event's runs `action`. */
export interface EventUse { type: string; match: string; action: string }

/** Never runs without a person's approval: it reaches people outside, moves money, or creates a record (統合版: never `ok_from`, never direct). */
export const asksFirst = (op: Pick<PluginOperation, 'reaches' | 'createsRecord' | 'movesMoney'>): boolean =>
  op.reaches === 'external' || op.movesMoney || op.createsRecord

/** What the field-level money rule reads: the objects' record types and those types. */
export type MoneyFieldSource = { manifest: Pick<PluginManifest, 'objects'>; types: Record<string, Pick<TypeDefinition, 'fields'>> }

/**
 * Whether `field` of connector object `objectName` holds money: `money: true`
 * on that field of the object's record type. Such a field is written only
 * through an approval request, whichever operation writes it (plugins.md "Money").
 */
export function moneyField(pkg: MoneyFieldSource, objectName: string, field: string): boolean {
  const o = Object.prototype.hasOwnProperty.call(pkg.manifest.objects, objectName) ? pkg.manifest.objects[objectName] : undefined
  const type = o?.recordType && Object.prototype.hasOwnProperty.call(pkg.types, o.recordType) ? pkg.types[o.recordType] : undefined
  return isMoneyField(type, field)
}

/**
 * The one rule for "does writing `field` with `operationName` ask a person
 * first" (never `auto`, never `ok_from`, in a step only an approval request):
 * the operation asks first (`asksFirst`: outside, `moves_money`, a new record)
 * or the field holds money (`moneyField`). The declaration and mapping checks
 * (`priorFieldWriters`, `moneyField`) and the run-time policy
 * (`effectiveFieldPolicy`) all come back to these two.
 */
export function writeAsksFirst(pkg: MoneyFieldSource & { manifest: Pick<PluginManifest, 'operations'> }, operationName: string, field: string): boolean {
  const op = Object.prototype.hasOwnProperty.call(pkg.manifest.operations, operationName) ? pkg.manifest.operations[operationName] : undefined
  return op !== undefined && (asksFirst(op) || moneyField(pkg, op.object, field))
}

/**
 * How a business plugin uses one connector (owner decision 2026-11-01): which
 * connector, from which version on; which of its objects become which of the
 * business plugin's types; which of its operations the business plugin uses
 * and who may run them. A business plugin without one works inside ACB only.
 */
export interface ConnectorUse {
  /** `connector: <id> >= <version>` — the connector it can use and the oldest version that has what it needs. */
  connector: { id: string; minVersion: string }
  /** Connector object → the business plugin's type its items become (null: used without a record, e.g. contacts). */
  objects: Record<string, { recordType: string | null }>
  /** The connector's operations it uses: only these can run for it, with these people and rules. */
  operations: Record<string, OperationUse>
  /** Contract 3: the connector's calls it uses (absent: none). Only these are in a combined use. */
  calls?: Record<string, CallUse>
  /** Contract 3: the connector's events it reacts to (absent: none). */
  events?: Record<string, EventUse>
}

export interface OperationUse {
  who: string[]
  decision: boolean
  note: NoteRule
  /** A create's own policy (null: the default, `prior` when external or creating a record, else `auto`). */
  policy: FieldPolicy | null
  /** `moves_money: true` (contract 2): the operation moves money; it asks first like one reaching outside. */
  movesMoney: boolean
  /**
   * `via` (contract 2, plan 4b §5-13): where the operation may be called from
   * (`ACTION_VIA`; absent = `[screen, run]`). From a plugin's screen it only ever
   * becomes an approval request (the bridge has no direct run).
   */
  via?: ActionVia[]
  /** `similar: { by, search?, status? }` on a create of a record (any contract; checked against the connector by `combineUse`). */
  similar?: { by: SimilarBy[]; search: string | null; status: string | null }
}

/**
 * A role a business plugin needs (contract 2, owner decision 2026-11-01): the
 * business declares it (「企画の承認者」); who fills it is the company's
 * (FDE's default assignment, then per-bundle overrides — C3). Referred to as
 * `role:<name>` in an operation's `who`. Until assigned, a role matches no one.
 */
export interface PluginRoleDeclaration {
  label: string
  description: string | null
}

/** Where a step (or a pinned work's move to a new version) applies: one record type in one non-final state. */
export interface PluginStatePoint {
  type: string
  state: string
}

/**
 * How a step starts: `ai_turn` = automatically, when the record is in the AI's
 * turn (the member's PC picks it up, C5); `person` = a person starts it from
 * the record, which opens a consultation with the step's procedure.
 */
export const PLUGIN_STEP_STARTS = ['ai_turn', 'person'] as const
export type PluginStepStart = typeof PLUGIN_STEP_STARTS[number]

/**
 * A step's procedure (coordinator, 2026-11-02): the plugin's own default (a
 * file under `steps/`) and whether a company may put one of its own Skills
 * (`.claude/skills/<name>/`) in its place — 「提案書を用意する」 runs div's
 * `sales-proposal-v1` at div and the plugin's default elsewhere. Which Skill a
 * company uses is the company's setting (a later item); the step's `tools`
 * and `connectorRoles` stay the ceiling whichever procedure runs.
 */
export interface PluginStepProcedure {
  /** `steps/<file>.md`, a file of the package. */
  default: string
  /** A company may map this step to one of its Skills. */
  overridable: boolean
}

/**
 * What a work is pinned to for a step, recorded at its first run (owner
 * decision 2026-11-01 night: pinned per work; C5 stores it): the plugin's
 * procedure at a version and fingerprint, or the company Skill used instead,
 * by its content fingerprint (the same fingerprint #403 records for Skills in
 * consultations).
 */
export type PluginStepProcedurePin =
  | { source: 'plugin'; pluginId: string; version: string; fingerprint: string }
  | { source: 'company_skill'; skill: string; fingerprint: string }

/**
 * One step (contract 2, design 節目5 §4): when a record of `for.type` is in
 * `for.state`, the member's PC runs the AI once with the step's procedure,
 * only `tools` and the connector roles in `connectorRoles` — automatically
 * (`start: ai_turn`) or when a person starts it (`start: person`). Always on
 * the PC — there is no way to say "on the server". No scripts in 4a (§5-11),
 * no conditions or expressions. The procedure is pinned per work at its first
 * run (`PluginStepProcedurePin`).
 */
export interface PluginStep {
  label: string
  for: PluginStatePoint
  start: PluginStepStart
  procedure: PluginStepProcedure
  /** Names from `PLUGIN_STEP_TOOLS`: the most the step gets, also when a company Skill is its procedure. */
  tools: string[]
  /** Connector roles the step uses (`mail.send`, `calendar.read`…), resolved against the core's list of roles when it runs. */
  connectorRoles: string[]
}

/**
 * The plugin's screens (contract 2, design 節目5 §2; shown by the app's four
 * slots, stage 4b A6, `plugin-frame.md`). Frames talk to the core through one
 * bridge of version `bridge`; the core draws the peek, approvals and sending.
 */
export interface PluginUi {
  bridge: number
  /** A left tab: its label and icon drawn by the core, its content the frame at `entry`. */
  tab: { label: string; icon: string; entry: string } | null
  /** The peek over the tab, drawn by the core: which records it lists. */
  peek: { implements: string; stateGroup: string } | null
  /** A section inside a record card, its content the frame at `entry`. */
  recordSections: Array<{ type: string; label: string; entry: string }>
  /**
   * Items of the file list's right-click menu (drawn by the core): for files
   * or folders of `kinds` (`plugin-file-kinds.ts`); choosing one opens the
   * frame at `entry` with the chosen company path.
   */
  fileActions: Array<{ label: string; entry: string; kinds: string[] }>
}

/**
 * Where work pinned to an older version may move to this one (owner decision
 * 2026-11-01 night: work is pinned per work; it moves only at points the FDE
 * declares). `from`: the oldest version whose work may move; `at`: the states.
 */
export interface PluginUpgrade {
  from: string
  at: PluginStatePoint[]
}

/**
 * A company setting a business plugin offers (contract 2; the first rung of
 * the owner's "fit ladder": ① settings ② role assignment ③ a company Skill as
 * a step's procedure ④ a company extension of a plugin type ⑤ a separate
 * plugin). A typed parameter with a default and bounds; an owner/admin changes
 * it per company later, steps and approval rules read it. **Parameters only**:
 * nothing in a setting selects a state, an action or a step.
 */
export type PluginSetting =
  | { kind: 'number'; label: string; default: number; min: number | null; max: number | null }
  /** `<n>m` / `<n>h` / `<n>d` (minutes, hours, days). */
  | { kind: 'duration'; label: string; default: string; min: string | null; max: string | null }
  | { kind: 'choice'; label: string; default: string; options: string[]; optionLabels: Record<string, string> }
  | { kind: 'boolean'; label: string; default: boolean }
  /** A person by role: one of the plugin's `roles` or `dept_manager` / `admin`. */
  | { kind: 'role'; label: string; default: string }
  /** Which connected service serves a connector role for this plugin (null default: the company's usual one). */
  | { kind: 'connector'; label: string; connectorRole: string; default: null }

export const PLUGIN_SETTING_KINDS = ['number', 'duration', 'choice', 'boolean', 'role', 'connector'] as const

export interface PluginManifest {
  id: string
  label: string
  version: string
  kind: PluginKind
  role: PluginRole
  contract: number
  description: string | null
  /** The key broker's service whose key it uses (it never sees the value). '' for a business plugin. */
  service: string
  /** The one destination: https, exact host. Empty for a business plugin. */
  baseUrl: { host: string; basePath: string }
  scopes: string[]
  operationScopes: Record<string, string[]>
  /** A business plugin: the types it owns. A connector: none. */
  types: string[]
  /**
   * A connector: its objects (no record types: it knows no business plugin).
   * A business plugin: empty (its use of a connector is `uses`). A combined
   * use (`combineUse`): the objects the business plugin uses, with its types.
   */
  objects: Record<string, PluginObject>
  /** Likewise: a connector's operations (who / decision empty), or the combined use's. */
  operations: Record<string, PluginOperation>
  /** A connector's searches (`kind: search`; absent: none). Never an operation: a business plugin's `similar` names one. */
  searches?: Record<string, PluginSearch>
  /** Contract 3, a connector and a combined use (absent otherwise, so older packages read exactly as before). */
  calling?: PluginCalling
  /** Contract 3: a connector's calls, or the combined use's (those the business plugin declared, with its `who`). Never in `operations`. */
  calls?: Record<string, PluginCall>
  /** Contract 3: a connector's events, or the combined use's. */
  events?: Record<string, PluginEvent>
  /** Contract 3: a connector's polls; a combined use has them when it reacts to an event. */
  polls?: Record<string, PluginPoll>
  /** A business plugin's recommended field policies (a connector has none). */
  fieldPolicyDefaults: Record<string, FieldPolicy>
  /** A business plugin: how it uses its connector; null = it works inside ACB only. */
  uses: ConnectorUse | null
  /** Company ids that may use the package; null = every company (§8-4). */
  availableTo: string[] | null
  /**
   * The one GET that names the outside account the key belongs to (HubSpot:
   * the portal id). Required when the connector writes (an update or create
   * operation): a connection is bound to one account, and nothing is ever
   * written to another (review §5.7). Contract 3: the answer's fields holding
   * the account's id and its environment.
   */
  accountInfo: (PluginEndpoint & { idField?: string; environmentField?: string }) | null
  /**
   * A connector: its service's notification mail senders (`notification_senders`: addresses or
   * `@domain`, notification-senders.ts), left out of the mail intake while it is installed and on.
   * Absent: none.
   */
  notificationSenders?: string[]
  /** Contract 2, business plugins only (empty / null otherwise). */
  roles: Record<string, PluginRoleDeclaration>
  settings: Record<string, PluginSetting>
  steps: Record<string, PluginStep>
  ui: PluginUi | null
  upgrade: PluginUpgrade | null
}

export type PluginParsed<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export const PLUGIN_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const PLUGIN_VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/

/** Compare two `PLUGIN_VERSION_RE` versions numerically (negative: a is older). */
export function comparePluginVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

export type CommonPart = Pick<PluginManifest, 'id' | 'label' | 'version' | 'kind' | 'contract' | 'description' | 'availableTo'>

/** The parts only a contract-2 business plugin has (empty for contract 1 and connectors). */
export type FlowPart = Pick<PluginManifest, 'roles' | 'settings' | 'steps' | 'ui' | 'upgrade'>
export const noFlow = (): FlowPart => ({ roles: {}, settings: {}, steps: {}, ui: null, upgrade: null })

/** `role:<name>` in an operation's `who` (contract 2): a role the business plugin declares. */
export const ROLE_WHO_PREFIX = 'role:'
export const roleOfWho = (w: string): string | null => w.startsWith(ROLE_WHO_PREFIX) ? w.slice(ROLE_WHO_PREFIX.length) : null

/**
 * Operations writing mapped fields that reach people outside the company or
 * move money (`moves_money`) — `asksFirst` but for creating a record, whose
 * own policy holds it — optionally of one object: every field they write is
 * never `auto`, refused when declared or chosen, not only held at run time.
 * The field-level twin is `moneyField` (a money field is never `auto`
 * whichever operation writes it); `writeAsksFirst` joins the two.
 */
export function priorFieldWriters(manifest: Pick<PluginManifest, 'operations'>, objectName?: string): string[] {
  return Object.entries(manifest.operations)
    .filter(([, op]) => (op.reaches === 'external' || op.movesMoney) && op.fields === 'mapped' && (objectName === undefined || op.object === objectName))
    .map(([n]) => n)
}

/** `<id> >= <version>` of the connector a business plugin uses (null when it uses none). */
export const connectorName = (m: Pick<PluginManifest, 'uses'>): string | null => m.uses ? `${m.uses.connector.id} >= ${m.uses.connector.minVersion}` : null

/** Whether the package may be used by `companyId` (§8-4): no list = every company. The shelf filters with it (P4). */
export function pluginAvailableTo(manifest: Pick<PluginManifest, 'availableTo'>, companyId: string): boolean {
  return manifest.availableTo === null || manifest.availableTo.includes(companyId)
}

export interface PluginPackage {
  manifest: PluginManifest
  /** A business plugin: the types it owns. A connector: none. */
  types: Record<string, TypeDefinition>
}
