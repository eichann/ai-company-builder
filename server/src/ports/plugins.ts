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
}
