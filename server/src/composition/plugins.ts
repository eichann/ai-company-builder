/**
 * Lane C (the plugin foundation) wiring: the services this lane adds, built
 * here so the lane does not edit the shared body of src/composition.ts
 * (.claude/rules/server.md "Lane markers"). createServices calls this once and
 * spreads what it returns into the services. Like composition.ts, this module
 * may import adapters.
 *
 * Add what the lane needs to PluginsLaneDeps and pass it at this lane's one
 * call line in composition.ts.
 */
import type Database from 'better-sqlite3'
import type { CompanyDataSource } from '../ports/company-data'
import type { AgentPolicyService } from '../services/agent-policy'
import { createPluginDistribution } from '../services/plugin-distribution'
import type { PluginShelf } from '../services/plugin-shelf'

export interface PluginsLaneDeps {
  conn: Database.Database
  companyData: CompanyDataSource
  pluginShelf: PluginShelf
  agentPolicy: Pick<AgentPolicyService, 'usePlugins'>
}

export function wirePluginsLane(deps: PluginsLaneDeps) {
  // C2 「配る道」: the packages the members' apps keep, listed in their agent policy.
  const pluginDistribution = createPluginDistribution({ companyData: deps.companyData, shelf: deps.pluginShelf })
  deps.agentPolicy.usePlugins(pluginDistribution)
  return { pluginDistribution }
}
