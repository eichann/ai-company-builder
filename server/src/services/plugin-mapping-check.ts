/**
 * 「HubSpot に聞いて確かめる」 (milestone 3 P8, `.claude/rules/plugins.md`
 * "The mapping"): a mapping — the text an owner/admin is editing, or the one
 * in force — checked against the outside system's real property list, read
 * through the connector (`properties_list`, a declared read).
 *
 * - Owners and admins only (a member 403, a plugin not installed 404).
 * - Works before the plugin is on and before its auto fields are
 *   acknowledged — checking comes first — but never while the operator
 *   stopped the package, nor with a changed package or an unusable key
 *   (`plugins.forChecking`, asked again before every request as the
 *   connector's precheck, together with the caller's role).
 * - Nothing is written: no record, no mapping version, no account binding.
 * - The answer holds sentences and fixed words only (never the key, never the
 *   outside answer). When the outside system cannot be asked it says so; the
 *   mapping can still be saved (design §1-5).
 */
import { checkMappingAgainstProperties, type ExternalPropertyInfo } from '../../shared/core/plugins'
import type { PluginMappingCheck } from '../../shared/types/plugins'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import type { PluginConnector } from './plugin-connector'
import { PLUGIN_NOT_FOUND, PLUGINS_FORBIDDEN, type PluginService } from './plugins'

export interface PluginMappingCheckDeps {
  companyData: CompanyDataSource
  clock: Clock
  plugins: PluginService
  connector: PluginConnector
  roleOf: (companyId: string, userId: string) => string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const MAPPING_MAX = 128 * 1024

/**
 * HubSpot's property list (`{ results: [{ name, type, calculated,
 * modificationMetadata: { readOnlyValue }, options: [{ value }], externalOptions }] }`,
 * part of the connector's wire format) in the core's words; null for another
 * shape. Options only for enumerations whose values HubSpot keeps itself
 * (owners are `externalOptions`; the mapping's `people` translates them).
 */
export function propertiesFromAnswer(body: unknown): ExternalPropertyInfo[] | null {
  if (!isObj(body) || !Array.isArray(body.results)) return null
  return body.results.filter(isObj).filter(p => typeof p.name === 'string').map(p => ({
    name: p.name as string,
    readOnly: p.calculated === true || (isObj(p.modificationMetadata) && p.modificationMetadata.readOnlyValue === true),
    options: (p.type === 'enumeration' || p.type === 'bool') && p.externalOptions !== true && Array.isArray(p.options)
      ? p.options.filter(isObj).map(o => String(o.value))
      : null,
  }))
}

export function createPluginMappingCheckService(deps: PluginMappingCheckDeps) {
  const { companyData, clock, plugins, connector } = deps
  return {
    /** POST /plugins/:pluginId/mapping/check { text? } */
    async check(member: Member, pluginId: string, body: unknown): Promise<Outcome<PluginMappingCheck>> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', PLUGINS_FORBIDDEN)
      const companyId = member.companyId
      if (typeof pluginId !== 'string' || pluginId.length > 40 || !companyData.forCompany(companyId).plugins.install(pluginId)) {
        return refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
      }
      const b = body === null || body === undefined ? {} : body
      if (!isObj(b) || (b.text !== undefined && (typeof b.text !== 'string' || b.text.length > MAPPING_MAX))) {
        return refuse('bad-request', 'Body: { text?: string } (up to 128 KB)')
      }
      const text = typeof b.text === 'string' ? b.text : null
      const ready = await plugins.forChecking(companyId, pluginId, text)
      if (!ready.ok) {
        if (ready.errors) return refuse('bad-request', '読み替え表を確かめられません', { code: 'MAPPING_INVALID', errors: ready.errors })
        return refuse('conflict', 'いまは確かめられません', { code: 'PLUGIN_NOT_READY', problem: ready.problem })
      }
      const plugin = ready.plugin
      const precheck = async (): Promise<string | null> => {
        const role = deps.roleOf(companyId, member.userId)
        if (role === null || !hasFullAccess(role)) return 'not-allowed'
        const again = await plugins.forChecking(companyId, pluginId, text)
        if (!again.ok) return again.problem
        return again.plugin.connectionId === plugin.connectionId ? null : 'connection-changed'
      }
      const report: PluginMappingCheck = { reachable: true, reason: null, objects: {}, checkedAt: clock.now() }
      for (const object of Object.keys(plugin.mapping.objects)) {
        if (!plugin.manifest.objects[object]?.endpoints.properties_list) continue
        const r = await connector.call(companyId, plugin, { endpoint: 'properties_list', object }, precheck)
        const properties = r.ok ? propertiesFromAnswer(r.body) : null
        if (!properties) {
          report.reachable = false
          report.reason = r.ok ? 'unreadable-answer' : r.reason
          report.objects = {}
          break
        }
        report.objects[object] = checkMappingAgainstProperties(plugin.manifest, plugin.mapping, object, properties)
      }
      return ok(report)
    },
  }
}

export type PluginMappingCheckService = ReturnType<typeof createPluginMappingCheckService>
