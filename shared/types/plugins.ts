/**
 * API contract of connector plugins (milestone 3, `.claude/rules/plugins.md`):
 * the shelf as a company sees it, the company's install, its mapping
 * versions and history. Owner/admin only (the admin page 「つなぎ先」, P8).
 * No answer ever holds a key value: an install names the key by id.
 */
import type { FieldPolicy, OperationKind, OperationReach, PluginKind, UndoKind } from '../core/plugins'

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
  description: string | null
  /** The key broker's service whose company key it uses. */
  service: string
  /** The one destination host. */
  host: string
  scopes: string[]
  operationScopes: Record<string, string[]>
  types: string[]
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
  recordId: string
  /** The record's title now (null when it has none). */
  recordTitle: string | null
  /** pending / sent-unknown / external-ok / applied / observed / failed. */
  state: 'pending' | 'sent-unknown' | 'external-ok' | 'applied' | 'observed' | 'failed'
  /** The ACB fields and values asked for. */
  fields: Record<string, PluginFieldValue>
  /** For an applied write: each field's value before → after, from its ledger entry. */
  changes: Array<{ field: string; before: PluginFieldValue; after: PluginFieldValue }> | null
  /** How the values of these fields are shown (a choice's `option_labels`): field → value → label. */
  valueLabels: Record<string, Record<string, string>>
  /** Who asked: a person or their AI (the credential decided). */
  actorKind: 'human' | 'ai'
  /** Why it is in its state (`rate-limited`, `not-observed`, `observed-actor-unknown`, …); not the AI's note. */
  reason: string | null
  /** Only an applied update (ACB's own confirmed write) not undone yet. */
  undoable: boolean
  undoLabel: string
  undoNotice: string
  undoOf: string | null
  undoneBy: string | null
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
  /** `auto` writes at once; `prior` is refused in milestone 3 (a person approves first). `off` fields are not listed. */
  policy: 'auto' | 'prior'
}

/** An operation the member's AI may call (P7: one tool each). */
export interface PluginAiOperation {
  name: string
  label: string
  kind: 'read' | 'update'
  /** The ACB record type the operation acts on. */
  recordType: string
  /** The AI must give a reason (drafted from the consultation, citing its basis). */
  decision: boolean
  /** For an update: the fields it may write now (none `off`). */
  fields: PluginAiField[]
}

/** The company's running connector plugins, as the member's AI may use them (GET /api/records-ai/plugins). */
export interface PluginAiTools {
  plugins: Array<{ id: string; label: string; operations: PluginAiOperation[] }>
}
