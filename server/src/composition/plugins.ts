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
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { AgentPolicyService } from '../services/agent-policy'
import type { ApprovalRoleHolders } from '../services/approvals'
import { createPluginRunGate } from '../services/plugin-ai-tools'
import { createPluginDistribution } from '../services/plugin-distribution'
import { createPluginRoleService } from '../services/plugin-roles'
import type { PluginShelf } from '../services/plugin-shelf'
import type { RoleHolders } from '../services/record-engine/types'

export interface PluginsLaneDeps {
  conn: Database.Database
  companyData: CompanyDataSource
  clock: Clock
  pluginShelf: PluginShelf
  agentPolicy: Pick<AgentPolicyService, 'usePlugins'>
  recordEngine: { useRoles(r: RoleHolders): void }
  approvals: { useRoles(r: ApprovalRoleHolders): void }
  isMember: (companyId: string, userId: string) => boolean
  managedFolders: (companyId: string, userId: string) => string[]
}

export function wirePluginsLane(deps: PluginsLaneDeps) {
  // C2 「配る道」: the packages the members' apps keep, listed in their agent policy.
  const pluginDistribution = createPluginDistribution({ companyData: deps.companyData, shelf: deps.pluginShelf })
  deps.agentPolicy.usePlugins(pluginDistribution)
  // C3 「役割」: the one resolution of business roles' holders, for the engine's `who` and the approvers.
  const pluginRoles = createPluginRoleService({
    companyData: deps.companyData, clock: deps.clock, shelf: deps.pluginShelf,
    isMember: deps.isMember, managedFolders: deps.managedFolders,
  })
  deps.recordEngine.useRoles(pluginRoles.resolver)
  deps.approvals.useRoles(pluginRoles.resolver)
  // C4 「業務×操作の関所」: a step's run uses only the connector roles its step declares
  // (its operations are gated in plugin-operation-checks.ts, through the plugins service).
  const pluginRunGate = createPluginRunGate({ companyData: deps.companyData, shelf: deps.pluginShelf })
  return { pluginDistribution, pluginRoles, pluginRunGate }
}
