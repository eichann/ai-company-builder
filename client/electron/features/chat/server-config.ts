// What the embedded chat server (electron/chat-server.ts) gets from the rest
// of the app: settings, the CLI and its environment, the guards (write
// access, private folders, not-downloaded folders), the read-only company
// file tools, hand-off / recovery, and the member's answers (choice prompts,
// tool approvals).

import { recoveryContext } from '../../handoff/recovery-context'
import { normalizePermissionMode } from '../../../shared/permission-mode'
import type { ChatServerConfig } from '../../chat-server'
import type { ChatHistoryStore } from '../../chat-history-store'
import type { CompanyFilesApi } from '../../company-files/api'
import { companyFilesInstructions, createCompanyFileTools } from '../../company-files/tools'
import { createWebResearchBudget, createWebResearchTools } from '../../web-research/tools'
import { WEB_RESEARCH_INSTRUCTIONS } from '../../../shared/web-research'
import { runWebReader } from '../../agents/registry'
import { ConsultationReferences } from '../../consultations/service'
import type { HandoffService } from '../../handoff/service'
import type { HandoffStore } from '../../handoff/store'
import type { ClaudeCli } from '../../services/claude-cli'
import type { ConfigStore } from '../../services/config-store'
import type { AgentEventRecorder } from '../../services/agent-events'
import type { AgentPolicyStore } from '../../services/agent-policy-store'
import type { AgentStop } from '../../services/agent-stop'
import type { BrokerTokenStore } from '../../services/broker-token-store'
import { agentBrokerReservedServices } from '../../../shared/agents/registry'
import type { ShellEnvironment } from '../../services/shell-env'
import { notDownloadedFolders } from '../../sync/not-downloaded'
import type { WriteAccessStore } from '../../write-access-store'
import type { ToolApprovals } from '../agent-interactions/ipc'
import type { ChatHistoryEvents } from '../chat-history/ipc'
import type { PrivateFolderGuards } from '../private-folders/guards'
import { buildSystemPrompt } from './system-prompt'

export interface ChatServerConfigDeps {
  config: ConfigStore
  /** The API key in clear text (services/api-key-store.ts), read per use. */
  apiKey: () => string | undefined
  claudeCli: ClaudeCli
  shellEnv: ShellEnvironment
  history: ChatHistoryStore
  handoffStore: HandoffStore
  handoffs: HandoffService
  chatHistory: ChatHistoryEvents
  writeAccess: WriteAccessStore
  privateFolders: PrivateFolderGuards
  companyFiles: CompanyFilesApi
  toolApprovals: ToolApprovals
  /** A choice prompt in the window that owns the chat (closed with it). */
  requestInteraction: ChatServerConfig['requestInteraction']
  /** Cancel a conversation's pending choice cards (agent-interactions.ts). */
  cancelChoicePrompts: (appSessionId: string) => void
  /** The AI action log (services/agent-events.ts). */
  agentEvents: AgentEventRecorder
  /** The member's AI policy per company (services/agent-policy-store.ts). */
  agentPolicy: AgentPolicyStore
  /** The emergency stop (services/agent-stop.ts); absent = nothing is stopped. */
  agentStop?: Pick<AgentStop, 'prepareTurn' | 'oneShotAiAllowed'>
  /** The server's URL (its host is always reachable from the sandbox). */
  serverUrl: () => string
  /** The key broker's tokens (services/broker-token-store.ts). */
  brokerTokens?: BrokerTokenStore
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname || undefined } catch { return undefined }
}

