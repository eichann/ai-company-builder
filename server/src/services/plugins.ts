/**
 * A company's plugins (milestone 3 P4, `.claude/rules/plugins.md`): which
 * package of the shelf it uses (version, fingerprint), on / off, and the
 * history. Owners and admins only; a department manager or member gets 403,
 * a non-member 404 (the route).
 *
 * Two roles (owner decision 2026-11-01, plugins.md "Two roles"): a
 * **connector** is a company-wide shared part — installed, turned on and
 * stopped on its own, with the company key, the connection (account), the
 * relay's read scope and read-only switch; it knows no business plugin. A
 * **business plugin** owns types (stored in the company as soon as it is
 * turned on) and, when it names a connector (`connector: hubspot >= 0.3.0`),
 * the mapping (読み替え表, versioned, field policies included), the
 * acknowledged automatic fields, the import and the typed operations: what
 * runs is the business plugin's use of the connector (`combineUse`), keyed by
 * the business plugin's id. Without its connector (absent, off, stopped, too
 * old) the business plugin still works inside ACB; only its connector-backed
 * parts stop (`connector-*`, 「HubSpot との行き来は止まっています」). One type
 * name has one owner.
 *
 * `active()` is what the connector (P5) and the typed operations (P6) ask
 * before every call: it re-decides every kill switch each time (the
 * operator's stop and the company's switch of both plugins, the packages'
 * fingerprints, the key and its status, the mapping), so each takes effect
 * from the next call.
 *
 * Every company row is reached through the company handle; the shelf is
 * shared and read only, filtered by `available_to` for the asking company.
 */
import { findPrivateScope } from '../../shared/core/permissions'
import {
  combineUse, effectiveFieldPolicy, effectiveOperationPolicy, parsePluginMapping, type PluginManifest, type PluginMapping, type PluginPackage,
} from '../../shared/core/plugins'
import { canonicalTypeJson, type TypeDefinition } from '../../shared/core/record-types'
import type { PluginAiField, PluginAiOperation, PluginAiTools, PluginDetail, PluginReadScopeView, PluginFieldPolicyView, PluginInstallView, PluginListItem, PluginPackageView, PluginProblem } from '../../shared/types/plugins'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { PluginHistoryRow, PluginInstallRow, PluginReadScopeEntry } from '../ports/plugins'
import { requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import type { PluginShelf, ShelfPackage } from './plugin-shelf'
import { recordReader } from './record-access'

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

/** The body's acknowledged field names (absent = none); null when malformed. */
const ackList = (v: unknown): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === 'string' && x.length <= 40) ? v as string[] : null
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const MAPPING_MAX = 128 * 1024

function packageView(p: ShelfPackage, stopped: boolean, connector: ShelfPackage | null): PluginPackageView {
  const m = p.pkg.manifest
  const uses = m.uses
  // A business plugin lists the connector operations it uses (described by the newest connector version this company may use).
  const operations = uses
    ? Object.keys(uses.operations).map(name => {
      const op = connector?.pkg.manifest.operations[name]
      return { name, label: op?.label ?? name, kind: op?.kind ?? 'read', reaches: op?.reaches ?? 'internal', undo: op?.undo ?? 'none' }
    })
    : Object.entries(m.operations).map(([name, op]) => ({ name, label: op.label, kind: op.kind, reaches: op.reaches, undo: op.undo }))
  return {
    id: m.id, label: m.label, version: m.version, kind: m.kind, role: m.role, description: m.description, service: m.service, host: m.baseUrl.host,
    scopes: m.scopes, operationScopes: m.operationScopes, types: m.types, fingerprint: p.fingerprint, stopped,
    connector: uses ? { id: uses.connector.id, minVersion: uses.connector.minVersion, label: connector?.pkg.manifest.label ?? uses.connector.id } : null,
    operations,
  }
}

/** A business plugin's problems that mean "its connector is not there for it" (its connector-backed parts stop). */
const CONNECTOR_PROBLEMS: readonly PluginProblem[] = ['connector-missing', 'connector-stopped', 'connector-mismatch', 'no-key', 'key-stopped', 'key-destination']

