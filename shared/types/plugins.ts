/**
 * API contract of connector plugins (milestone 3, `.claude/rules/plugins.md`):
 * the shelf as a company sees it, the company's install, its mapping
 * versions and history. Owner/admin only (the admin page 「つなぎ先」, P8).
 * No answer ever holds a key value: an install names the key by id.
 */
import type { FieldPolicy, OperationKind, OperationReach, PluginKind, PluginRole, PluginStepProcedurePin, PluginStepStart, UndoKind } from '../core/plugins'

/** Why a company's plugin cannot run now (each kill switch and each missing piece). */
export type PluginProblem =
  /** Turned off by the company's owner/admin (or never turned on). */
  | 'off'
  /** Stopped for every company by the operator (`<PLUGINS_DIR>/stopped`). */
  | 'stopped'
  /** The installed version is not on the shelf for this company (removed, or no longer available to it). */
  | 'not-on-shelf'
  /** The package on the shelf changed since an owner/admin chose it (fingerprint): choose the version again. */
  | 'package-changed'
  /** No company key chosen, or it was deleted, or it is not a company key of the plugin's service. */
  | 'no-key'
  /** The chosen key is stopped (「鍵を止める」 / 「すべての鍵を止める」). */
  | 'key-stopped'
  /** The key may not be sent to the plugin's destination (its hosts). */
  | 'key-destination'
  /** No mapping, or the mapping in force no longer passes the checks. */
  | 'mapping-invalid'
  /** A field would write automatically without the recorded acknowledgement (no HubSpot workflow is triggered by it). */
  | 'auto-not-acknowledged'
  /** A business plugin: the connector it uses is not installed (or not at a version it accepts, or no longer on the shelf). */
  | 'connector-missing'
  /** A business plugin: its connector is installed but does not run (off, stopped by the operator, its package changed). */
  | 'connector-stopped'
  /** A business plugin: the installed connector version lacks an object or operation it uses. */
  | 'connector-mismatch'
  /** A business plugin that uses no connector: it works inside ACB only (no import, mapping or operations). */
  | 'no-connector'
  /** A connector asked for what only a business plugin has (import, mapping, operations on records). */
  | 'not-a-business'

export interface PluginOperationView {
  name: string
  label: string
  kind: OperationKind
  reaches: OperationReach
  undo: UndoKind
}

export interface PluginPackageView {
  id: string
  label: string
  version: string
  kind: PluginKind
  /** `connector` (talks to one outside system, owns no type) or `business` (owns types, may use one connector). */
  role: PluginRole
  description: string | null
  /** The key broker's service whose company key it uses ('' for a business plugin). */
  service: string
  /** The one destination host ('' for a business plugin). */
  host: string
  scopes: string[]
  operationScopes: Record<string, string[]>
  /** The types it owns (a business plugin); a connector owns none. */
  types: string[]
  /**
   * A business plugin: the connector it can use and the oldest version it
   * accepts (the connector's label from the shelf as this company sees it;
   * the id when not there). null for a connector and for a business plugin
   * that works inside ACB only.
   */
  connector: { id: string; minVersion: string; label: string } | null
  operations: PluginOperationView[]
  fingerprint: string
  /** Stopped for every company by the operator. */
  stopped: boolean
}

export interface PluginInstallView {
  version: string
  enabled: boolean
  keyId: string | null
  mappingVersion: number
  /** The connection: a new one when the outside account changes (a key rotation keeps it). */
  connectionId: string
  /** The outside account (HubSpot's portal id), known after the connector's first call. */
  accountId: string | null
  /** First turned on: from then on the relay only reads this service for the company, even when the plugin is off. */
  managedSince: string | null
  updatedAt: string
  updatedBy: string
  /** null = it runs; otherwise the first reason it does not. */
  problem: PluginProblem | null
}

export interface PluginListItem {
  id: string
  /** The shelf's versions this company may use (oldest first); empty when none is (any more). */
  versions: PluginPackageView[]
  install: PluginInstallView | null
}

