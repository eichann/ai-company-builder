/**
 * What the admin page 「つなぎ先」 reads (`GET /plugins`, `GET /plugins/:id`,
 * contract `shared/types/plugins.ts`): the shelf as this company sees it, an
 * install with its problem now, and a plugin's detail — mapping in force,
 * versions, effective field policies, mapping errors, labels, history and
 * the relay read scope. Reads only.
 */
import { effectiveFieldPolicy } from '../../shared/core/plugins'
import type { PluginDetail, PluginFieldPolicyView, PluginInstallView, PluginListItem, PluginPackageView, PluginReadScopeView } from '../../shared/types/plugins'
import type { PluginInstallRow, PluginReadScopeEntry } from '../ports/plugins'
import type { PluginEvaluation } from './plugin-evaluation'
import { connectorRequired, type PluginServiceDeps } from './plugin-service-common'
import type { ShelfPackage } from './plugin-shelf'

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
    connector: uses
      ? {
        id: uses.connector.id, minVersion: uses.connector.minVersion, label: connector?.pkg.manifest.label ?? uses.connector.id,
        // Imports and writes back records (a mapping), or only reads through calls (contract 3: no mapping, no import).
        records: Object.keys(uses.objects).length > 0 || Object.keys(uses.operations).length > 0 || p.recommendedMapping !== null,
      }
      : null,
    operations,
  }
}

const scopeView = (entries: PluginReadScopeEntry[]): PluginReadScopeView =>
  ({ departmentIds: entries.filter(e => e.type === 'department').map(e => e.id), userIds: entries.filter(e => e.type === 'user').map(e => e.id) })

export function createPluginViews(
  deps: Pick<PluginServiceDeps, 'companyData' | 'shelf'> & { evaluation: Pick<PluginEvaluation, 'evaluate' | 'useForEditing' | 'parseForCompany'> },
) {
  const { companyData, shelf, evaluation } = deps

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
      const evaluated = await evaluation.evaluate(companyId, install)
      installView = {
        version: install.version, enabled: install.enabled, keyId: install.keyId, mappingVersion: install.mappingVersion,
        connectionId: install.connectionId, accountId: install.accountId, managedSince: install.managedSince,
        updatedAt: install.updatedAt, updatedBy: install.updatedBy, problem: evaluated.problem,
      }
    }
    return { id: pluginId, versions, install: installView }
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
      const editing = evaluation.useForEditing(companyId, found)
      const parsed = editing.ok ? evaluation.parseForCompany(companyId, editing.use, mappingRow.text) : null
      if (!editing.ok) mappingErrors = [connectorRequired(editing.label, editing.minVersion)]
      else if (!parsed!.ok) mappingErrors = parsed!.errors
      else {
        const m = editing.use.manifest
        const mapping = parsed!.mapping
        policies = Object.entries(m.operations).filter(([, op]) => op.kind === 'update').flatMap(([name, op]) =>
          Object.entries(mapping.objects[op.object]?.fields ?? {}).filter(([, f]) => f.write)
            .map(([field]) => ({ operation: name, object: op.object, field, policy: effectiveFieldPolicy(editing.use, mapping, name, field) })))
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

  return { listItem, detail }
}
