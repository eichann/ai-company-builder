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
import { companySkillTree } from '../lib/skill-trees'
import type { AgentPolicyService } from '../services/agent-policy'
import type { PluginStepRuns } from '../services/ai-runs'
import type { ApprovalRoleHolders } from '../services/approvals'
import { createPluginRunGate } from '../services/plugin-ai-tools'
import { createPluginDistribution } from '../services/plugin-distribution'
import { createPluginRoleService } from '../services/plugin-roles'
import { parsePluginRunStep, type OperationRoleHolds, type RunStepOf } from '../services/plugin-operation-checks'
import { createPluginStepService } from '../services/plugin-steps'
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
  pluginOperations: { useRoles(r: OperationRoleHolds): void; usePinnedSteps(f: RunStepOf): void }
  aiRuns: { usePluginSteps(r: PluginStepRuns): void }
  /** Absentees a member stands in for today (services/absences.ts, the one resolution). */
  actsFor: (companyId: string, userId: string) => string[]
  isMember: (companyId: string, userId: string) => boolean
  managedFolders: (companyId: string, userId: string) => string[]
}

export function wirePluginsLane(deps: PluginsLaneDeps) {
  // C5 「手順の自動実行」: a step's work is pinned at its first run; runs of `<pluginId>__<step>` are claimed at its state.
  const pluginSteps = createPluginStepService({
    companyData: deps.companyData, clock: deps.clock, shelf: deps.pluginShelf, skillTree: companySkillTree, actsFor: deps.actsFor,
  })
  deps.aiRuns.usePluginSteps({
    isPluginStep: step => parsePluginRunStep(step) !== null,
    turnOf: (member, recordId, step) => pluginSteps.turnOf(member, recordId, step),
    pinForRun: (member, recordId, step) => pluginSteps.pinForRun(member, recordId, step),
  })
  const runStepOf: RunStepOf = (companyId, run) => pluginSteps.stepOfRun(companyId, run)
  deps.pluginOperations.usePinnedSteps(runStepOf)
  // C2 「配る道」: the packages the members' apps keep, listed in their agent policy (pinned versions of open work too).
  const pluginDistribution = createPluginDistribution({
    companyData: deps.companyData, shelf: deps.pluginShelf, pinnedVersions: (companyId, pluginId) => pluginSteps.pinnedVersions(companyId, pluginId),
  })
  deps.agentPolicy.usePlugins(pluginDistribution)
  // C3 「役割」: the one resolution of business roles' holders, for the engine's `who` and the approvers.
  const pluginRoles = createPluginRoleService({
    companyData: deps.companyData, clock: deps.clock, shelf: deps.pluginShelf,
    isMember: deps.isMember, managedFolders: deps.managedFolders,
  })
  deps.recordEngine.useRoles(pluginRoles.resolver)
  deps.approvals.useRoles(pluginRoles.resolver)
  // A plugin operation's `who` (C4 follow-up): `role:<name>` is held on the operation's record; a
  // delegate stands in for an absent holder, as in the engine (plugin-roles.md "Absence").
  deps.pluginOperations.useRoles((companyId, pluginId, recordId, role, userId) =>
    [userId, ...deps.actsFor(companyId, userId)].some(u => pluginRoles.holdsForPlugin(companyId, pluginId, recordId, role, u)))
  // C4 「業務×操作の関所」: a step's run uses only the connector roles its step declares
  // (its operations are gated in plugin-operation-checks.ts, through the plugins service).
  const pluginRunGate = createPluginRunGate({ companyData: deps.companyData, shelf: deps.pluginShelf, runStepOf })
  return { pluginDistribution, pluginRoles, pluginRunGate, pluginSteps }
}