export interface PluginFieldPolicyView {
  operation: string
  object: string
  field: string
  policy: FieldPolicy
}

export interface PluginDetail {
  plugin: PluginListItem
  /** The mapping in force (YAML), null before one exists. */
  mapping: { version: number; text: string; createdAt: string; createdBy: string } | null
  mappingVersions: Array<{ version: number; createdAt: string; createdBy: string }>
  /** What each written field does now (auto / prior / off), from the mapping in force. */
  policies: PluginFieldPolicyView[]
  /** Per mapped object: its record type's name and each field's (from the installed package's types; empty before install). */
  labels: Record<string, { label: string; fields: Record<string, string> }>
  /** Why the mapping in force does not pass, when it does not (Japanese sentences). */
  mappingErrors: string[]
  /** Who confirmed, per automatically written field and its outside property, that no HubSpot workflow is triggered by it. */
  autoAcknowledgements: Array<{ field: string; property: string; by: string; at: string }>
  /** Latest first (50). `change` is JSON without any secret. */
  history: Array<{ action: string; at: string; by: string; change: unknown }>
  /** Who may read the outside system through the relay, for the current connection (empty = nobody; required to turn on). */
  readScope: PluginReadScopeView
}

/**
 * A connection's relay read scope (owner, 2026-10-31): departments (members who
 * can read the department's folder) and members, by id. No filtering by record
 * inside it; writes never go through the relay.
 */
export interface PluginReadScopeView {
  departmentIds: string[]
  userIds: string[]
}

/** One object's part of an import run (`POST …/import`, P5). */
export interface ImportObjectReport {
  seen: number
  created: number
  updated: number
  unchanged: number
  /** The mapping's `max` stopped the run before the outside system's last result. */
  truncated: boolean
  /** Field names (never values) the mapping could not translate, with counts. */
  problems: Record<string, number>
}

/** What an import run did — as it happened, never "all synchronised" (review §6.8). Also kept in the history (`import`). */
export interface ImportReport {
  status: 'complete' | 'truncated' | 'stopped' | 'failed' | 'timed-out'
  /** Why it stopped or failed (a fixed word), else null. */
  reason: string | null
  objects: Record<string, ImportObjectReport>
  startedAt: string
  finishedAt: string
}

/**
 * 「HubSpot に聞いて確かめる」 (P8): a mapping checked against the outside
 * system's real property list (`checkMappingAgainstProperties`). Sentences
 * and fixed words only — never a key, never the outside system's answer.
 */
export interface PluginMappingCheck {
  /** false: the outside system could not be asked (the mapping can still be saved). */
  reachable: boolean
  /** Why it could not be asked (a fixed word: key-rejected, not-permitted, rate-limited, server-error, …), else null. */
  reason: string | null
  /** Per mapped object that has a property list: what does not match (errors) or deserves a look (warnings). */
  objects: Record<string, { errors: string[]; warnings: string[] }>
  checkedAt: string
}

/** A value of an ACB field, as the operation records keep it. */
export type PluginFieldValue = string | number | boolean | null

/**
 * An operation record (操作の控え) as its record's readers see it (P6/P7):
 * the answer of a typed operation, of 「変更前の値を書き戻す」 and of
 * reconciling. Never holds an outside value the mapping did not translate.
 */
