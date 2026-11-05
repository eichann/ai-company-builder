/**
 * Whether a company's plugin may run now (plugins.md "A company's install,
 * mapping and history", `active()`): every kill switch and missing piece in a
 * fixed order — the operator's stop, the company's switch, the shelf, the
 * fingerprint; for a business plugin its connector (installed, running, a
 * version it accepts, a usable key), its mapping (the package's rules and the
 * server's: members, no private folder) and the acknowledged automatic
 * fields. Re-decided on every call; reads only, writes nothing.
 */
import { findPrivateScope } from '../../shared/core/permissions'
import {
  combineUse, effectiveFieldPolicy, effectiveOperationPolicy, parsePluginMapping, type PluginManifest, type PluginMapping, type PluginPackage,
} from '../../shared/core/plugins'
import type { PluginProblem } from '../../shared/types/plugins'
import type { PluginInstallRow } from '../ports/plugins'
import { AUTO_CREATE_PREFIX, type ActivePlugin, type PluginServiceDeps } from './plugin-service-common'
import type { ShelfPackage } from './plugin-shelf'

/** A plugin that runs with nothing to connect (a connector by itself, a business plugin inside ACB only): `active` is null. */
type Evaluated = { problem: PluginProblem; active: null } | { problem: null; active: ActivePlugin | null }

/**
 * Fields that would write automatically, with the outside property each
 * writes — and create operations that would run automatically (milestone 4:
 * `log_meeting: auto`), named by the operation, their "property" being
 * `create:<object>` (the admin confirms no HubSpot workflow starts when such
 * an object is created).
 */
function autoFields(pkg: PluginPackage, mapping: PluginMapping): Array<{ field: string; property: string }> {
  const { manifest } = pkg
  const out = new Map<string, string>()
  for (const [name, op] of Object.entries(manifest.operations)) {
    if (op.kind === 'create' && effectiveOperationPolicy(manifest, name, mapping) === 'auto') out.set(name, `${AUTO_CREATE_PREFIX}${op.object}`)
    if (op.kind !== 'update') continue
    for (const [field, rule] of Object.entries(mapping.objects[op.object]?.fields ?? {})) {
      if (effectiveFieldPolicy(pkg, mapping, name, field) === 'auto') out.set(field, rule.from)
    }
  }
  return [...out].map(([field, property]) => ({ field, property }))
}

export const activeOf = (business: PluginInstallRow, connector: PluginInstallRow, use: PluginPackage, mapping: PluginMapping): ActivePlugin => ({
  pluginId: business.pluginId, version: business.version, connectorId: connector.pluginId, connectorVersion: connector.version,
  manifest: use.manifest, types: use.types, mapping, mappingVersion: business.mappingVersion, keyId: connector.keyId as string,
  fingerprint: `${business.fingerprint}+${connector.fingerprint}`, connectionId: connector.connectionId, accountId: connector.accountId,
})

export function createPluginEvaluation(deps: Pick<PluginServiceDeps, 'companyData' | 'shelf' | 'companyKey' | 'isMember'>) {
  const { companyData, shelf } = deps

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

  /** Auto fields without a recorded acknowledgement for the property they write now. */
  function unacknowledgedAuto(companyId: string, pluginId: string, pkg: PluginPackage, mapping: PluginMapping) {
    const acks = new Map(companyData.forCompany(companyId).plugins.policyAcks(pluginId).map(a => [a.field, a.property]))
    return autoFields(pkg, mapping).filter(f => acks.get(f.field) !== f.property)
  }

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
    // A use of only a contract-3 connector's calls maps nothing: there is no record to read a field into,
    // so a mapping saved for it (there is nothing it could name) is not read either.
    const m = c.use.manifest
    if (Object.keys(m.objects).length === 0 && Object.keys(m.operations).length === 0) {
      return { problem: null, active: activeOf(install, c.install, c.use, { objects: {}, people: {}, policy: {}, approvalBy: {}, closingStages: [] }) }
    }
    const row = install.mappingVersion > 0 ? companyData.forCompany(companyId).plugins.mapping(install.pluginId, install.mappingVersion) : null
    const parsed = row ? parseForCompany(companyId, c.use, row.text) : null
    if (!parsed?.ok) return { problem: 'mapping-invalid', active: null }
    if (unacknowledgedAuto(companyId, install.pluginId, c.use, parsed.mapping).length > 0) return { problem: 'auto-not-acknowledged', active: null }
    return { problem: null, active: activeOf(install, c.install, c.use, parsed.mapping) }
  }

  return { parseForCompany, keyProblem, unacknowledgedAuto, packageProblem, connectorUse, useForEditing, evaluate }
}

export type PluginEvaluation = ReturnType<typeof createPluginEvaluation>
