/**
 * The shape of a plugin declaration (`plugin.yaml`) once parsed: the two roles
 * (connector, business plugin), their objects and operations, a business
 * plugin's use of its connector, and the small facts every other plugin module
 * reads (contract, actors, the fixed endpoints, `available_to`). Parsing is in
 * `plugin-manifest.ts`; the overview and owner rules are in `plugins.ts`.
 */
import type { NoteRule, TypeDefinition } from './record-types'

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

/** The plugin contract this build understands (0.17). A declaration naming another is not used. */
export const PLUGIN_CONTRACT = 1

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
}

export interface OperationUse {
  who: string[]
  decision: boolean
  note: NoteRule
  /** A create's own policy (null: the default, `prior` when external or creating a record, else `auto`). */
  policy: FieldPolicy | null
}

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
   * written to another (review §5.7).
   */
  accountInfo: PluginEndpoint | null
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

/** Update operations reaching people outside the company (they write mapped fields), optionally of one object. */
export function externalFieldWriters(manifest: Pick<PluginManifest, 'operations'>, objectName?: string): string[] {
  return Object.entries(manifest.operations)
    .filter(([, op]) => op.reaches === 'external' && op.fields === 'mapped' && (objectName === undefined || op.object === objectName))
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
