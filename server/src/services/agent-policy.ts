/**
 * The policy a member's app follows (`GET /me/agent-policy`): the AI sandbox
 * (agent-sandbox.ts), the emergency stop (agent-stops.ts) and the business
 * plugins' packages the app keeps (plan C2, plugin-distribution.ts) in one
 * answer, with one version (also its ETag). `announce` sends a company's
 * members their new version over the push channel (push-channel.ts).
 *
 * The plugin part is the same for every member of a company and is read
 * asynchronously (the operator's stop file), so it is read once per answer /
 * announcement. Its source is bound by the plugins lane's wiring
 * (composition/plugins.ts); unbound, the answer has no `plugins` (an app then
 * leaves what it keeps as it is).
 */
import type { AgentPolicy } from '../../shared/types/agent-sandbox'
import type { DistributedPlugin } from '../../shared/types/plugins'
import type { TokenDigest } from '../ports/key-broker'
import type { AgentSandboxService } from './agent-sandbox'
import type { AgentStopService } from './agent-stops'
import type { Member } from './access'
import type { PushChannel } from './push-channel'

export interface AgentPolicyDeps {
  agentSandbox: Pick<AgentSandboxService, 'policyFor'>
  agentStops: Pick<AgentStopService, 'policyFor'>
  digest: TokenDigest
  push: Pick<PushChannel, 'announce'>
  log?: Pick<Console, 'warn'>
}

/** The packages a company's apps keep (services/plugin-distribution.ts). */
export interface PolicyPluginSource {
  pluginsFor(companyId: string): Promise<DistributedPlugin[]>
}

export function createAgentPolicyService(deps: AgentPolicyDeps) {
  let pluginSource: PolicyPluginSource | null = null
  const log = deps.log ?? console

  function compose(member: Pick<Member, 'companyId' | 'userId'>, plugins: DistributedPlugin[] | undefined): AgentPolicy {
    const as = { ...member, role: 'member' }
    const sandbox = deps.agentSandbox.policyFor(as)
    const stop = deps.agentStops.policyFor(as)
    const parts = plugins ? { sandbox, stop, plugins } : { sandbox, stop }
    const version = deps.digest.digest(JSON.stringify(parts)).slice(0, 32)
    return { version, ...parts }
  }
  const pluginsOf = (companyId: string): Promise<DistributedPlugin[] | undefined> =>
    pluginSource ? pluginSource.pluginsFor(companyId) : Promise.resolve(undefined)

  return {
    async policyFor(member: Pick<Member, 'companyId' | 'userId'>): Promise<AgentPolicy> {
      return compose(member, await pluginsOf(member.companyId))
    },
    /** After any change to a company's sandbox, stops or plugins. */
    announce(companyId: string): void {
      pluginsOf(companyId)
        .then(plugins => deps.push.announce(companyId, userId => compose({ companyId, userId }, plugins).version))
        .catch((error: unknown) => log.warn(`[agent-policy] ${companyId}: announcing failed (${error instanceof Error ? error.message : 'unknown'})`))
    },
    /** Bound once by the plugins lane's wiring (composition/plugins.ts). */
    usePlugins(source: PolicyPluginSource): void {
      pluginSource = source
    },
  }
}

export type AgentPolicyService = ReturnType<typeof createAgentPolicyService>
