/**
 * The relay and a managed connection (plugins.md "The relay and a managed
 * connection"): once a connector has been on, its service is managed — the
 * relay passes no writes (declared searches only) and reads only for members
 * in the connection's read scope. Called by the relay
 * (`services/broker-relay.ts`), the key broker and outbound mail. Reads only.
 *
 * A contract-3 connector's service is closed to the relay altogether, reads too
 * (plugins.md "Contract 3"): its data comes only through the declared calls,
 * each with its `who` and its line in the access log. Closed by the package on
 * the company's shelf, not by an install, and by the host as well as the service
 * id, so neither an older generic service nor an alias under another id gets past.
 */
import { PLUGIN_CONTRACT_V3 } from '../../shared/core/plugins'
import type { PluginInstallRow } from '../ports/plugins'
import { recordReader } from './record-access'
import type { PluginServiceDeps } from './plugin-service-common'

export function createPluginRelayScope(deps: Pick<PluginServiceDeps, 'companyData' | 'shelf' | 'roleOf'>) {
  const { companyData, shelf } = deps

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
    return handle.departments.list().some(d => departments.includes(d.id) && reader.record({ id: '', type: '', scopeId: null, path: null, folder: d.folder, personalOwner: null, members: null }))
  }

  /**
   * The service id, or the host, belongs to a contract-3 connector on this company's shelf: no relay, no generic
   * relay service (K9). Both hosts come through `parseRelayBaseUrl` (lower case, no trailing dot), so they compare as is.
   */
  const relayClosed = (companyId: string, service: string, host: string | null = null): boolean =>
    shelf.packagesFor(companyId).some(({ pkg: { manifest: m } }) => m.role === 'connector' && m.contract >= PLUGIN_CONTRACT_V3
      && (m.service === service || (host !== null && m.baseUrl.host === host)))

  const closedConnector = (companyId: string, install: PluginInstallRow): boolean => {
    const m = shelf.find(companyId, install.pluginId, install.version)?.pkg.manifest
    return m?.role === 'connector' && m.contract >= PLUGIN_CONTRACT_V3
  }

  return {
    relayClosed,

    /** A contract-3 connector: nothing goes through the relay, so it has no read scope. */
    closedConnector,

    /**
     * The relay's rule for a service a connector manages (plugins.md "The relay and a
     * managed connection"): null = not managed. Writes never pass (declared searches
     * only); reads only for members in the connection's read scope — every managed
     * install of the service must let them in. An empty scope lets nobody in. `host`:
     * where this call would go; `closed`: nothing passes (`relayClosed`), for anyone.
     */
    relayPolicy(companyId: string, userId: string, service: string, host: string | null = null): { searchPaths: string[]; mayRead: boolean; connectionIds: string[]; closed?: true } | null {
      const installs = companyData.forCompany(companyId).plugins.installs().filter(i => i.service === service)
      if (relayClosed(companyId, service, host)) return { searchPaths: [], mayRead: false, connectionIds: installs.map(i => i.connectionId), closed: true }
      const managed = installs.filter(i => i.managedSince !== null)
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

    /** The company key the connection managing `service` uses (the first such install), or null. */
    connectionKeyId(companyId: string, service: string): string | null {
      return companyData.forCompany(companyId).plugins.installs().find(i => i.service === service && i.managedSince !== null && i.keyId !== null)?.keyId ?? null
    },

    /** Whether a connector of the company manages `service` (the relay's read-only switch stays on). */
    manages(companyId: string, service: string): boolean {
      return companyData.forCompany(companyId).plugins.installs().some(i => i.service === service && i.managedSince !== null)
    },
  }
}
