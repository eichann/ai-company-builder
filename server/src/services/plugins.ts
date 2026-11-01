/**
 * A company's connector plugins (milestone 3 P4, `.claude/rules/plugins.md`):
 * which package of the shelf it uses (version, fingerprint), the company key
 * the connector sends, on / off, the mapping (読み替え表, versioned, field
 * policies included) and the history. Owners and admins only; a department
 * manager or member gets 403, a non-member 404 (the route).
 *
 * `active()` is what the connector (P5) and the typed operations (P6) ask
 * before every call: it re-decides every kill switch each time (the
 * operator's stop, the company's switch, the package's fingerprint, the key
 * and its status, the mapping), so each takes effect from the next call.
 *
 * Every company row is reached through the company handle; the shelf is
 * shared and read only, filtered by `available_to` for the asking company.
 *
 * Business plugins (owner decision 2026-11-01) are installed and switched
 * here too: they own types and connect to nothing (no key, mapping, read
 * scope or relay switch). A connector needs the business plugin it maps to
 * (`maps_to`, that exact version) installed to be installed, and running to
 * run (`business-missing` / `business-stopped`); one type name has one owner.
 */
import { findPrivateScope } from '../../shared/core/permissions'
import {
  effectiveFieldPolicy, effectiveOperationPolicy, parsePluginMapping, type PluginManifest, type PluginMapping, type PluginPackage,
} from '../../shared/core/plugins'
import type { TypeDefinition } from '../../shared/core/record-types'
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
export const NOT_A_CONNECTOR = { error: '業務のプラグインには、つなぎ先の設定（鍵・読み替え表・読める人・取り込み）はありません', code: 'NOT_A_CONNECTOR' } as const

/** What a connector needs first (owner decision 2026-11-01): its business plugin, that version, installed. */
export const businessRequired = (label: string, version: string) =>
  `先に「${label}」（${version}）を入れてオンにしてください（このつなぎ先は「${label}」の記録を読み書きします）`

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
   * plugin is on, writes to it go only through the plugin's typed operations).
   * Recorded in the key broker's history as this member's change.
   */
  relayReadOnly: (member: Member, service: string) => void
}

/** A company's plugin ready to run (everything `active()` checked). */
export interface ActivePlugin {
  pluginId: string
  version: string
  manifest: PluginManifest
  /** The types it maps to: those of the business plugin it names in `maps_to` (a connector owns none). */
  types: Record<string, TypeDefinition>
  mapping: PluginMapping
  mappingVersion: number
  keyId: string
  /** The package's fingerprint (kept on every ledger receipt). */
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

function packageView(p: ShelfPackage, stopped: boolean, businessLabel: string | null): PluginPackageView {
  const m = p.pkg.manifest
  return {
    id: m.id, label: m.label, version: m.version, kind: m.kind, role: m.role, description: m.description, service: m.service, host: m.baseUrl.host,
    scopes: m.scopes, operationScopes: m.operationScopes, types: m.types, fingerprint: p.fingerprint, stopped,
    mapsTo: m.mapsTo ? { ...m.mapsTo, label: businessLabel ?? m.mapsTo.id } : null,
    operations: Object.entries(m.operations).map(([name, op]) => ({ name, label: op.label, kind: op.kind, reaches: op.reaches, undo: op.undo })),
  }
}

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

  /** The key problem for this package, or null when the connector may use it. */
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

