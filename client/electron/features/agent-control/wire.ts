// Watching and stopping the AI (monitoring M1 and M2): the member's AI policy
// per company, the emergency stop and its push channel, and the AI action log.
import path from 'path'
import type { Session } from '../../services/session'
import { createAgentPolicyStore, type AgentPolicyStore } from '../../services/agent-policy-store'
import { createAgentPushChannel } from '../../services/agent-push-channel'
import { createAgentStop, type StoppableTurns } from '../../services/agent-stop'
import { createAgentEventSender } from '../../services/agent-event-sender'
import { createAgentEventRecorder } from '../../services/agent-events'
import type { AppLifecycle } from '../ports'
import { createPluginFetcher } from '../plugins/fetch'
import { createPluginPackageStore } from '../plugins/store'
import type { PluginTrust } from '../plugins/trust'

export interface AgentControlDeps {
  serverUrl: () => string
  session: Pick<Session, 'cookies' | 'userId'>
  userDataDir: () => string
  home: string
  /** The chat server's running turns, once it started. */
  turns: () => StoppableTurns | null
  lifecycle: AppLifecycle
  /** A `records` signal for a company (no content: the listener asks the server again). */
  onRecords?: (companyId: string) => void
  /** A `notifications` signal for a company (no content: the listener asks the server again). */
  onNotifications?: (companyId: string) => void
  /** The plugin packages a company lists and this app keeps changed (its plugin screens change, A6). */
  onPluginsChanged?: (companyId: string) => void
  /** Plugin trust P2 (plugins/trust-wire.ts): refreshed when a company's `pluginTrust` marker changes. */
  pluginTrust?: Pick<PluginTrust, 'refresh'>
}

/**
 * The policy answer's `pluginTrust` marker → a trust refresh (plugin-trust.md "P2"): once per new
 * marker per company (and once after a start, when nothing was taken yet). A failed refresh is
 * tried again at the next answer; an answer without the marker (an older server, no `trust/`)
 * changes nothing.
 */
export function refreshTrustOnMarker(trust: Pick<PluginTrust, 'refresh'>) {
  const taken = new Map<string, string>()
  const running = new Set<string>()
  return (companyId: string, marker: string | undefined): void => {
    if (!marker || taken.get(companyId) === marker || running.has(companyId)) return
    running.add(companyId)
    void trust.refresh(companyId)
      .then(outcome => { if (outcome.ok) taken.set(companyId, marker) })
      .catch(() => undefined)
      .finally(() => running.delete(companyId))
  }
}

/**
 * What a push event does to the policy (its only effect): the version already held → the server
 * just said it is unchanged, which confirms the stop (agent-stop.ts); anything else → refetch.
 */
export function refreshOnPush(policy: Pick<AgentPolicyStore, 'confirmVersion' | 'refresh'>) {
  return (companyId: string, version?: string) => {
    if (version && policy.confirmVersion(companyId, version)) return
    void policy.refresh(companyId)
  }
}

export function wireAgentControl({ serverUrl, session, userDataDir, home, turns, lifecycle, onRecords, onNotifications, onPluginsChanged, pluginTrust }: AgentControlDeps) {
  // The member's AI policy per company (「AI の囲い」 and the stop), read at each chat turn.
  // The stop part is also kept on disk per account (the emergency stop survives a restart offline).
  const policy = createAgentPolicyStore({
    baseUrl: serverUrl,
    cookies: session.cookies,
    userId: session.userId,
    dir: () => path.join(userDataDir(), 'agent-policy'),
  })
  // The business plugins' packages the policy lists (plan C2): fetched, verified and kept under
  // <userData>/plugins; removed when no company lists them. The renderer sees only their screens (A6).
  const pluginPackages = createPluginPackageStore({
    dir: () => path.join(userDataDir(), 'plugins'),
    userId: session.userId,
    fetchPackage: createPluginFetcher({ baseUrl: serverUrl, cookies: session.cookies }),
    onChanged: onPluginsChanged,
  })
  const trustOnMarker = pluginTrust ? refreshTrustOnMarker(pluginTrust) : null
  policy.onPolicy((companyId, answer) => {
    if (answer.plugins) void pluginPackages.sync(companyId, answer.plugins)
    trustOnMarker?.(companyId, answer.pluginTrust)
  })
  // The push channel's only effect is a policy refetch; a received stop stops
  // the company's running turns (services/agent-stop.ts).
  const pushChannel = createAgentPushChannel({
    baseUrl: serverUrl,
    cookies: session.cookies,
    refresh: refreshOnPush(policy),
    onRecords,
    onNotifications,
  })
  lifecycle.beforeQuit(() => pushChannel.stopAll())
  const stop = createAgentStop({ policy, watch: companyId => pushChannel.watch(companyId), turns })

  // The AI action log: the recorder (memory + console) and its sender, which
  // queues per signed-in account and company under <userData>/agent-events
  // and posts to the server (services/agent-event-sender.ts).
  const eventSender = createAgentEventSender({
    dir: () => path.join(userDataDir(), 'agent-events'),
    baseUrl: serverUrl,
    cookies: session.cookies,
    userId: session.userId,
  })
  lifecycle.willQuit(() => eventSender.flushSync())
  const events = createAgentEventRecorder({ home, appDataDirs: [userDataDir()], sinks: [eventSender] })

  return {
    policy,
    pluginPackages,
    stop,
    events,
    eventSender,
    /** Keep a company's push channel open (its records signals reach `onRecords`). */
    watchSignals: (companyId: string) => pushChannel.watch(companyId),
    /** Another account must not inherit this one's policies, watches or queued events. */
    signedOut() {
      policy.clear()
      pushChannel.stopAll()
      eventSender.signedOut()
    },
  }
}
