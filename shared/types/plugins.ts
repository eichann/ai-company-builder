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
  /** Why the mapping in force does not pass, when it does not (Japanese sentences). */
  mappingErrors: string[]
  /** Latest first (50). `change` is JSON without any secret. */
  history: Array<{ action: string; at: string; by: string; change: unknown }>
}
