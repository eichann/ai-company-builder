/**
 * Connector plugins (milestone 3, `.claude/rules/plugins.md`).
 *
 * Two kinds of storage, two ports:
 * - the **shelf** (`PluginShelfSource`): the packages the operator put in
 *   `PLUGINS_DIR`, shared by every company and read only; it holds no
 *   company's data;
 * - each company's **install, mapping versions and history**
 *   (`PluginRepository`), reached only through the company handle
 *   (ports/company-data.ts): no method takes a company, every statement is
 *   limited to the handle's company.
 */

/** One package folder as found on the shelf (the files' text; nothing parsed yet). */
export interface PluginPackageFiles {
  /** The folder's name (`<id>@<version>`). */
  dir: string
  manifest: string
  /** Type name → the text of `types/<name>.md`. */
  types: Record<string, string>
  mapping: string | null
  /** sha256 over every file of the package (names and contents), hex. */
  fingerprint: string
}

export interface PluginShelfScan {
  packages: PluginPackageFiles[]
  /** Folders that could not be read as a package: the folder name and why (never file contents). */
  problems: Array<{ dir: string; reason: string }>
}

export interface PluginShelfSource {
  /** Read every package folder (startup). */
  scan(): Promise<PluginShelfScan>
  /**
   * The server-wide stop list (`<PLUGINS_DIR>/stopped`: `id` or `id@version` per
   * line), read on every call. `*` = every package (also when the file exists
   * but cannot be read).
   */
  stopped(): Promise<string[]>
}

export interface PluginInstallRow {
  pluginId: string
  version: string
  /** The package's fingerprint when an owner/admin chose this version: a changed package is not used. */
  fingerprint: string
  /** The key broker's service the plugin talks to. */
  service: string
  /** The connection (a new id when the outside account changes; a key rotation keeps it). */
  connectionId: string
  /** The outside account (HubSpot's portal id), set by the connector's first call; null until then. */
  accountId: string | null
  enabled: boolean
  /** When first turned on; from then on the relay never writes to `service` for this company. */
  managedSince: string | null
  /** The key broker's company key the connector uses (never its value). */
  keyId: string | null
  /** The mapping version in force. */
  mappingVersion: number
  updatedAt: string
  updatedBy: string
}

export interface PluginMappingRow {
  pluginId: string
  version: number
  /** The mapping as YAML (the strict subset of shared/core/yaml-lite.ts). */
  text: string
  createdAt: string
  createdBy: string
}

export interface PluginHistoryRow {
  id: string
  pluginId: string
  /** install / version / key / enable / disable / mapping / restore */
  action: string
  at: string
  by: string
  /** JSON without any secret. */
  change: string
}

export interface ExternalLinkRow {
  pluginId: string
  connectionId: string
  accountId: string
  object: string
  externalId: string
  recordId: string
  externalUpdatedAt: string | null
  seenAt: string
}

export interface PluginPolicyAckRow {
  pluginId: string
  field: string
  /** The outside property the field writes; an ack for another property does not count. */
  property: string
  acknowledgedBy: string
  acknowledgedAt: string
}

export type PluginOperationState = 'pending' | 'sent-unknown' | 'external-ok' | 'applied' | 'observed' | 'failed'

