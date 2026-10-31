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
 */
import { FULL_ACCESS_ROLES, findPrivateScope } from '../../shared/core/permissions'
import {
  effectiveFieldPolicy, parsePluginMapping, type PluginManifest, type PluginMapping, type PluginPackage,
} from '../../shared/core/plugins'
import type { TypeDefinition } from '../../shared/core/record-types'
import type { PluginAiField, PluginAiOperation, PluginAiTools, PluginDetail, PluginFieldPolicyView, PluginInstallView, PluginListItem, PluginPackageView, PluginProblem } from '../../shared/types/plugins'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { PluginHistoryRow, PluginInstallRow } from '../ports/plugins'
import { requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import type { PluginShelf, ShelfPackage } from './plugin-shelf'
import { recordReader } from './record-access'

export const PLUGINS_FORBIDDEN = 'つなぎ先のプラグインを設定できるのは、オーナーと管理者だけです'
/** What an owner / admin confirms before a field writes automatically (owner, 2026-10-31). */
export const AUTO_ACKNOWLEDGEMENT = 'この欄の変更をきっかけに動く HubSpot のワークフローがないか確かめました'

export const PLUGIN_NOT_FOUND = { error: 'このプラグインはありません', code: 'PLUGIN_NOT_FOUND' } as const

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

function packageView(p: ShelfPackage, stopped: boolean): PluginPackageView {
  const m = p.pkg.manifest
  return {
    id: m.id, label: m.label, version: m.version, kind: m.kind, description: m.description, service: m.service, host: m.baseUrl.host,
    scopes: m.scopes, operationScopes: m.operationScopes, types: m.types, fingerprint: p.fingerprint, stopped,
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

  /** Fields that would write automatically, with the outside property each writes. */
  function autoFields(manifest: PluginManifest, mapping: PluginMapping): Array<{ field: string; property: string }> {
    const out = new Map<string, string>()
    for (const [name, op] of Object.entries(manifest.operations)) {
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

  type Evaluated = { problem: PluginProblem; active: null } | { problem: null; active: ActivePlugin }

  /** Every kill switch and missing piece, in a fixed order (the operator's stop first). */
  async function evaluate(companyId: string, install: PluginInstallRow, collectingFacts = false): Promise<Evaluated> {
    const found = shelf.find(companyId, install.pluginId, install.version)
    // Collecting the facts of a write already sent (reconciling) goes on while stopped (review §6.5).
    if (!collectingFacts && await shelf.isStopped(install.pluginId, install.version)) return { problem: 'stopped', active: null }
    if (!collectingFacts && !install.enabled) return { problem: 'off', active: null }
    if (!found) return { problem: 'not-on-shelf', active: null }
    if (found.fingerprint !== install.fingerprint) return { problem: 'package-changed', active: null }
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
      versions.push(packageView(p, await shelf.isStopped(pluginId, p.pkg.manifest.version)))
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
      mappingErrors,
      autoAcknowledgements: repo.policyAcks(pluginId).map(a => ({ field: a.field, property: a.property, by: a.acknowledgedBy, at: a.acknowledgedAt })),
      history: repo.history(pluginId, 50).map(h => ({ action: h.action, at: h.at, by: h.by, change: JSON.parse(h.change) as unknown })),
    }
  }

  const notFound = () => refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })

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
      const row = { ...install, enabled: body.enabled, managedSince: install.managedSince ?? (body.enabled ? at : null), updatedAt: at, updatedBy: member.userId }
      if (body.enabled) {
        const evaluated = await evaluate(member.companyId, row)
        if (evaluated.problem) return refuse('conflict', 'まだオンにできません', { code: 'PLUGIN_NOT_READY', problem: evaluated.problem })
        repo.saveInstall(row, history(pluginId, 'enable', member.userId, at, { version: row.version, mappingVersion: row.mappingVersion }))
        deps.relayReadOnly(member, evaluated.active.manifest.service)
      } else {
        repo.saveInstall(row, history(pluginId, 'disable', member.userId, at, {}))
      }
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
     * The relay's rule for a service whose connection a plugin manages (one
     * that was turned on at least once — turning it off does not undo it):
     * null when no plugin of the company manages `service`. Asked by the relay
     * on every call. Writes are never allowed there; searches only on the
     * declared paths of the installed version; reads only for a member who may
     * read every place the plugin's records are visible in (an invalid mapping:
     * owners / admins only). Review §5.1 / §5.2.
     */
    relayPolicy(companyId: string, userId: string, service: string): { searchPaths: string[]; mayRead: boolean } | null {
      const managed = companyData.forCompany(companyId).plugins.installs().filter(i => i.service === service && i.managedSince !== null)
      if (managed.length === 0) return null
      const role = deps.roleOf(companyId, userId)
      if (role === null) return { searchPaths: [], mayRead: false }
      const reader = recordReader({ companyId, userId, role }, companyData.forCompany(companyId).scopes.listWithRules())
      const searchPaths: string[] = []
      let mayRead = true
      for (const install of managed) {
        const found = shelf.find(companyId, install.pluginId, install.version)
        const row = found && install.mappingVersion > 0 ? companyData.forCompany(companyId).plugins.mapping(install.pluginId, install.mappingVersion) : null
        const parsed = found && row ? parseForCompany(companyId, found.pkg, row.text) : null
        if (!found || !parsed?.ok) { mayRead &&= FULL_ACCESS_ROLES.has(role); continue }
        const m = found.pkg.manifest
        for (const o of Object.values(m.objects)) if (o.endpoints.search) searchPaths.push(`${m.baseUrl.basePath}${o.endpoints.search.path}`)
        for (const o of Object.values(parsed.mapping.objects)) {
          if (!reader.record({ id: '', type: '', scopeId: null, path: null, folder: o.visibleToFolder })) mayRead = false
        }
      }
      return { searchPaths, mayRead }
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
    manages(companyId: string, service: string): boolean {
      return companyData.forCompany(companyId).plugins.installs().some(i => i.service === service && i.managedSince !== null)
    },

    /**
     * GET /api/records-ai/plugins (P7) — the running plugins' operations the
     * member's AI may call: only operations whose `who` lists `ai`, no
     * `create` (not in milestone 3), and with a `read` token (Codex) no write
     * at all. An update lists the fields it may write now (`off` left out).
     * Any member: what they may do on a record is decided per call (P6).
     */
    async aiTools(member: Member, scope: 'read' | 'act'): Promise<Outcome<PluginAiTools>> {
      const out: PluginAiTools['plugins'] = []
      for (const install of companyData.forCompany(member.companyId).plugins.installs()) {
        const evaluated = await evaluate(member.companyId, install)
        if (!evaluated.active) continue
        const { manifest, mapping, types } = evaluated.active
        const operations: PluginAiOperation[] = []
        for (const [name, op] of Object.entries(manifest.operations)) {
          if (!op.who.includes('ai') || op.kind === 'create') continue
          if (op.kind === 'update' && scope !== 'act') continue
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
              fields.push({ name: field, label: f.label, kind: f.kind, ...(f.options ? { options: [...f.options] } : {}), policy })
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
      return evaluated.problem ? { ok: false, problem: evaluated.problem } : { ok: true, plugin: evaluated.active }
    },
  }

  async function saveVersion(member: Member, pluginId: string, text: string, action: string, extra: Record<string, unknown>, acknowledge: string[]): Promise<Outcome<PluginDetail>> {
    const repo = companyData.forCompany(member.companyId).plugins
    const install = repo.install(pluginId)
    if (!install) return refuse('conflict', '先にプラグインを入れてください（版と鍵を選ぶ）', { code: 'NOT_INSTALLED' })
    const found = shelf.find(member.companyId, pluginId, install.version)
    if (!found) return refuse('conflict', '入れた版が棚にありません。版を選び直してください', { code: 'VERSION_NOT_ON_SHELF' })
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
