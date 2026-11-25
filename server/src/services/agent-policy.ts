/**
 * The policy a member's app follows (`GET /me/agent-policy`): the AI sandbox
 * (agent-sandbox.ts), the emergency stop (agent-stops.ts), whether the other AI
 * may be asked (second-opinion-setting.ts), 「ブラウザ操作」 (agent-browser.ts) and the business
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
import type { AgentBrowserService } from './agent-browser'
import type { AgentSandboxService } from './agent-sandbox'
import type { AgentStopService } from './agent-stops'
import type { Member } from './access'
import type { PushChannel } from './push-channel'
import type { SecondOpinionSettingService } from './second-opinion-setting'

export interface AgentPolicyDeps {
  agentSandbox: Pick<AgentSandboxService, 'policyFor'>
  agentBrowser: Pick<AgentBrowserService, 'policyFor'> & Partial<Pick<AgentBrowserService, 'sitePartsFor'>>
  agentStops: Pick<AgentStopService, 'policyFor'>
  secondOpinion: Pick<SecondOpinionSettingService, 'allowedFor'>
  digest: TokenDigest
  push: Pick<PushChannel, 'announce'>
  log?: Pick<Console, 'warn'>
}

/** The packages a company's apps keep (services/plugin-distribution.ts). */
export interface PolicyPluginSource {
  pluginsFor(companyId: string): Promise<DistributedPlugin[]>
}

/** The marker of a company's plugin trust documents (services/plugin-trust.ts; plugin-trust.md "P2"). */
export interface PolicyTrustSource {
  digestFor(companyId: string): Promise<string | null>
}

export function createAgentPolicyService(deps: AgentPolicyDeps) {
  let pluginSource: PolicyPluginSource | null = null
  let trustSource: PolicyTrustSource | null = null
  const log = deps.log ?? console

  interface CompanyParts { plugins: DistributedPlugin[] | undefined; pluginTrust: string | null }
  function compose(member: Pick<Member, 'companyId' | 'userId'>, { plugins, pluginTrust }: CompanyParts): AgentPolicy {
    const as = { ...member, role: 'member' }
    const sandbox = deps.agentSandbox.policyFor(as)
    const stop = deps.agentStops.policyFor(as)
    const secondOpinion = { allowed: deps.secondOpinion.allowedFor(member.companyId) }
    const browser = deps.agentBrowser.policyFor(member)
    // A registered domain's 「詳しい設定」 (redesign step ②): a field of its own, only when there is one, so
    // the `browser` part released apps validate keeps its shape (and its answer and version stay as before).
    const browserParts = deps.agentBrowser.sitePartsFor?.(member) ?? []
    const parts = {
      sandbox, stop, secondOpinion, browser,
      ...(browserParts.length > 0 ? { browserParts } : {}),
      ...(plugins ? { plugins } : {}),
      ...(pluginTrust ? { pluginTrust } : {}),
    }
    const version = deps.digest.digest(JSON.stringify(parts)).slice(0, 32)
    return { version, ...parts }
  }
  const pluginsOf = (companyId: string): Promise<DistributedPlugin[] | undefined> =>
    pluginSource ? pluginSource.pluginsFor(companyId) : Promise.resolve(undefined)
  /** The plugin trust marker; a source that fails leaves the marker out (the app keeps what it has). */
  const trustOf = (companyId: string): Promise<string | null> =>
    trustSource ? trustSource.digestFor(companyId).catch(() => null) : Promise.resolve(null)
  const companyParts = async (companyId: string): Promise<CompanyParts> => {
    const [plugins, pluginTrust] = await Promise.all([pluginsOf(companyId), trustOf(companyId)])
    return { plugins, pluginTrust }
  }

  return {
    async policyFor(member: Pick<Member, 'companyId' | 'userId'>): Promise<AgentPolicy> {
      return compose(member, await companyParts(member.companyId))
    },
    /** After any change to a company's sandbox, browser operation, stops, second-opinion setting or plugins. */
    announce(companyId: string): void {
      companyParts(companyId)
        .then(parts => deps.push.announce(companyId, userId => compose({ companyId, userId }, parts).version))
        .catch((error: unknown) => log.warn(`[agent-policy] ${companyId}: announcing failed (${error instanceof Error ? error.message : 'unknown'})`))
    },
    /** Bound once by the plugins lane's wiring (composition/plugins.ts). */
    usePlugins(source: PolicyPluginSource): void {
      pluginSource = source
    },
    /** Bound once by the plugins lane's wiring (composition/plugins.ts): plugin trust P2. */
    usePluginTrust(source: PolicyTrustSource): void {
      trustSource = source
    },
  }
}

export type AgentPolicyService = ReturnType<typeof createAgentPolicyService>