export function createChatServerConfig(deps: ChatServerConfigDeps): ChatServerConfig {
  // 「Web で調べる」: calls per conversation, for the app's lifetime.
  const webResearchBudget = createWebResearchBudget()
  return {
    getAuthMode: () => deps.config.authMode(),
    getApiKey: deps.apiKey,
    // Unset → 'auto'. A mode the user saved explicitly is kept as-is.
    getPermissionMode: () => normalizePermissionMode(deps.config.load().permissionMode),
    isClaudeCodeAuthenticated: deps.claudeCli.isAuthenticated,
    getClaudeCodeCliPath: deps.claudeCli.path,
    getShellEnv: deps.shellEnv.env,
    buildSystemPrompt,
    onChatActivity: (token, active) => {
      deps.handoffs.setBusy(token, active)
      // A response is over: the AI action log goes out shortly after.
      if (!active) deps.agentEvents.turnEnded()
    },
    getWriteGuard: async (companyId, root) => {
      const [access] = await Promise.all([
        deps.writeAccess.refresh(companyId, { timeoutMs: 3000 }),
        deps.privateFolders.refreshReadable(companyId, 3000),
        deps.privateFolders.refreshAuthority(companyId, 3000),
      ])
      if (!access) console.warn(`[write-access] ${companyId}: unknown at chat start; edits to read-only folders are not blocked in the chat`)
      // getAccess reads the live cache, so a refresh during a long chat applies at once.
      return {
        root,
        getAccess: () => deps.writeAccess.get(companyId),
        getNotDownloaded: () => notDownloadedFolders(root),
        getPrivateFolders: () => deps.privateFolders.readable(companyId),
        getInstructionAuthority: () => deps.privateFolders.authority(companyId),
        getPrivateFolderView: () => deps.privateFolders.guardView(root),
      }
    },
    getBrokerEnv: async ({ agent, companyId, conversationId, department }) =>
      deps.brokerTokens ? deps.brokerTokens.envFor({ companyId, conversationId, department, reservedServices: agentBrokerReservedServices(agent) }) : {},
    getAgentSandbox: async (companyId, root) => {
      const policy = await deps.agentPolicy.refresh(companyId, { timeoutMs: 3000 })
      if (!policy) return undefined
      const { home, appDataDirs } = deps.agentEvents.paths()
      if (!home) return undefined
      const pathVar = deps.shellEnv.env().PATH ?? ''
      return {
        settings: policy.sandbox,
        host: {
          home,
          companyRoot: root,
          appDataDirs,
          toolDirs: pathVar.split(process.platform === 'win32' ? ';' : ':').filter(dir => dir.startsWith('/')),
          serverHost: hostOf(deps.serverUrl()),
        },
      }
    },
    createCompanyFiles: (companyId, root, signal) => {
      let notDownloaded: string[] = []
      try { notDownloaded = root ? notDownloadedFolders(root) : [] } catch { /* unknown: the instructions just do not list them */ }
      return {
        tools: createCompanyFileTools({ api: deps.companyFiles, companyId, companyRoot: root, signal }),
        instructions: companyFilesInstructions(notDownloaded),
      }
    },
    createWebResearch: ({ agent, conversationId, signal }) => ({
      tools: createWebResearchTools({
        budget: webResearchBudget, conversationId, signal,
        // The member's own agent, read when the call runs (CLI path, environment).
        run: (input, readerSignal) => runWebReader(agent, { input, signal: readerSignal, host: { getCli: deps.claudeCli.path, env: deps.shellEnv.env() } }),
      }),
      instructions: WEB_RESEARCH_INSTRUCTIONS,
    }),
    createReferences: (company, id, signal) => new ConsultationReferences(deps.history, deps.handoffStore).forTurn(company, id, signal),
    prepareRecovery: (company, id, messages) => recoveryContext(deps.history.get(company, id), deps.handoffStore.read(company, id), messages),
    onRecovery: (company, id, recovery) => deps.handoffs.recordRecovery(company, id, recovery),
    persistAgentSession: (company, id, session) => {
      if (!deps.history.patch(company, id, { agentSession: session, claudeSessionId: session.providerId === 'claude-code' ? session.id : '' })) throw new Error('相談が削除されたため引き継ぎを中止しました。')
      deps.chatHistory.changed({ companyId: company, sessionId: id, kind: 'patch' })
    },
    requestInteraction: deps.requestInteraction,
    requestToolApproval: (toolName, toolInput, toolUseId, appSessionId, reason) => deps.toolApprovals.request(toolName, toolInput, toolUseId, appSessionId, reason),
    cancelInteractions: appSessionId => {
      deps.toolApprovals.cancel(appSessionId)
      deps.cancelChoicePrompts(appSessionId)
    },
    prepareAgentStop: deps.agentStop ? companyId => deps.agentStop!.prepareTurn(companyId) : undefined,
    oneShotAiAllowed: deps.agentStop ? () => deps.agentStop!.oneShotAiAllowed() : undefined,
    onToolEvent: event => deps.agentEvents.record(event),
    toolEventPaths: () => deps.agentEvents.paths(),
}
}
