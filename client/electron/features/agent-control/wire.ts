// Watching and stopping the AI (monitoring M1 and M2): the member's AI policy
// per company, the emergency stop and its push channel, and the AI action log.
import path from 'path'
import type { Session } from '../../services/session'
import { createAgentPolicyStore } from '../../services/agent-policy-store'
import { createAgentPushChannel } from '../../services/agent-push-channel'
import { createAgentStop, type StoppableTurns } from '../../services/agent-stop'
import { createAgentEventSender } from '../../services/agent-event-sender'
import { createAgentEventRecorder } from '../../services/agent-events'
import type { AppLifecycle } from '../ports'

export interface AgentControlDeps {
  serverUrl: () => string
  session: Pick<Session, 'cookies' | 'userId'>
  userDataDir: () => string
  home: string
  /** The chat server's running turns, once it started. */
  turns: () => StoppableTurns | null
  lifecycle: AppLifecycle
}

export function wireAgentControl({ serverUrl, session, userDataDir, home, turns, lifecycle }: AgentControlDeps) {
  // The member's AI policy per company (「AI の囲い」 and the stop), read at each chat turn.
  // The stop part is also kept on disk per account (the emergency stop survives a restart offline).
  const policy = createAgentPolicyStore({
    baseUrl: serverUrl,
    cookies: session.cookies,
    userId: session.userId,
    dir: () => path.join(userDataDir(), 'agent-policy'),
  })
  // The push channel's only effect is a policy refetch; a received stop stops
  // the company's running turns (services/agent-stop.ts).
  const pushChannel = createAgentPushChannel({
    baseUrl: serverUrl,
    cookies: session.cookies,
    refresh: (companyId, version) => {
      if (version && policy.get(companyId)?.version === version) return
      void policy.refresh(companyId)
    },
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
    stop,
    events,
    eventSender,
    /** Another account must not inherit this one's policies, watches or queued events. */
    signedOut() {
      policy.clear()
      pushChannel.stopAll()
      eventSender.signedOut()
    },
  }
}