  /** A business plugin that runs has nothing to connect: `active` is null (owner decision 2026-11-01). */
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
   * A connector runs only while the business plugin it maps to — that exact
   * version — is installed and runs (its own switches; stopping it stops the
   * connector's operations on its types from the next call).
   */
  async function businessProblem(companyId: string, manifest: PluginManifest, collectingFacts: boolean): Promise<PluginProblem | null> {
    if (!manifest.mapsTo) return 'business-missing'
    const business = companyData.forCompany(companyId).plugins.install(manifest.mapsTo.id)
    if (!business || business.version !== manifest.mapsTo.version) return 'business-missing'
    const p = await packageProblem(companyId, business, collectingFacts)
    return p.problem === null && p.found.pkg.manifest.role === 'business' ? null : 'business-stopped'
  }

  /** Every kill switch and missing piece, in a fixed order (the operator's stop first). */
  async function evaluate(companyId: string, install: PluginInstallRow, collectingFacts = false): Promise<Evaluated> {
    const base = await packageProblem(companyId, install, collectingFacts)
    if (base.problem) return { problem: base.problem, active: null }
    const found = base.found
    if (found.pkg.manifest.role === 'business') return { problem: null, active: null }
    const bp = await businessProblem(companyId, found.pkg.manifest, collectingFacts)
    if (bp) return { problem: bp, active: null }
    const kp = keyProblem(companyId, found.pkg.manifest, install.keyId)
    if (kp) return { problem: kp, active: null }
    const row = install.mappingVersion > 0 ? companyData.forCompany(companyId).plugins.mapping(install.pluginId, install.mappingVersion) : null
    const parsed = row ? parseForCompany(companyId, found.pkg, row.text) : null
    if (!parsed?.ok) return { problem: 'mapping-invalid', active: null }
    if (unacknowledgedAuto(companyId, install.pluginId, found.pkg.manifest, parsed.mapping).length > 0) return { problem: 'auto-not-acknowledged', active: null }
    return {
      problem: null,
      active: {
        pluginId: install.pluginId, version: install.version, manifest: found.pkg.manifest, types: found.pkg.types,
        mapping: parsed.mapping, mappingVersion: install.mappingVersion, keyId: install.keyId as string,
        fingerprint: install.fingerprint, connectionId: install.connectionId, accountId: install.accountId,
      },
    }
  }

  async function listItem(companyId: string, pluginId: string, install: PluginInstallRow | null): Promise<PluginListItem> {
    const versions: PluginPackageView[] = []
    for (const p of shelf.packagesFor(companyId).filter(p => p.pkg.manifest.id === pluginId)) {
      const to = p.pkg.manifest.mapsTo
      const businessLabel = to ? shelf.find(companyId, to.id, to.version)?.pkg.manifest.label ?? null : null
      versions.push(packageView(p, await shelf.isStopped(pluginId, p.pkg.manifest.version), businessLabel))
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
    // What each mapped object and field is called (the package's types): the page shows 「案件・確度」, not deal.confidence.
    const labels: PluginDetail['labels'] = {}
    if (found) {
      for (const [object, o] of Object.entries(found.pkg.manifest.objects)) {
        const def = o.recordType ? found.pkg.types[o.recordType] : undefined
        if (def) labels[object] = { label: def.label, fields: Object.fromEntries(Object.entries(def.fields).map(([n, f]) => [n, f.label])) }
      }
    }
    let policies: PluginFieldPolicyView[] = []
    let mappingErrors: string[] = []
    if (found && mappingRow) {
      const parsed = parseForCompany(companyId, found.pkg, mappingRow.text)
      if (!parsed.ok) mappingErrors = parsed.errors
      else {
        const m = found.pkg.manifest
        policies = Object.entries(m.operations).filter(([, op]) => op.kind === 'update').flatMap(([name, op]) =>
          Object.entries(parsed.mapping.objects[op.object]?.fields ?? {}).filter(([, f]) => f.write)
            .map(([field]) => ({ operation: name, object: op.object, field, policy: effectiveFieldPolicy(m, parsed.mapping, name, field) })))
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
      readScope: install ? scopeView(repo.readScope(pluginId, install.connectionId)) : { departmentIds: [], userIds: [] },
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
    return handle.departments.list().some(d => departments.includes(d.id) && reader.record({ id: '', type: '', scopeId: null, path: null, folder: d.folder }))
  }

  const notFound = () => refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
  const notAConnector = () => refuse('conflict', NOT_A_CONNECTOR.error, { code: NOT_A_CONNECTOR.code })
  /** The installed version is a business plugin (it has no key, mapping or read scope). */
  const isBusinessInstall = (companyId: string, install: PluginInstallRow) =>
    shelf.find(companyId, install.pluginId, install.version)?.pkg.manifest.role === 'business'

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

  /** Enabled connectors of the company that map to business plugin `businessId` (their install and package). */
  function dependentsOn(companyId: string, businessId: string): PluginInstallRow[] {
    return companyData.forCompany(companyId).plugins.installs().filter(i =>
      i.enabled && shelf.find(companyId, i.pluginId, i.version)?.pkg.manifest.mapsTo?.id === businessId)
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
     * PUT /plugins/:pluginId { version, keyId } — install (first time: the
     * package's recommended mapping becomes version 1), or choose another
     * version or key. Records the package's fingerprint. A plugin that is on
     * must still run afterwards (else 409, nothing changed).
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
      const keyId = body.keyId as string | null
      if (keyId !== null && keyProblem(member.companyId, found.pkg.manifest, keyId) === 'no-key') {
        return refuse('bad-request', `${found.pkg.manifest.service} の会社の鍵を選んでください（「API キー」で登録した鍵）`, { code: 'KEY_NOT_USABLE' })
      }
      const repo = companyData.forCompany(member.companyId).plugins
      const before = repo.install(pluginId)
      const at = clock.now()
      if (before && before.service !== found.pkg.manifest.service) {
        return refuse('conflict', 'この版は別のサービスにつなぐため、選べません', { code: 'SERVICE_CHANGED' })
      }
      const manifest = found.pkg.manifest
      if (manifest.mapsTo) {
        // A connector needs its business plugin, that exact version, installed first (owner decision 2026-11-01).
        const business = repo.install(manifest.mapsTo.id)
        if (!business || business.version !== manifest.mapsTo.version) {
          const label = shelf.find(member.companyId, manifest.mapsTo.id, manifest.mapsTo.version)?.pkg.manifest.label ?? manifest.mapsTo.id
          return refuse('conflict', businessRequired(label, manifest.mapsTo.version), { code: 'BUSINESS_PLUGIN_REQUIRED', plugin: manifest.mapsTo.id, version: manifest.mapsTo.version })
        }
      } else {
        const conflict = typeOwnerConflict(member.companyId, pluginId, found.pkg)
        if (conflict) return refuse('conflict', conflict, { code: 'TYPE_OWNED_ELSEWHERE' })
        // Another version would stop a connector that is on (it maps to one exact version).
        const stopped = before && before.version !== body.version ? dependentsOn(member.companyId, pluginId) : []
        if (stopped.length > 0) {
          return refuse('conflict', 'この版にすると、オンになっているつなぎ先が止まるため、変えていません（先にそのつなぎ先をオフにしてください）',
            { code: 'PLUGIN_WOULD_STOP', problem: 'business-missing', dependents: stopped.map(i => i.pluginId) })
        }
      }
      const row: PluginInstallRow = {
        pluginId, version: body.version, fingerprint: found.fingerprint, service: found.pkg.manifest.service,
        connectionId: before?.connectionId ?? deps.ids.newId(), accountId: before?.accountId ?? null,
        enabled: before?.enabled ?? false, managedSince: before?.managedSince ?? null, keyId,
        mappingVersion: before?.mappingVersion ?? 0, updatedAt: at, updatedBy: member.userId,
      }
      if (row.enabled) {
        const evaluated = await evaluate(member.companyId, row)
        if (evaluated.problem) return refuse('conflict', 'この設定ではプラグインが動かないため、変えていません（先にオフにするか、読み替え表を直してください）', { code: 'PLUGIN_WOULD_STOP', problem: evaluated.problem })
      }
      const change = before
        ? { version: { before: before.version, after: row.version }, keyId: { before: before.keyId, after: keyId }, fingerprint: row.fingerprint }
        : { version: row.version, keyId, fingerprint: row.fingerprint }
      repo.saveInstall(row, history(pluginId, before ? 'change' : 'install', member.userId, at, change))
      if (!before && found.recommendedMapping !== null) {
        // Start from the package's recommended mapping (checked against this company when it is turned on).
        repo.addMapping({ pluginId, version: 1, text: found.recommendedMapping, createdAt: at, createdBy: member.userId },
          history(pluginId, 'mapping', member.userId, at, { version: 1, from: 'recommended' }))
      }
      return ok(await detail(member.companyId, pluginId))
    },

    /**
     * PUT /plugins/:pluginId/enabled { enabled } — on only when everything
     * needed is there (`evaluate`); turning it on also makes the relay
     * read-only for the plugin's service. Off: always (a kill switch).
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
        // A business plugin owns types and connects to nothing: no key, read scope or relay switch.
        // Turning it off stops the connectors mapping to it (their `active()` from the next call).
        const row = { ...install, enabled: body.enabled, updatedAt: at, updatedBy: member.userId }
        if (body.enabled) {
          const evaluated = await evaluate(member.companyId, row)
          if (evaluated.problem) return refuse('conflict', 'まだオンにできません', { code: 'PLUGIN_NOT_READY', problem: evaluated.problem })
        }
        repo.saveInstall(row, history(pluginId, body.enabled ? 'enable' : 'disable', member.userId, at, body.enabled ? { version: row.version } : {}))
        return ok(await detail(member.companyId, pluginId))
      }
      const row = { ...install, enabled: body.enabled, managedSince: install.managedSince ?? (body.enabled ? at : null), updatedAt: at, updatedBy: member.userId }
      if (body.enabled) {
        const evaluated = await evaluate(member.companyId, row)
        if (evaluated.problem) {
          const business = evaluated.problem === 'business-missing' || evaluated.problem === 'business-stopped'
          const to = business ? shelf.find(member.companyId, pluginId, install.version)?.pkg.manifest.mapsTo : null
          const label = to ? shelf.find(member.companyId, to.id, to.version)?.pkg.manifest.label ?? to.id : null
          return refuse('conflict', to && label ? businessRequired(label, to.version) : 'まだオンにできません', { code: 'PLUGIN_NOT_READY', problem: evaluated.problem })
        }
        if (!evaluated.active) return notAConnector()
        // Who may read through the relay must be decided: a forgotten setting never opens it to everyone.
        if (repo.readScope(pluginId, install.connectionId).length === 0) {
          return refuse('conflict', '先に「中継で読める人」（部署かメンバー）を決めてください', { code: 'READ_SCOPE_REQUIRED' })
        }
        repo.saveInstall(row, history(pluginId, 'enable', member.userId, at, { version: row.version, mappingVersion: row.mappingVersion }))
        deps.relayReadOnly(member, evaluated.active.manifest.service)
      } else {
        repo.saveInstall(row, history(pluginId, 'disable', member.userId, at, {}))
      }
      return ok(await detail(member.companyId, pluginId))
    },

    /**
     * PUT /plugins/:pluginId/read-scope { departmentIds, userIds } — who may read
     * the outside system through the relay, for the current connection. Only
     * this company's departments and members. Empty = closed; not while the
     * plugin is on (turn it off first).
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

    /** PUT /plugins/:pluginId/mapping { text } — a new mapping version (checked in full; field policies are its `policy`). */
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
     * The relay's rule for a service a plugin manages (plugins.md "The relay and a
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
     * May this member read the plugin's connection (its read scope, plugins.md
     * "The relay and a managed connection")? Outbound mail reads a deal's
     * contacts only for members the relay would let read them too.
     */
    readAllowed(companyId: string, userId: string, pluginId: string): boolean {
      const install = companyData.forCompany(companyId).plugins.install(pluginId)
      const role = deps.roleOf(companyId, userId)
      return install !== null && role !== null && inReadScope(companyId, userId, role, install)
    },

    /** The kind of an operation of the company's installed version (read / update / create), or null. */
    operationKind(companyId: string, pluginId: string, operation: string): string | null {
      const install = typeof pluginId === 'string' ? companyData.forCompany(companyId).plugins.install(pluginId) : null
      const found = install ? shelf.find(companyId, pluginId, install.version) : null
      const op = found && Object.prototype.hasOwnProperty.call(found.pkg.manifest.operations, operation) ? found.pkg.manifest.operations[operation] : null
      return op?.kind ?? null
    },

    /**
     * For 「HubSpot に聞いて確かめる」 (P8, services/plugin-mapping-check.ts): the
     * installed package with its key and a mapping — `text`, else the one in
     * force — for the connector's reads of the outside property list. Unlike
     * `active()` it does not need the plugin on or its auto fields
     * acknowledged (checking the mapping comes before both); the operator's
     * stop, the package's fingerprint, the key and the mapping's own checks
     * still apply. Re-decided on every call (it is also the precheck).
     */
    async forChecking(companyId: string, pluginId: string, text: string | null): Promise<{ ok: true; plugin: ActivePlugin } | { ok: false; problem: PluginProblem; errors?: string[] }> {
      const repo = companyData.forCompany(companyId).plugins
      const install = repo.install(pluginId)
      if (!install) return { ok: false, problem: 'off' }
      if (await shelf.isStopped(install.pluginId, install.version)) return { ok: false, problem: 'stopped' }
      const found = shelf.find(companyId, install.pluginId, install.version)
      if (!found) return { ok: false, problem: 'not-on-shelf' }
      if (found.fingerprint !== install.fingerprint) return { ok: false, problem: 'package-changed' }
      if (found.pkg.manifest.role === 'business') return { ok: false, problem: 'not-a-connector' }
      // Checking reads only the outside property list: the business plugin must be there (its types), not on.
      const business = found.pkg.manifest.mapsTo ? repo.install(found.pkg.manifest.mapsTo.id) : null
      if (!business || business.version !== found.pkg.manifest.mapsTo?.version) return { ok: false, problem: 'business-missing' }
      const kp = keyProblem(companyId, found.pkg.manifest, install.keyId)
      if (kp) return { ok: false, problem: kp }
      const source = text ?? (install.mappingVersion > 0 ? repo.mapping(install.pluginId, install.mappingVersion)?.text ?? null : null)
      if (source === null) return { ok: false, problem: 'mapping-invalid', errors: ['読み替え表がまだありません'] }
      const parsed = parseForCompany(companyId, found.pkg, source)
      if (!parsed.ok) return { ok: false, problem: 'mapping-invalid', errors: parsed.errors }
      return {
        ok: true,
        plugin: {
          pluginId: install.pluginId, version: install.version, manifest: found.pkg.manifest, types: found.pkg.types,
          mapping: parsed.mapping, mappingVersion: install.mappingVersion, keyId: install.keyId as string,
          fingerprint: install.fingerprint, connectionId: install.connectionId, accountId: install.accountId,
        },
      }
    },

    /** Whether a plugin of the company manages `service` (the relay's read-only switch stays on). */
    /** The company key the connection managing `service` uses (the first such install), or null. */
    connectionKeyId(companyId: string, service: string): string | null {
      return companyData.forCompany(companyId).plugins.installs().find(i => i.service === service && i.managedSince !== null && i.keyId !== null)?.keyId ?? null
    },

    manages(companyId: string, service: string): boolean {
      return companyData.forCompany(companyId).plugins.installs().some(i => i.service === service && i.managedSince !== null)
    },

    /**
     * GET /api/records-ai/plugins (P7) — the running plugins' operations the
     * member's AI may call: only operations whose `who` lists `ai`, and with a
     * `read` token (Codex) no write at all. An update lists the fields it may
     * write now (`off` left out); a create (milestone 4) its policy now (an
     * `off` create is left out) and its content slots, or — creating a record
     * — the fields it may fill. Any member: what they may do on a record is
     * decided per call (P6).
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
     * For the connector and the typed operations (P5 / P6): the company's
     * plugin if it may run now, else why not. Re-decided on every call.
     * `collectingFacts`: for reading back the result of a write already sent
     * — the operator's stop and the company's switch stop new writes, not
     * the collection of facts (review §6.5); key, account and mapping still apply.
     */
    async active(companyId: string, pluginId: string, options: { collectingFacts?: boolean } = {}): Promise<{ ok: true; plugin: ActivePlugin } | { ok: false; problem: PluginProblem }> {
      const install = companyData.forCompany(companyId).plugins.install(pluginId)
      if (!install) return { ok: false, problem: 'off' }
      const evaluated = await evaluate(companyId, install, options.collectingFacts === true)
      if (evaluated.problem) return { ok: false, problem: evaluated.problem }
      return evaluated.active ? { ok: true, plugin: evaluated.active } : { ok: false, problem: 'not-a-connector' }
    },
  }

  async function saveVersion(member: Member, pluginId: string, text: string, action: string, extra: Record<string, unknown>, acknowledge: string[]): Promise<Outcome<PluginDetail>> {
    const repo = companyData.forCompany(member.companyId).plugins
    const install = repo.install(pluginId)
    if (!install) return refuse('conflict', '先にプラグインを入れてください（版と鍵を選ぶ）', { code: 'NOT_INSTALLED' })
    const found = shelf.find(member.companyId, pluginId, install.version)
    if (!found) return refuse('conflict', '入れた版が棚にありません。版を選び直してください', { code: 'VERSION_NOT_ON_SHELF' })
    if (found.pkg.manifest.role === 'business') return refuse('conflict', NOT_A_CONNECTOR.error, { code: NOT_A_CONNECTOR.code })
    const parsed = parseForCompany(member.companyId, found.pkg, text)
    if (!parsed.ok) return refuse('bad-request', '読み替え表を保存できません', { code: 'MAPPING_INVALID', errors: parsed.errors })
    // A field that would write automatically needs the acknowledgement, recorded with who and when.
    const missing = unacknowledgedAuto(member.companyId, pluginId, found.pkg.manifest, parsed.mapping)
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