export interface PluginOperationRecordView {
  id: string
  operation: string
  /**
   * The record written, or the one a create is attached to (log_meeting: the
   * deal); for a create of a record (create_deal), null until it exists.
   */
  recordId: string | null
  /** update / create (milestone 4) / undo (also the archive of a create). */
  kind: 'update' | 'create' | 'undo'
  /** The record's title now (null when it has none). */
  recordTitle: string | null
  /** pending / sent-unknown / external-ok / applied / observed / failed. */
  state: 'pending' | 'sent-unknown' | 'external-ok' | 'applied' | 'observed' | 'failed'
  /**
   * The ACB fields and values asked for; for a create, what it carries in ACB
   * words (log_meeting: `title`, `at`, `body`, `outcome`; create_deal: `title` and its fields).
   */
  fields: Record<string, PluginFieldValue>
  /** For an applied write: each field's value before → after, from its ledger entry. */
  changes: Array<{ field: string; before: PluginFieldValue; after: PluginFieldValue }> | null
  /** How the values of these fields are shown (a choice's `option_labels`): field → value → label. */
  valueLabels: Record<string, Record<string, string>>
  /** Who asked: a person or their AI (the credential decided). */
  actorKind: 'human' | 'ai'
  /** Why it is in its state (`rate-limited`, `not-observed`, `observed-actor-unknown`, …); not the AI's note. */
  reason: string | null
  /**
   * Only an applied update or create (ACB's own confirmed write — for a create
   * also one found again by its correlation value) not undone yet.
   */
  undoable: boolean
  undoLabel: string
  undoNotice: string
  undoOf: string | null
  undoneBy: string | null
  /** A create made again after a lost answer (「もう一度作る」): the new operation. */
  replacedBy: string | null
  /**
   * A create whose answer was lost and which reconciling did not find: a person
   * may make it again (「もう一度作る」, with a warning; a new operation).
   */
  recreatable: boolean
  /** Approved by a person (milestone 4) — their id; null for a direct run. */
  approvedBy: string | null
  recordVersion: number | null
  createdAt: string
}

/** A written field of an operation, for the member's AI (P7). */
export interface PluginAiField {
  name: string
  label: string
  kind: string
  /** A choice field's options (ACB words). */
  options?: string[]
  /** How the options are shown to people (value → label), when the type says. */
  optionLabels?: Record<string, string>
  /** `auto` writes at once; `prior` needs a person's approval (refused with APPROVAL_REQUIRED for now). `off` fields are not listed. */
  policy: 'auto' | 'prior'
}

/** An operation the member's AI may call (P7: one tool each). */
export interface PluginAiOperation {
  name: string
  label: string
  kind: 'read' | 'update' | 'create'
  /** The ACB record type the operation acts on (a create attached to a record: that record's type; a create of a record: the new one's). */
  recordType: string
  /** The AI must give a reason (drafted from the consultation, citing its basis). */
  decision: boolean
  /** For an update, and a create of a record: the fields it may write now (none `off`). */
  fields: PluginAiField[]
  /** A create (milestone 4): its policy now — `auto` runs at once, `prior` needs a person's approval. */
  policy?: 'auto' | 'prior'
  /** A create attached to a record (log_meeting): the content slots it takes (`title`, `body`, `at`, `outcome`). */
  content?: string[]
  /** A create that makes a new record (create_deal): no record id is given. */
  createsRecord?: boolean
}

/** A contract-3 call the member's AI may ask (one tool each; a document's page, list and search are one each). */
export interface PluginAiCall {
  name: string
  /** A document's part; null for a read or a search. */
  part: 'page' | 'list' | 'search' | null
  label: string
  inputs: Array<{ name: string; kind: 'id' | 'text' | 'number' | 'boolean' | 'date'; required: boolean; label: string | null }>
  /** A list or search with a next page: the tool takes `cursor`. */
  cursor: boolean
}

/** The company's running connector plugins, as the member's AI may use them (GET /api/records-ai/plugins). */
export interface PluginAiTools {
  /** `calls`: absent from an older server, ignored by an older app. */
  plugins: Array<{ id: string; label: string; operations: PluginAiOperation[]; calls?: PluginAiCall[] }>
}

/** What came back from one read of a contract-3 call. Only what the declaration's `returns` names. */
export interface PluginCallAnswer {
  outcome: 'ok' | 'failed'
  call: string
  part: 'page' | 'list' | 'search' | null
  /** A read or a page: its fields. A value wrapped `{ outsideText, instructionLike }` is outside text. */
  data: Record<string, unknown> | null
  /** A list or a search: its entries. */
  items: Array<Record<string, unknown>> | null
  /** The next cursor of a list or a search. */
  next: string | null
  /** A page: the link to cite. */
  cite: string | null
  /** Answer fields nobody declared: left out, counted. */
  dropped: number
  /** `failed`: the core's failure class, and the outside's code when it gave one. */
  failure?: 'temporary' | 'permission' | 'bad-input' | 'unknown-result'
  code?: string
}