/** 操作の控え: one write of a typed operation, recorded before it is sent. */
export interface PluginOperationRow {
  id: string
  pluginId: string
  /** The declaration's operation (`update_deal`), or `undo`. */
  operation: string
  pluginVersion: string
  fingerprint: string
  mappingVersion: number
  connectionId: string
  accountId: string
  object: string
  /** The outside object written; for a create, the object it made — null until its id is known. */
  externalId: string | null
  /**
   * The record written (update) or the one a create is attached to; for a
   * create of a record (create_deal), null until the record exists.
   */
  recordId: string | null
  actorId: string
  actorKind: 'human' | 'ai'
  actorSource: string | null
  conversationId: string | null
  state: PluginOperationState
  /** JSON: the ACB fields and values asked for. */
  fields: string
  /** JSON: outside property → raw value sent. */
  written: string
  /** JSON: outside property → raw value read just before (what an undo writes back). */
  previous: string
  /** A fixed word (failed / unknown), never an outside body. */
  reason: string | null
  /** For an undo: the operation it compensates. */
  undoOf: string | null
  /** The undo that compensated this one. */
  undoneBy: string | null
  /** The record's version the operation's ledger entry made. */
  recordVersion: number | null
  createdAt: string
  updatedAt: string
  /** A create whose answer was lost and that a person made again (「もう一度作る」): the new operation. */
  replacedBy: string | null
  /** The person who approved it (milestone 4, `executeApproved`); null for a direct run. */
  approvedBy: string | null
}

/** One subject of a connection's relay read scope: a department (members who can read its folder) or a member. */
export interface PluginReadScopeEntry {
  type: 'department' | 'user'
  id: string
}

export interface PluginRepository {
  install(pluginId: string): PluginInstallRow | null
  installs(): PluginInstallRow[]
  /** Insert or replace the install row and add a history row (one transaction). */
  saveInstall(row: PluginInstallRow, history: PluginHistoryRow): void
  /** A mapping version, with its text. */
  mapping(pluginId: string, version: number): PluginMappingRow | null
  /** Every version, newest first, without the text. */
  mappingVersions(pluginId: string): Array<Omit<PluginMappingRow, 'text'>>
  /**
   * Store the next mapping version and make it the one in force, with a
   * history row (one transaction). Needs the install row.
   */
  addMapping(row: PluginMappingRow, history: PluginHistoryRow): void
  /** Latest first. */
  history(pluginId: string, limit: number): PluginHistoryRow[]
  addHistory(row: PluginHistoryRow): void

  /**
   * Bind the connection to the outside account the connector saw, only while
   * it has none (compare-and-set); false = another value is already there.
   */
  bindAccount(pluginId: string, connectionId: string, accountId: string, history: PluginHistoryRow): boolean
  /**
   * A new connection (the outside account changed): new id, no account yet. Links of the old one
   * stay with it; the read scope is carried over (the same people, decided by an owner / admin).
   */
  renewConnection(pluginId: string, connectionId: string, at: string, by: string, history: PluginHistoryRow): void

  /** The record of an outside object of this connection and account. */
  link(connectionId: string, accountId: string, object: string, externalId: string): ExternalLinkRow | null
  /** The outside object a record stands for. */
  linkOfRecord(recordId: string): ExternalLinkRow | null
  /**
   * Records imported through a connection that is no longer the plugin's
   * current one (「新しいつなぎ先として始める」 started another) and not
   * linked through the current one: kept, never deleted, but no longer used.
   */
  oldConnectionRecordIds(): string[]
  saveLink(row: ExternalLinkRow): void

  /** Who may read the outside system through the relay, for this connection (none = closed). */
  readScope(pluginId: string, connectionId: string): PluginReadScopeEntry[]
  /** Replace the connection's read scope and add a history row (one transaction). */
  setReadScope(pluginId: string, connectionId: string, entries: PluginReadScopeEntry[], at: string, by: string, history: PluginHistoryRow): void
  policyAcks(pluginId: string): PluginPolicyAckRow[]
  /** Record acknowledgements (replacing a field's earlier one) and a history row (one transaction). */
  addPolicyAcks(rows: PluginPolicyAckRow[], history: PluginHistoryRow): void
  insertOperation(row: PluginOperationRow): void
  /**
   * Move an operation on (only its state, reason, record version, undone_by,
   * replaced_by change; a create's outside id and record are set once, from null).
   */
  updateOperation(id: string, changes: Partial<Pick<PluginOperationRow, 'state' | 'reason' | 'recordVersion' | 'undoneBy' | 'replacedBy' | 'externalId' | 'recordId'>>, at: string): void
  operation(id: string): PluginOperationRow | null
}
