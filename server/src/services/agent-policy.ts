/**
 * The policy a member's app follows (`GET /me/agent-policy`): the AI sandbox
 * (agent-sandbox.ts) and the emergency stop (agent-stops.ts) in one answer,
 * with one version (also its ETag). `announce` sends a company's members
 * their new version over the push channel (push-channel.ts).
 */
import type { AgentPolicy } from '../../shared/types/agent-sandbox'
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
}

export function createAgentPolicyService(deps: AgentPolicyDeps) {
  function policyFor(member: Pick<Member, 'companyId' | 'userId'>): AgentPolicy {
    const as = { ...member, role: 'member' }
    const sandbox = deps.agentSandbox.policyFor(as)
    const stop = deps.agentStops.policyFor(as)
    const version = deps.digest.digest(JSON.stringify({ sandbox, stop })).slice(0, 32)
    return { version, sandbox, stop }
  }
  return {
    policyFor,
    /** After any change to a company's sandbox or stops. */
    announce(companyId: string): void {
      deps.push.announce(companyId, userId => policyFor({ companyId, userId }).version)
    },
  }
}

export type AgentPolicyService = ReturnType<typeof createAgentPolicyService>
