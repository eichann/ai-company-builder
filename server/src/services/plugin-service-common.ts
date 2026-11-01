/**
 * What every part of a company's plugins (`plugins.ts`, plugins.md "A
 * company's install, mapping and history") shares: the refusals' words, the
 * service's dependencies, a business plugin's running use of its connector
 * (`ActivePlugin`), and storing a business plugin's types.
 */
import type { PluginManifest, PluginMapping } from '../../shared/core/plugins'
import { canonicalTypeJson, type TypeDefinition } from '../../shared/core/record-types'
import type { PluginProblem } from '../../shared/types/plugins'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'
import type { PluginShelf } from './plugin-shelf'

export const PLUGINS_FORBIDDEN = 'つなぎ先のプラグインを設定できるのは、オーナーと管理者だけです'
/** What an owner / admin confirms before a field writes automatically (owner, 2026-10-31). */
export const AUTO_ACKNOWLEDGEMENT = 'この欄の変更をきっかけに動く HubSpot のワークフローがないか確かめました'

/** The acknowledged "property" of an automatic create operation: `create:<object>`. */
export const AUTO_CREATE_PREFIX = 'create:'

export const PLUGIN_NOT_FOUND = { error: 'このプラグインはありません', code: 'PLUGIN_NOT_FOUND' } as const
export const NOT_A_CONNECTOR = { error: '業務のプラグインには、つなぎ先の設定（鍵・中継で読める人・接続）はありません。それはつなぎ先（例：HubSpot）で設定します', code: 'NOT_A_CONNECTOR' } as const
export const NOT_A_BUSINESS = { error: 'つなぎ先には、読み替え表・取り込み・記録への操作はありません。それはつなぎ先を使う業務（例：法人営業）で設定します', code: 'NOT_A_BUSINESS' } as const
export const NO_CONNECTOR = { error: 'この業務は外のサービスにつながないため、読み替え表や取り込みはありません', code: 'NO_CONNECTOR' } as const

/** What a business plugin's mapping needs (owner decision 2026-11-01): its connector, at least that version, installed. */
export const connectorRequired = (label: string, minVersion: string) =>
  `先に「${label}」（${minVersion} 以上）を入れてください（読み替え表は「${label}」の項目と照らし合わせます）`

/** A business plugin's problems that mean "its connector is not there for it" (its connector-backed parts stop). */
export const CONNECTOR_PROBLEMS: readonly PluginProblem[] = ['connector-missing', 'connector-stopped', 'connector-mismatch', 'no-key', 'key-stopped', 'key-destination']

/**
 * Store a business plugin's types in the company (source `plugin`) unless a
 * version at least as new is there. Owner decision 2026-11-01: when it is
 * turned on, not at the first import (the import still does it, for a newer
 * version chosen meanwhile).
 */
export function storeBusinessTypes(companyData: CompanyDataSource, companyId: string, types: Record<string, TypeDefinition>, at: string): void {
  const records = companyData.forCompany(companyId).records
  const stored = new Map<string, number>()
  for (const row of records.typeVersions()) stored.set(row.name, Math.max(stored.get(row.name) ?? 0, row.version))
  for (const def of Object.values(types)) {
    if ((stored.get(def.name) ?? 0) >= def.version) continue
    records.insertTypeVersion({ name: def.name, version: def.version, definition: canonicalTypeJson(def), source: 'plugin', commitSha: null, createdAt: at })
  }
}

/** What the connector needs to know about a key (never its value). */
export interface PluginKeyInfo {
  scope: string
  service: string
  status: string
  hosts: string[]
}

export interface PluginServiceDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  shelf: PluginShelf
  /** The company's broker key `keyId`, or null (another company's key id finds nothing). */
  companyKey: (companyId: string, keyId: string) => PluginKeyInfo | null
  isMember: (companyId: string, userId: string) => boolean
  /** The member's role in the company, or null. */
  roleOf: (companyId: string, userId: string) => string | null
  /**
   * Turn the relay's read-only switch on for the service (owner 0.21: once the
   * connector is on, writes to it go only through the typed operations).
   * Recorded in the key broker's history as this member's change.
   */
  relayReadOnly: (member: Member, service: string) => void
}

/**
 * A business plugin's use of its connector, ready to run (everything
 * `active()` checked). Keyed by the business plugin: its id is what routes,
 * links, operations and the ledger name; the key, connection and account are
 * its connector's.
 */
export interface ActivePlugin {
  /** The business plugin. */
  pluginId: string
  /** The business plugin's version. */
  version: string
  /** The connector it uses, and its installed version. */
  connectorId: string
  connectorVersion: string
  /** The combined use (`combineUse`): only the objects and operations the business plugin declared. */
  manifest: PluginManifest
  /** The business plugin's types. */
  types: Record<string, TypeDefinition>
  mapping: PluginMapping
  mappingVersion: number
  keyId: string
  /** Both packages' fingerprints (`<business>+<connector>`, kept on every ledger receipt): either changing makes an approval stale. */
  fingerprint: string
  connectionId: string
  /** The outside account, once the connector has bound the connection to it. */
  accountId: string | null
}