/** One line of `GET /plugins/:id/access-log`. */
export interface PluginAccessLogEntry {
  at: string
  userId: string
  actorKind: 'human' | 'ai'
  call: string
  /** `input`: the plain id inputs. `returned`: the ids of the entries handed on (never a search word); `more`: how many past the limit. */
  refs: { input: Record<string, string>; returned: string[]; more: number }
  /** `ok`, a failure's class, or `stopped` (stopped after a first attempt went out). */
  status: string
  dropped: number
  conversationId: string | null
  runId: string | null
}

/**
 * A business plugin's package the member's app keeps (plan C2, plugins.md
 * "Handing packages to the app"): listed in the agent policy
 * (`GET /me/agent-policy` → `plugins`) for every member of a company that
 * turned the plugin on. `current` is the version the company chose; `pinned`
 * an older one some work is still pinned to (stored by C5). A plugin turned
 * off, or a version the operator stopped, is not listed: the app removes it.
 */
export interface DistributedPlugin {
  id: string
  version: string
  /** Fingerprint v2 (shared/core/plugin-fingerprint.ts): what the app checks the files against. */
  fingerprint: string
  use: 'current' | 'pinned'
}

/**
 * A business plugin's step as it applies to a record (plan C5,
 * plugin-steps.md): the step's ceiling — its `tools` and `connector_roles`,
 * never more whichever procedure runs.
 */
export interface PluginStepView {
  pluginId: string
  step: string
  label: string
  start: PluginStepStart
  /** The plugin procedure's file in the package (`steps/<name>.md`), of the version the work runs. */
  procedure: string
  tools: string[]
  connectorRoles: string[]
}

/** GET …/me/plugin-steps/records/:recordId: a step at the record's state, with the work's pin (null before its first run). */
export interface PluginStepOnRecord extends PluginStepView {
  pin: PluginStepProcedurePin | null
}

/** GET …/me/plugin-step-turns: one record waiting at a `start: ai_turn` step (the member's 「AI の番」). */
export interface PluginStepTurn extends PluginStepView {
  recordId: string
  /** The record's version now. */
  version: number
}

/**
 * POST …/me/plugin-steps/records/:recordId/:pluginId/:step/start (a
 * `start: person` step): the work's pinned procedure and the step's ceiling.
 */
export interface PluginStepStartView extends PluginStepView {
  recordId: string
  version: number
  pin: PluginStepProcedurePin
}

/** GET / PUT …/plugins/:pluginId/step-skills (owner/admin): the company's Skill per overridable step. */
export interface PluginStepSkillsView {
  steps: Array<{ step: string; label: string; overridable: boolean; skill: string | null }>
}

/**
 * GET …/plugins/:pluginId/roles (owner/admin; plan C3, plugin-roles.md): the
 * business plugin's declared roles with the company's assignment, the
 * まとまり overrides and the history (member ids only).
 */
export interface PluginRolesView {
  pluginId: string
  label: string
  roles: Array<{ name: string; label: string; description: string | null; userIds: string[] }>
  /** A まとまり's own holders; `title` only when the viewer may read that record. */
  overrides: Array<{ role: string; bundleId: string; title: string | null; userIds: string[] }>
  history: Array<{ role: string; bundleId: string | null; action: 'assign' | 'override' | 'clear-override'; userIds: string[]; at: string; by: string }>
}

/** GET …/plugins/:pluginId/package/:version (any member, a listed version only): the package's files. */
export interface PluginPackageDownload {
  id: string
  version: string
  fingerprint: string
  /** Every file of the package (`signature.yaml` too; it is not part of the fingerprint), bytes as base64. */
  files: Array<{ path: string; base64: string }>
}