export function createPluginService(deps: PluginServiceDeps) {
  const { companyData, clock, shelf } = deps

  const history = (pluginId: string, action: string, by: string, at: string, change: Record<string, unknown>): PluginHistoryRow =>
    ({ id: deps.ids.newId(), pluginId, action, at, by, change: JSON.stringify(change) })

  /**
   * The checks only the server can make (beyond the package's own rules):
   * people tables name this company's members, and records are never placed
   * in a private folder (their reads assume a public place, records.md).
   */
  function serverMappingProblems(companyId: string, mapping: PluginMapping): string[] {
    const problems: string[] = []
    const scopes = companyData.forCompany(companyId).scopes.listWithRules()
    for (const [name, o] of Object.entries(mapping.objects)) {
      if (o.visibleToFolder !== null && findPrivateScope(scopes, o.visibleToFolder)) {
        problems.push(`「${name}」の visible_to_folder に、非公開のフォルダ（またはその中）は選べません`)
      }
    }
    for (const [table, rows] of Object.entries(mapping.people)) {
      for (const [ext, member] of Object.entries(rows)) {
        if (!deps.isMember(companyId, member)) problems.push(`people の「${table}」の「${ext}」: ${member} はこの会社のメンバーではありません`)
      }
    }
    return problems
  }

  function parseForCompany(companyId: string, pkg: PluginPackage, text: string): { ok: true; mapping: PluginMapping } | { ok: false; errors: string[] } {
    const parsed = parsePluginMapping(text, pkg)
    if (!parsed.ok) return parsed
    const problems = serverMappingProblems(companyId, parsed.value)
    return problems.length > 0 ? { ok: false, errors: problems } : { ok: true, mapping: parsed.value }
  }

  /** The key problem for this connector, or null when it may use it. */
  function keyProblem(companyId: string, manifest: PluginManifest, keyId: string | null): PluginProblem | null {
    if (keyId === null) return 'no-key'
    const key = deps.companyKey(companyId, keyId)
    if (!key || key.scope !== 'company' || key.service !== manifest.service) return 'no-key'
    if (key.status !== 'active') return 'key-stopped'
    if (!key.hosts.includes(manifest.baseUrl.host)) return 'key-destination'
    return null
  }

  /**
   * Fields that would write automatically, with the outside property each
   * writes — and create operations that would run automatically (milestone 4:
   * `log_meeting: auto`), named by the operation, their "property" being
   * `create:<object>` (the admin confirms no HubSpot workflow starts when such
   * an object is created).
   */
  function autoFields(manifest: PluginManifest, mapping: PluginMapping): Array<{ field: string; property: string }> {
    const out = new Map<string, string>()
    for (const [name, op] of Object.entries(manifest.operations)) {
      if (op.kind === 'create' && effectiveOperationPolicy(manifest, name, mapping) === 'auto') out.set(name, `${AUTO_CREATE_PREFIX}${op.object}`)
      if (op.kind !== 'update') continue
      for (const [field, rule] of Object.entries(mapping.objects[op.object]?.fields ?? {})) {
        if (effectiveFieldPolicy(manifest, mapping, name, field) === 'auto') out.set(field, rule.from)
      }
    }
    return [...out].map(([field, property]) => ({ field, property }))
  }

  /** Auto fields without a recorded acknowledgement for the property they write now. */
  function unacknowledgedAuto(companyId: string, pluginId: string, manifest: PluginManifest, mapping: PluginMapping) {
    const acks = new Map(companyData.forCompany(companyId).plugins.policyAcks(pluginId).map(a => [a.field, a.property]))
    return autoFields(manifest, mapping).filter(f => acks.get(f.field) !== f.property)
  }

  /** A plugin that runs with nothing to connect (a connector by itself, a business plugin inside ACB only): `active` is null. */
  type Evaluated = { problem: PluginProblem; active: null } | { problem: null; active: ActivePlugin | null }

  /** The switches every plugin has: the operator's stop, the company's switch, the shelf, the fingerprint. */
  async function packageProblem(companyId: string, install: PluginInstallRow, collectingFacts: boolean): Promise<{ problem: PluginProblem; found: null } | { problem: null; found: ShelfPackage }> {
    const found = shelf.find(companyId, install.pluginId, install.version)
    // Collecting the facts of a write already sent (reconciling) goes on while stopped (review §6.5).
    if (!collectingFacts && await shelf.isStopped(install.pluginId, install.version)) return { problem: 'stopped', found: null }
    if (!collectingFacts && !install.enabled) return { problem: 'off', found: null }
    if (!found) return { problem: 'not-on-shelf', found: null }
    if (found.fingerprint !== install.fingerprint) return { problem: 'package-changed', found: null }
    return { problem: null, found }
  }

  /**
   * The connector a business plugin uses, as this company has it: installed,
   * running (its own operator stop, switch, shelf and fingerprint — stopping
   * the connector stops every business plugin's use of it from the next call),
   * at a version the business plugin accepts and offering what it uses
   * (`combineUse`), with a usable key. `override`: judge another install row
   * of the connector (a version change being asked for).
   */
  async function connectorUse(companyId: string, business: ShelfPackage, collectingFacts: boolean, override?: PluginInstallRow):
    Promise<{ problem: PluginProblem } | { problem: null; install: PluginInstallRow; found: ShelfPackage; use: PluginPackage }> {
    const uses = business.pkg.manifest.uses
    if (!uses) return { problem: 'no-connector' }
    const install = override ?? companyData.forCompany(companyId).plugins.install(uses.connector.id)
    if (!install) return { problem: 'connector-missing' }
    const p = await packageProblem(companyId, install, collectingFacts)
    if (p.problem === 'not-on-shelf') return { problem: 'connector-missing' }
    if (p.problem) return { problem: 'connector-stopped' }
    if (p.found.pkg.manifest.role !== 'connector') return { problem: 'connector-missing' }
    const use = combineUse(business.pkg, p.found.pkg.manifest)
    if (!use.ok) return { problem: 'connector-mismatch' }
    const kp = keyProblem(companyId, p.found.pkg.manifest, install.keyId)
    if (kp) return { problem: kp }
    return { problem: null, install, found: p.found, use: use.value }
  }

  /**
   * For editing a business plugin's mapping (save, restore, the page's
   * labels and policies): its use of the installed connector, whatever that
   * connector's switches and key say — only the version and what it offers
   * matter for reading the mapping.
   */
  function useForEditing(companyId: string, business: ShelfPackage): { ok: true; use: PluginPackage } | { ok: false; label: string; minVersion: string } {
    const uses = business.pkg.manifest.uses
    if (!uses) return { ok: false, label: '', minVersion: '' }
    const install = companyData.forCompany(companyId).plugins.install(uses.connector.id)
    const found = install ? shelf.find(companyId, install.pluginId, install.version) : null
    const use = found ? combineUse(business.pkg, found.pkg.manifest) : null
    if (use?.ok) return { ok: true, use: use.value }
    const label = shelf.packagesFor(companyId).filter(p => p.pkg.manifest.id === uses.connector.id).at(-1)?.pkg.manifest.label ?? uses.connector.id
    return { ok: false, label, minVersion: uses.connector.minVersion }
  }

  /** Every kill switch and missing piece, in a fixed order (the operator's stop first). */
  async function evaluate(companyId: string, install: PluginInstallRow, collectingFacts = false, connectorOverride?: PluginInstallRow): Promise<Evaluated> {
    const base = await packageProblem(companyId, install, collectingFacts)
    if (base.problem) return { problem: base.problem, active: null }
    const found = base.found
    if (found.pkg.manifest.role === 'connector') {
      // A connector by itself runs nothing on records: it is ready when its key is.
      const kp = keyProblem(companyId, found.pkg.manifest, install.keyId)
      return kp ? { problem: kp, active: null } : { problem: null, active: null }
    }
    // A business plugin inside ACB only runs as it is.
    if (!found.pkg.manifest.uses) return { problem: null, active: null }
    const c = await connectorUse(companyId, found, collectingFacts, connectorOverride)
    if (c.problem) return { problem: c.problem, active: null }
    const row = install.mappingVersion > 0 ? companyData.forCompany(companyId).plugins.mapping(install.pluginId, install.mappingVersion) : null
    const parsed = row ? parseForCompany(companyId, c.use, row.text) : null
    if (!parsed?.ok) return { problem: 'mapping-invalid', active: null }
    if (unacknowledgedAuto(companyId, install.pluginId, c.use.manifest, parsed.mapping).length > 0) return { problem: 'auto-not-acknowledged', active: null }
    return { problem: null, active: activeOf(install, c.install, c.use, parsed.mapping) }
  }

  const activeOf = (business: PluginInstallRow, connector: PluginInstallRow, use: PluginPackage, mapping: PluginMapping): ActivePlugin => ({
    pluginId: business.pluginId, version: business.version, connectorId: connector.pluginId, connectorVersion: connector.version,
    manifest: use.manifest, types: use.types, mapping, mappingVersion: business.mappingVersion, keyId: connector.keyId as string,
    fingerprint: `${business.fingerprint}+${connector.fingerprint}`, connectionId: connector.connectionId, accountId: connector.accountId,
  })

  /** The newest version of `id` this company may use (for a label), or null. */
  const newest = (companyId: string, id: string): ShelfPackage | null =>
    shelf.packagesFor(companyId).filter(p => p.pkg.manifest.id === id).at(-1) ?? null

  async function listItem(companyId: string, pluginId: string, install: PluginInstallRow | null): Promise<PluginListItem> {
    const versions: PluginPackageView[] = []
    for (const p of shelf.packagesFor(companyId).filter(p => p.pkg.manifest.id === pluginId)) {
      const uses = p.pkg.manifest.uses
      versions.push(packageView(p, await shelf.isStopped(pluginId, p.pkg.manifest.version), uses ? newest(companyId, uses.connector.id) : null))
    }
    let installView: PluginInstallView | null = null
    if (install) {
      const evaluated = await evaluate(companyId, install)
      installView = {
        version: install.version, enabled: install.enabled, keyId: install.keyId, mappingVersion: install.mappingVersion,
        connectionId: install.connectionId, accountId: install.accountId, managedSince: install.managedSince,
        updatedAt: install.updatedAt, updatedBy: install.updatedBy, problem: evaluated.problem,
      }
    }
    return { id: pluginId, versions, install: installView }
  }

  /** The install, or the package this company may see; else the same 404 as an id that exists nowhere. */
  function known(companyId: string, pluginId: string): boolean {
    if (typeof pluginId !== 'string' || pluginId.length > 40) return false
    return companyData.forCompany(companyId).plugins.install(pluginId) !== null
      || shelf.packagesFor(companyId).some(p => p.pkg.manifest.id === pluginId)
  }

  async function detail(companyId: string, pluginId: string): Promise<PluginDetail> {
    const repo = companyData.forCompany(companyId).plugins
    const install = repo.install(pluginId)
    const plugin = await listItem(companyId, pluginId, install)
    const mappingRow = install && install.mappingVersion > 0 ? repo.mapping(pluginId, install.mappingVersion) : null
    const found = install ? shelf.find(companyId, pluginId, install.version) : null
    // What each mapped object and field is called (the business plugin's types): the page shows 「案件・確度」, not deal.confidence.
    const labels: PluginDetail['labels'] = {}
    for (const [object, o] of Object.entries(found?.pkg.manifest.uses?.objects ?? {})) {
      const def = o.recordType ? found!.pkg.types[o.recordType] : undefined
      if (def) labels[object] = { label: def.label, fields: Object.fromEntries(Object.entries(def.fields).map(([n, f]) => [n, f.label])) }
    }
    let policies: PluginFieldPolicyView[] = []
    let mappingErrors: string[] = []
    if (found && mappingRow) {
      const editing = useForEditing(companyId, found)
      const parsed = editing.ok ? parseForCompany(companyId, editing.use, mappingRow.text) : null
      if (!editing.ok) mappingErrors = [connectorRequired(editing.label, editing.minVersion)]
      else if (!parsed!.ok) mappingErrors = parsed!.errors
      else {
        const m = editing.use.manifest
        const mapping = parsed!.mapping
        policies = Object.entries(m.operations).filter(([, op]) => op.kind === 'update').flatMap(([name, op]) =>
          Object.entries(mapping.objects[op.object]?.fields ?? {}).filter(([, f]) => f.write)
            .map(([field]) => ({ operation: name, object: op.object, field, policy: effectiveFieldPolicy(m, mapping, name, field) })))
      }
    }
    return {
      plugin,
      mapping: mappingRow ? { version: mappingRow.version, text: mappingRow.text, createdAt: mappingRow.createdAt, createdBy: mappingRow.createdBy } : null,
      mappingVersions: repo.mappingVersions(pluginId).map(v => ({ version: v.version, createdAt: v.createdAt, createdBy: v.createdBy })),
      policies,
      labels,
      mappingErrors,
      autoAcknowledgements: repo.policyAcks(pluginId).map(a => ({ field: a.field, property: a.property, by: a.acknowledgedBy, at: a.acknowledgedAt })),
      history: repo.history(pluginId, 50).map(h => ({ action: h.action, at: h.at, by: h.by, change: JSON.parse(h.change) as unknown })),
      readScope: install && install.service !== '' ? scopeView(repo.readScope(pluginId, install.connectionId)) : { departmentIds: [], userIds: [] },
    }
  }

  const scopeView = (entries: PluginReadScopeEntry[]): PluginReadScopeView =>
    ({ departmentIds: entries.filter(e => e.type === 'department').map(e => e.id), userIds: entries.filter(e => e.type === 'user').map(e => e.id) })

  /**
   * The member is in the connection's relay read scope (owner, 2026-10-31): named
   * themselves, or able to read the folder of a named department. An empty scope
   * lets nobody in. No per-record filtering inside it (owner decision).
   */
  function inReadScope(companyId: string, userId: string, role: string, install: PluginInstallRow): boolean {
    const entries = companyData.forCompany(companyId).plugins.readScope(install.pluginId, install.connectionId)
    if (entries.some(e => e.type === 'user' && e.id === userId)) return true
    const departments = entries.filter(e => e.type === 'department').map(e => e.id)
    if (departments.length === 0) return false
    const handle = companyData.forCompany(companyId)
    const reader = recordReader({ companyId, userId, role }, handle.scopes.listWithRules())
    return handle.departments.list().some(d => departments.includes(d.id) && reader.record({ id: '', type: '', scopeId: null, path: null, folder: d.folder, personalOwner: null }))
  }

  const notFound = () => refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
  const notAConnector = () => refuse('conflict', NOT_A_CONNECTOR.error, { code: NOT_A_CONNECTOR.code })
  /** The installed version is a business plugin (it has no key, connection or read scope). */
  const isBusinessInstall = (companyId: string, install: PluginInstallRow) =>
    install.service === '' || shelf.find(companyId, install.pluginId, install.version)?.pkg.manifest.role === 'business'

  /**
   * Installing or changing a business plugin: each type name has one owner in
   * a company — a type another installed business plugin owns is refused.
   */
  function typeOwnerConflict(companyId: string, pluginId: string, pkg: PluginPackage): string | null {
    for (const other of companyData.forCompany(companyId).plugins.installs()) {
      if (other.pluginId === pluginId) continue
      const theirs = shelf.find(companyId, other.pluginId, other.version)?.pkg.manifest
      const taken = theirs?.role === 'business' ? pkg.manifest.types.find(t => theirs.types.includes(t)) : undefined
      if (taken && theirs) return `型「${taken}」は、すでに入っている「${theirs.label}」の型です。同じ名前の型を2つのプラグインが持つことはできません`
    }
    return null
  }

  /**
   * Turned-on business plugins whose use of connector `connectorId` runs now
   * and would stop with `next` (a version or key change of the connector).
   */
  async function dependentsStoppedBy(companyId: string, connectorId: string, next: PluginInstallRow): Promise<string[]> {
    const out: string[] = []
    for (const i of companyData.forCompany(companyId).plugins.installs()) {
      if (!i.enabled || i.pluginId === connectorId) continue
      const found = shelf.find(companyId, i.pluginId, i.version)
      if (found?.pkg.manifest.uses?.connector.id !== connectorId) continue
      const now = await evaluate(companyId, i)
      if (now.problem && CONNECTOR_PROBLEMS.includes(now.problem)) continue
      const after = await evaluate(companyId, i, false, next)
      if (after.problem && CONNECTOR_PROBLEMS.includes(after.problem)) out.push(i.pluginId)
    }
    return out
  }

  return {
    /** GET /plugins — the shelf as this company sees it (available_to applied) and its installs. */
    async list(member: Member): Promise<Outcome<{ plugins: PluginListItem[] }>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const installs = new Map(companyData.forCompany(member.companyId).plugins.installs().map(i => [i.pluginId, i]))
      const ids = [...new Set([...shelf.packagesFor(member.companyId).map(p => p.pkg.manifest.id), ...installs.keys()])].sort()
      const plugins: PluginListItem[] = []
      for (const id of ids) plugins.push(await listItem(member.companyId, id, installs.get(id) ?? null))
      return ok({ plugins })
    },

    /** GET /plugins/:pluginId */
    async get(member: Member, pluginId: string): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      return ok(await detail(member.companyId, pluginId))
    },

    /**
     * PUT /plugins/:pluginId { version, keyId } — install, or choose another
     * version or key. Records the package's fingerprint. A connector takes a
     * company key of its service; a business plugin none (`keyId: null`), and
     * its first version with a recommended mapping makes that mapping version
     * 1. A plugin that is on must still run afterwards, and a connector change
     * must not stop a business plugin using it (else 409, nothing changed).
     */
    async install(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      if (!isObject(body) || typeof body.version !== 'string' || !(body.keyId === null || typeof body.keyId === 'string')) {
        return refuse('bad-request', 'Body: { version: string, keyId: string | null }')
      }
      const found = shelf.find(member.companyId, pluginId, body.version)
      if (!found) return refuse('bad-request', 'この版は棚にありません', { code: 'VERSION_NOT_ON_SHELF' })
      const manifest = found.pkg.manifest
      const keyId = body.keyId as string | null
      if (manifest.role === 'business' && keyId !== null) {
        return refuse('bad-request', '業務のプラグインに鍵は要りません（鍵はつなぎ先で選びます）', { code: 'KEY_NOT_USABLE' })
      }
      if (keyId !== null && keyProblem(member.companyId, manifest, keyId) === 'no-key') {
        return refuse('bad-request', `${manifest.service} の会社の鍵を選んでください（「API キー」で登録した鍵）`, { code: 'KEY_NOT_USABLE' })
      }
      const repo = companyData.forCompany(member.companyId).plugins
      const before = repo.install(pluginId)
      const at = clock.now()
      if (before && before.service !== manifest.service) {
        return refuse('conflict', 'この版は別のサービスにつなぐため、選べません', { code: 'SERVICE_CHANGED' })
      }
      if (manifest.role === 'business') {
        const conflict = typeOwnerConflict(member.companyId, pluginId, found.pkg)
        if (conflict) return refuse('conflict', conflict, { code: 'TYPE_OWNED_ELSEWHERE' })
      }
      const row: PluginInstallRow = {
        pluginId, version: body.version, fingerprint: found.fingerprint, service: manifest.service,
        connectionId: before?.connectionId ?? deps.ids.newId(), accountId: before?.accountId ?? null,
        enabled: before?.enabled ?? false, managedSince: before?.managedSince ?? null, keyId,
        mappingVersion: before?.mappingVersion ?? 0, updatedAt: at, updatedBy: member.userId,
      }
      if (row.enabled) {
        // A plugin that is on must keep running: its own switches (and a connector's key).
        const p = await packageProblem(member.companyId, row, false)
        const problem = p.problem ?? (manifest.role === 'connector' ? keyProblem(member.companyId, manifest, keyId) : null)
        if (problem) return refuse('conflict', 'この設定ではプラグインが動かないため、変えていません（先にオフにしてください）', { code: 'PLUGIN_WOULD_STOP', problem })
      }
      if (manifest.role === 'connector' && before) {
        // A business plugin using this connector must not lose it by a version or key change (turn it off first).
        const dependents = await dependentsStoppedBy(member.companyId, pluginId, row)
        if (dependents.length > 0) {
          return refuse('conflict', 'この版にすると、このつなぎ先を使っている業務との行き来が止まるため、変えていません（先にその業務をオフにしてください）',
            { code: 'PLUGIN_WOULD_STOP', problem: 'connector-mismatch', dependents })
        }
      }
      const change = before
        ? { version: { before: before.version, after: row.version }, keyId: { before: before.keyId, after: keyId }, fingerprint: row.fingerprint }
        : { version: row.version, keyId, fingerprint: row.fingerprint }
      repo.saveInstall(row, history(pluginId, before ? 'change' : 'install', member.userId, at, change))
      if (row.mappingVersion === 0 && found.recommendedMapping !== null) {
        // Start from the package's recommended mapping (checked against this company and the connector when it runs).
        repo.addMapping({ pluginId, version: 1, text: found.recommendedMapping, createdAt: at, createdBy: member.userId },
          history(pluginId, 'mapping', member.userId, at, { version: 1, from: 'recommended' }))
      }
      if (row.enabled && manifest.role === 'business') storeBusinessTypes(companyData, member.companyId, found.pkg.types, at)
      return ok(await detail(member.companyId, pluginId))
    },

    /**
     * PUT /plugins/:pluginId/enabled { enabled }. A business plugin: on when its
     * package may be used (its connector is not needed — without it only the
     * connector-backed parts stop); turning it on stores its types in the
     * company at once. A connector: on with a usable key and a relay read
     * scope; turning it on also makes the relay read-only for its service.
     * Off: always (a kill switch; a connector's stops every business plugin's
     * use of it from the next call).
     */
    async setEnabled(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      if (!isObject(body) || typeof body.enabled !== 'boolean') return refuse('bad-request', 'Body: { enabled: boolean }')
      const repo = companyData.forCompany(member.companyId).plugins
      const install = repo.install(pluginId)
      if (!install) return refuse('conflict', '先にプラグインを入れてください（版と鍵を選ぶ）', { code: 'NOT_INSTALLED' })
      if (install.enabled === body.enabled) return ok(await detail(member.companyId, pluginId))
      const at = clock.now()
      if (isBusinessInstall(member.companyId, install)) {
        const row = { ...install, enabled: body.enabled, updatedAt: at, updatedBy: member.userId }
        if (body.enabled) {
          const p = await packageProblem(member.companyId, row, false)
          if (p.problem) return refuse('conflict', 'まだオンにできません', { code: 'PLUGIN_NOT_READY', problem: p.problem })
          repo.saveInstall(row, history(pluginId, 'enable', member.userId, at, { version: row.version }))
          // Its types are the company's from now on (owner decision 2026-11-01), import or not.
          storeBusinessTypes(companyData, member.companyId, p.found.pkg.types, at)
        } else {
          repo.saveInstall(row, history(pluginId, 'disable', member.userId, at, {}))
        }
        return ok(await detail(member.companyId, pluginId))
      }
      const row = { ...install, enabled: body.enabled, managedSince: install.managedSince ?? (body.enabled ? at : null), updatedAt: at, updatedBy: member.userId }
      if (body.enabled) {
        const evaluated = await evaluate(member.companyId, row)
        if (evaluated.problem) return refuse('conflict', 'まだオンにできません', { code: 'PLUGIN_NOT_READY', problem: evaluated.problem })
        // Who may read through the relay must be decided: a forgotten setting never opens it to everyone.
        if (repo.readScope(pluginId, install.connectionId).length === 0) {
          return refuse('conflict', '先に「中継で読める人」（部署かメンバー）を決めてください', { code: 'READ_SCOPE_REQUIRED' })
        }
        repo.saveInstall(row, history(pluginId, 'enable', member.userId, at, { version: row.version }))
        deps.relayReadOnly(member, row.service)
      } else {
        repo.saveInstall(row, history(pluginId, 'disable', member.userId, at, {}))
      }
      return ok(await detail(member.companyId, pluginId))
    },

    /**
     * PUT /plugins/:pluginId/read-scope { departmentIds, userIds } — who may read
     * the outside system through the relay, for the connector's current
     * connection. Only this company's departments and members. Empty = closed;
     * not while the connector is on (turn it off first).
     */
    async setReadScope(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      const ids = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 100) ? [...new Set(v as string[])] : null
      const departmentIds = isObject(body) ? ids(body.departmentIds ?? []) : null
      const userIds = isObject(body) ? ids(body.userIds ?? []) : null
      if (!departmentIds || !userIds) return refuse('bad-request', 'Body: { departmentIds: string[], userIds: string[] }')
      const handle = companyData.forCompany(member.companyId)
      const repo = handle.plugins
      const install = repo.install(pluginId)
      if (!install) return refuse('conflict', '先にプラグインを入れてください（版と鍵を選ぶ）', { code: 'NOT_INSTALLED' })
      if (isBusinessInstall(member.companyId, install)) return notAConnector()
      const known_ = new Set(handle.departments.list().map(d => d.id))
      if (departmentIds.some(id => !known_.has(id))) return refuse('bad-request', 'この会社にない部署が含まれています', { code: 'READ_SCOPE_INVALID' })
      if (userIds.some(id => !deps.isMember(member.companyId, id))) return refuse('bad-request', 'この会社のメンバーではない人が含まれています', { code: 'READ_SCOPE_INVALID' })
      if (install.enabled && departmentIds.length + userIds.length === 0) {
        return refuse('conflict', 'オンの間は「中継で読める人」を空にできません（先にオフにしてください）', { code: 'READ_SCOPE_REQUIRED' })
      }
      const at = clock.now()
      repo.setReadScope(pluginId, install.connectionId, [...departmentIds.map(id => ({ type: 'department' as const, id })), ...userIds.map(id => ({ type: 'user' as const, id }))],
        at, member.userId, history(pluginId, 'read-scope', member.userId, at, { connectionId: install.connectionId, departmentIds, userIds }))
      return ok(await detail(member.companyId, pluginId))
    },

    /** PUT /plugins/:pluginId/mapping { text } — a business plugin's new mapping version (checked in full; field policies are its `policy`). */
    async saveMapping(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      if (!isObject(body) || typeof body.text !== 'string' || body.text.length > MAPPING_MAX) return refuse('bad-request', 'Body: { text: string, acknowledgeAuto?: string[] } (up to 128 KB)')
      const acks = ackList(body.acknowledgeAuto)
      if (!acks) return refuse('bad-request', 'acknowledgeAuto: field names')
      return saveVersion(member, pluginId, body.text, 'mapping', {}, acks)
    },

    /** POST /plugins/:pluginId/mapping/restore { version } — an earlier version becomes the next one (checked again). */
    async restoreMapping(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginDetail>> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!known(member.companyId, pluginId)) return notFound()
      if (!isObject(body) || !Number.isInteger(body.version) || (body.version as number) < 1) return refuse('bad-request', 'Body: { version: integer ≥ 1, acknowledgeAuto?: string[] }')
      const acks = ackList(body.acknowledgeAuto)
      if (!acks) return refuse('bad-request', 'acknowledgeAuto: field names')
      const row = companyData.forCompany(member.companyId).plugins.mapping(pluginId, body.version as number)
      if (!row) return refuse('not-found', 'この版の読み替え表はありません', { code: 'MAPPING_VERSION_NOT_FOUND' })
      return saveVersion(member, pluginId, row.text, 'restore', { from: row.version }, acks)
    },

    /**
     * The relay's rule for a service a connector manages (plugins.md "The relay and a
     * managed connection"): null = not managed. Writes never pass (declared searches
     * only); reads only for members in the connection's read scope — every managed
     * install of the service must let them in. An empty scope lets nobody in.
     */
    relayPolicy(companyId: string, userId: string, service: string): { searchPaths: string[]; mayRead: boolean; connectionIds: string[] } | null {
      const managed = companyData.forCompany(companyId).plugins.installs().filter(i => i.service === service && i.managedSince !== null)
      if (managed.length === 0) return null
      const connectionIds = managed.map(i => i.connectionId)
      const role = deps.roleOf(companyId, userId)
      if (role === null) return { searchPaths: [], mayRead: false, connectionIds }
      const searchPaths: string[] = []
      let mayRead = true
      for (const install of managed) {
        if (!inReadScope(companyId, userId, role, install)) mayRead = false
        const found = shelf.find(companyId, install.pluginId, install.version)
        if (!found) continue
        const m = found.pkg.manifest
        for (const o of Object.values(m.objects)) if (o.endpoints.search) searchPaths.push(`${m.baseUrl.basePath}${o.endpoints.search.path}`)
      }
      return { searchPaths, mayRead, connectionIds }
    },

    /**
     * May this member read the connector's connection (its read scope, plugins.md
     * "The relay and a managed connection")? Outbound mail reads a deal's
     * contacts only for members the relay would let read them too.
     */
    readAllowed(companyId: string, userId: string, connectorId: string): boolean {
      const install = companyData.forCompany(companyId).plugins.install(connectorId)
      const role = deps.roleOf(companyId, userId)
      return install !== null && install.service !== '' && role !== null && inReadScope(companyId, userId, role, install)
    },

    /** The kind of an operation a business plugin uses, as its installed connector declares it (read / update / create), or null. */
    operationKind(companyId: string, pluginId: string, operation: string): string | null {
      const install = typeof pluginId === 'string' ? companyData.forCompany(companyId).plugins.install(pluginId) : null
      const found = install ? shelf.find(companyId, pluginId, install.version) : null
      const editing = found ? useForEditing(companyId, found) : null
      const ops = editing?.ok ? editing.use.manifest.operations : null
      return ops && Object.prototype.hasOwnProperty.call(ops, operation) ? ops[operation].kind : null
    },

    /**
     * For 「HubSpot に聞いて確かめる」 (P8, services/plugin-mapping-check.ts): a
     * business plugin's use of its connector with the connector's key and a
     * mapping — `text`, else the one in force — for the connector's reads of
     * the outside property list. Unlike `active()` it does not need either
     * plugin on or the auto fields acknowledged (checking the mapping comes
     * before both); the operator's stop of either, the packages' fingerprints,
     * the key and the mapping's own checks still apply. Re-decided on every
     * call (it is also the precheck).
     */
    async forChecking(companyId: string, pluginId: string, text: string | null): Promise<{ ok: true; plugin: ActivePlugin } | { ok: false; problem: PluginProblem; errors?: string[] }> {
      const repo = companyData.forCompany(companyId).plugins
      const install = repo.install(pluginId)
      if (!install) return { ok: false, problem: 'off' }
      if (await shelf.isStopped(install.pluginId, install.version)) return { ok: false, problem: 'stopped' }
      const found = shelf.find(companyId, install.pluginId, install.version)
      if (!found) return { ok: false, problem: 'not-on-shelf' }
      if (found.fingerprint !== install.fingerprint) return { ok: false, problem: 'package-changed' }
      if (found.pkg.manifest.role === 'connector') return { ok: false, problem: 'not-a-business' }
      // Checking reads only the outside property list: the connector must be there (not on).
      const c = await connectorUse(companyId, found, true)
      if (c.problem) return { ok: false, problem: c.problem }
      if (await shelf.isStopped(c.install.pluginId, c.install.version)) return { ok: false, problem: 'connector-stopped' }
      const source = text ?? (install.mappingVersion > 0 ? repo.mapping(install.pluginId, install.mappingVersion)?.text ?? null : null)
      if (source === null) return { ok: false, problem: 'mapping-invalid', errors: ['読み替え表がまだありません'] }
      const parsed = parseForCompany(companyId, c.use, source)
      if (!parsed.ok) return { ok: false, problem: 'mapping-invalid', errors: parsed.errors }
      return { ok: true, plugin: activeOf(install, c.install, c.use, parsed.mapping) }
    },

    /** The company key the connection managing `service` uses (the first such install), or null. */
    connectionKeyId(companyId: string, service: string): string | null {
      return companyData.forCompany(companyId).plugins.installs().find(i => i.service === service && i.managedSince !== null && i.keyId !== null)?.keyId ?? null
    },

    /** Whether a connector of the company manages `service` (the relay's read-only switch stays on). */
    manages(companyId: string, service: string): boolean {
      return companyData.forCompany(companyId).plugins.installs().some(i => i.service === service && i.managedSince !== null)
    },

    /**
     * GET /api/records-ai/plugins (P7) — the operations of the running business
     * plugins' connector use the member's AI may call (the tool is named by the
     * business plugin, labelled by the outside system): only operations whose
     * `who` lists `ai`, and with a `read` token (Codex) no write at all. An
     * update lists the fields it may write now (`off` left out); a create
     * (milestone 4) its policy now (an `off` create is left out) and its
     * content slots, or — creating a record — the fields it may fill. Any
     * member: what they may do on a record is decided per call (P6).
     */
    async aiTools(member: Member, scope: 'read' | 'act'): Promise<Outcome<PluginAiTools>> {
      const out: PluginAiTools['plugins'] = []
      for (const install of companyData.forCompany(member.companyId).plugins.installs()) {
        const evaluated = await evaluate(member.companyId, install)
        if (!evaluated.active) continue
        const { manifest, mapping, types } = evaluated.active
        const operations: PluginAiOperation[] = []
        for (const [name, op] of Object.entries(manifest.operations)) {
          if (!op.who.includes('ai')) continue
          if (op.kind !== 'read' && scope !== 'act') continue
          if (op.kind === 'create') {
            const policy = effectiveOperationPolicy(manifest, name, mapping)
            if (policy !== 'auto' && policy !== 'prior') continue
            const recordType = manifest.objects[op.attachTo ?? op.object]?.recordType
            const def = recordType ? types[recordType] : undefined
            if (!recordType || !def) continue
            const fields: PluginAiField[] = []
            if (op.createsRecord) {
              for (const [field, rule] of Object.entries(mapping.objects[op.object]?.fields ?? {})) {
                const f = def.fields[field]
                if (!rule.write || !f) continue
                fields.push({ name: field, label: f.label, kind: f.kind, ...(f.options ? { options: [...f.options] } : {}), ...(f.optionLabels ? { optionLabels: { ...f.optionLabels } } : {}), policy: 'prior' })
              }
            }
            operations.push({
              name, label: op.label, kind: 'create', recordType, decision: op.decision, fields,
              policy: op.createsRecord ? 'prior' : policy, content: Object.keys(op.content), createsRecord: op.createsRecord,
            })
            continue
          }
          const recordType = manifest.objects[op.object]?.recordType
          const def = recordType ? types[recordType] : undefined
          if (!recordType || !def) continue
          const fields: PluginAiField[] = []
          if (op.kind === 'update') {
            for (const [field, rule] of Object.entries(mapping.objects[op.object]?.fields ?? {})) {
              const f = def.fields[field]
              if (!rule.write || !f) continue
              const policy = effectiveFieldPolicy(manifest, mapping, name, field)
              if (policy !== 'auto' && policy !== 'prior') continue
              fields.push({ name: field, label: f.label, kind: f.kind, ...(f.options ? { options: [...f.options] } : {}), ...(f.optionLabels ? { optionLabels: { ...f.optionLabels } } : {}), policy })
            }
            if (fields.length === 0) continue
          }
          operations.push({ name, label: op.label, kind: op.kind, recordType, decision: op.decision, fields })
        }
        if (operations.length > 0) out.push({ id: install.pluginId, label: manifest.label, operations })
      }
      return ok({ plugins: out })
    },

    /**
     * For the connector and the typed operations (P5 / P6): the business
     * plugin's use of its connector if it may run now, else why not.
     * Re-decided on every call. `collectingFacts`: for reading back the result
     * of a write already sent — the operator's stop and the company's switch
     * (of either plugin) stop new writes, not the collection of facts (review
     * §6.5); key, account and mapping still apply.
     */
    async active(companyId: string, pluginId: string, options: { collectingFacts?: boolean } = {}): Promise<{ ok: true; plugin: ActivePlugin } | { ok: false; problem: PluginProblem }> {
      const install = companyData.forCompany(companyId).plugins.install(pluginId)
      if (!install) return { ok: false, problem: 'off' }
      const evaluated = await evaluate(companyId, install, options.collectingFacts === true)
      if (evaluated.problem) return { ok: false, problem: evaluated.problem }
      if (evaluated.active) return { ok: true, plugin: evaluated.active }
      return { ok: false, problem: isBusinessInstall(companyId, install) ? 'no-connector' : 'not-a-business' }
    },
  }

  async function saveVersion(member: Member, pluginId: string, text: string, action: string, extra: Record<string, unknown>, acknowledge: string[]): Promise<Outcome<PluginDetail>> {
    const repo = companyData.forCompany(member.companyId).plugins
    const install = repo.install(pluginId)
    if (!install) return refuse('conflict', '先にプラグインを入れてください（版と鍵を選ぶ）', { code: 'NOT_INSTALLED' })
    const found = shelf.find(member.companyId, pluginId, install.version)
    if (!found) return refuse('conflict', '入れた版が棚にありません。版を選び直してください', { code: 'VERSION_NOT_ON_SHELF' })
    if (found.pkg.manifest.role === 'connector') return refuse('conflict', NOT_A_BUSINESS.error, { code: NOT_A_BUSINESS.code })
    if (!found.pkg.manifest.uses) return refuse('conflict', NO_CONNECTOR.error, { code: NO_CONNECTOR.code })
    const editing = useForEditing(member.companyId, found)
    if (!editing.ok) {
      return refuse('conflict', connectorRequired(editing.label, editing.minVersion), { code: 'CONNECTOR_REQUIRED', plugin: found.pkg.manifest.uses.connector.id, minVersion: editing.minVersion })
    }
    const parsed = parseForCompany(member.companyId, editing.use, text)
    if (!parsed.ok) return refuse('bad-request', '読み替え表を保存できません', { code: 'MAPPING_INVALID', errors: parsed.errors })
    // A field that would write automatically needs the acknowledgement, recorded with who and when.
    const missing = unacknowledgedAuto(member.companyId, pluginId, editing.use.manifest, parsed.mapping)
    const unconfirmed = missing.filter(f => !acknowledge.includes(f.field))
    if (unconfirmed.length > 0) {
      return refuse('bad-request', `自動で書き戻す欄は、「${AUTO_ACKNOWLEDGEMENT}」の確認が要ります`, {
        code: 'AUTO_NEEDS_ACKNOWLEDGEMENT', fields: unconfirmed.map(f => f.field), acknowledgement: AUTO_ACKNOWLEDGEMENT,
      })
    }
    const version = (repo.mappingVersions(pluginId)[0]?.version ?? 0) + 1
    const at = clock.now()
    if (missing.length > 0) {
      repo.addPolicyAcks(missing.map(f => ({ pluginId, field: f.field, property: f.property, acknowledgedBy: member.userId, acknowledgedAt: at })),
        history(pluginId, 'acknowledge', member.userId, at, { fields: missing, acknowledgement: AUTO_ACKNOWLEDGEMENT }))
    }
    repo.addMapping({ pluginId, version, text, createdAt: at, createdBy: member.userId },
      history(pluginId, action, member.userId, at, { version, ...extra }))
    return ok(await detail(member.companyId, pluginId))
  }
}

export type PluginService = ReturnType<typeof createPluginService>
