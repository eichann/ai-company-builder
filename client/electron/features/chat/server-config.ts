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
import type { RecordsApi } from '../../records/api'
import { createRecordTools } from '../../records/tools'
import { readMailAttachment } from '../../records/mail-attachments'
import { recordToolProviders } from '../../records/tool-providers'
import type { JobWriteArea } from '../../../shared/ai-turn-steps/job'
import type { DrivePicking } from '../google/drive'
import type { PathGuard } from '../ports'
import { companyFilesInstructions, createCompanyFileTools } from '../../company-files/tools'
import { createWebResearchBudget, createWebResearchTools } from '../../web-research/tools'
import { WEB_RESEARCH_INSTRUCTIONS } from '../../../shared/web-research'
import { runSecondOpinion, runWebReader } from '../../agents/registry'
import { ConsultationReferences } from '../../consultations/service'
import type { HandoffService } from '../../handoff/service'
import type { HandoffStore } from '../../handoff/store'
import type { ClaudeCli } from '../../services/claude-cli'
import type { ConfigStore } from '../../services/config-store'
import type { AgentEventRecorder } from '../../services/agent-events'
import { secondOpinionAllowed, type AgentPolicyStore } from '../../services/agent-policy-store'
import type { AgentStop } from '../../services/agent-stop'
import type { SkillUseReporter } from '../../services/skill-use-reporter'
import type { BrokerTokenStore } from '../../services/broker-token-store'
import { agentBrokerReservedServices } from '../../../shared/agents/registry'
import type { ShellEnvironment } from '../../services/shell-env'
import { notDownloadedFolders } from '../../sync/not-downloaded'
import { readLocalPrivateSkills } from '../../sync/local-ignores'
import type { WriteAccessStore } from '../../write-access-store'
import type { ToolApprovals } from '../agent-interactions/ipc'
import type { ChatHistoryEvents } from '../chat-history/ipc'
import type { PrivateFolderGuards } from '../private-folders/guards'
import { buildSystemPrompt } from './system-prompt'
import type { WorkingFolders } from '../../services/working-folders'
import type { SkillShelfStore } from '../skill-shelf/store'
import { taskTopicOf, topicAfterTaskMade } from '../../../shared/consultation-task'

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
  /** The company map for the AI: a record token per turn (records/api.ts). */
  records: RecordsApi
  /** The member's own AI changed a record in this company: the task list and 「あなたの番」 read again now (tasks-ui.md). */
  recordsChanged?: (companyId: string) => void
  toolApprovals: ToolApprovals
  /** A choice prompt in the window that owns the chat (closed with it). */
  requestInteraction: ChatServerConfig['requestInteraction']
  /** One of the app's AI commands, run in the main window (features/app-commands/ipc.ts). */
  runAppCommand?: ChatServerConfig['runAppCommand']
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
  /** Google Drive (features/google/drive.ts): the person's Picker; absent = no Drive tools. */
  drivePicking?: Pick<DrivePicking, 'pick'>
  /** A scheduled job's run held for a consultation: its `job_report` (features/ai-turns/job-runs.ts); null otherwise. */
  jobReport?: (conversationId: string) => ((result: unknown) => Promise<string | null>) | null
  /** A scheduled job's run held for a consultation: where it may write (its deliverable area); null otherwise. */
  jobWriteArea?: (conversationId: string) => JobWriteArea | null
  /** Whether a consultation's record token is bound to an execution run (records/runs.ts). */
  runBound?: (companyId: string, conversationId: string) => boolean
  /** The allowed-roots check (a Drive put reads a local file). */
  paths?: PathGuard
  /** Which Skill a consultation used (services/skill-use-reporter.ts, records.md "Which Skill"); absent = not recorded. */
  skillUses?: Pick<SkillUseReporter, 'observe'>
  /**
   * Working folders of companies without the shared folder (services/working-folders.ts): the
   * write guard keeps only its own rules there, and the company file tools are not offered.
   */
  workingFolders?: Pick<WorkingFolders, 'has'>
  /** What the company delivered into a working folder (features/skill-shelf/store.ts). */
  skillShelf?: Pick<SkillShelfStore, 'managedPaths' | 'turn'>
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
      if (deps.workingFolders?.has(root)) {
        // Nothing here reaches the push checker: only the rules that are the app's own
        // (write-guard.ts `folderKind: 'none'`). Who may change agent config: /me/capabilities.
        await deps.privateFolders.refreshAuthority(companyId, 3000)
        return {
          root,
          folderKind: 'none' as const,
          getAccess: () => undefined,
          getShelfPaths: () => deps.skillShelf?.managedPaths(companyId, root) ?? [],
          getInstructionAuthority: () => deps.privateFolders.authority(companyId),
        }
      }
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
        getPrivateSkills: () => readLocalPrivateSkills(root),
      }
    },
    shelfTurn: (companyId, root, departmentFolder) => (deps.workingFolders?.has(root) ? deps.skillShelf?.turn(companyId, root, departmentFolder) : undefined),
    getBrokerEnv: async ({ agent, companyId, conversationId, department }) =>
      deps.brokerTokens ? deps.brokerTokens.envFor({ companyId, conversationId, department, reservedServices: agentBrokerReservedServices(agent) }) : {},
    // 「もう一方の AI に聞く」: the company's setting from the policy (unknown = not allowed).
    secondOpinionAllowed: async companyId => secondOpinionAllowed(await deps.agentPolicy.refresh(companyId, { timeoutMs: 3000 })),
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
      // A company without the shared folder has no company files on the server (NO_COMPANY_FOLDER):
      // tools that always fail are not offered.
      if (root && deps.workingFolders?.has(root)) return undefined
      let notDownloaded: string[] = []
      try { notDownloaded = root ? notDownloadedFolders(root) : [] } catch { /* unknown: the instructions just do not list them */ }
      return {
        tools: createCompanyFileTools({ api: deps.companyFiles, companyId, companyRoot: root, signal }),
        instructions: companyFilesInstructions(notDownloaded),
      }
    },
    createRecordTools: async ({ companyId, conversationId, agent, actions, requireRun, companyRoot, department, largeContext, onOperationCard, onApprovalCard, onBundleChoice, onMailDraft, onDriveOverwrite }, signal) => {
      const access = await deps.records.openTurn(companyId, { conversationId, agent, scope: actions ? 'act' : 'read', ...(requireRun ? { requireRun } : {}) })
      // Connectors' tools ride on the same token (records/tool-providers.ts: Google Drive, …).
      // A Drive put in a consultation about a やること is linked to it by the server (google-drive.md).
      const topicTask = () => taskTopicOf(deps.history.get(companyId, conversationId))
      // A company without the shared folder: its folder is the member's own working folder (Drive's words say so).
      const workingFolder = !!companyRoot && deps.workingFolders?.has(companyRoot) === true
      const toolProviders = recordToolProviders(deps, { companyId, companyRoot: companyRoot ?? null, topicTask, conversationId, onDriveOverwrite, workingFolder })
      const onRecordChanged = deps.recordsChanged ? () => deps.recordsChanged?.(companyId) : undefined
      // A task the AI makes in a consultation without a topic becomes its topic (consultation-task.ts).
      const onRecordCreated = (made: { id: unknown; type: unknown }) => {
        const topic = topicAfterTaskMade(deps.history.get(companyId, conversationId), made)
        if (topic && deps.history.patch(companyId, conversationId, { topicRecordId: topic })) deps.chatHistory.changed({ companyId, sessionId: conversationId, kind: 'patch' })
      }
      // A mail draft's PDFs are read here, in main, inside this consultation's company folder only.
      const readAttachment = companyRoot ? (file: string) => readMailAttachment(file, companyRoot) : undefined
      return access ? createRecordTools(access, signal, { companyId, conversationId, department, largeContext, onRecordChanged, onRecordCreated, onOperationCard, onApprovalCard, onBundleChoice, onMailDraft, toolProviders, readMailAttachment: readAttachment }) : null
    },
    consultationTopic: (companyId, conversationId) => {
      const session = deps.history.get(companyId, conversationId)
      return session ? { topicRecordId: session.topicRecordId, topicDetached: session.topicDetached } : null
    },
    consultationsAbout: (companyId, recordId, exceptConversationId) => deps.history.summaries(companyId)
      .filter(s => s.topicRecordId === recordId && s.id !== exceptConversationId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(s => s.title),
    createWebResearch: ({ agent, conversationId, signal }) => ({
      tools: createWebResearchTools({
        budget: webResearchBudget, conversationId, signal,
        // The member's own agent, read when the call runs (CLI path, environment).
        run: (input, readerSignal) => runWebReader(agent, { input, signal: readerSignal, host: { getCli: deps.claudeCli.path, env: deps.shellEnv.env() } }),
      }),
      instructions: WEB_RESEARCH_INSTRUCTIONS,
    }),
    // 「もう一方の AI に聞く」: the other agent's own CLI and login on this computer, read when asked.
    runSecondOpinion: (target, request) => runSecondOpinion(target, {
      ...request, host: { getCli: deps.claudeCli.path, env: deps.shellEnv.env(), claudeReady: deps.claudeCli.isAuthenticated },
    }),
    createReferences: (company, id, signal) => new ConsultationReferences(deps.history, deps.handoffStore).forTurn(company, id, signal),
    prepareRecovery: (company, id, messages) => recoveryContext(deps.history.get(company, id), deps.handoffStore.read(company, id), messages),
    onRecovery: (company, id, recovery) => deps.handoffs.recordRecovery(company, id, recovery),
    persistAgentSession: (company, id, session) => {
      if (!deps.history.patch(company, id, { agentSession: session, claudeSessionId: session.providerId === 'claude-code' ? session.id : '' })) throw new Error('相談が削除されたため引き継ぎを中止しました。')
      deps.chatHistory.changed({ companyId: company, sessionId: id, kind: 'patch' })
    },
    requestInteraction: deps.requestInteraction,
    runAppCommand: deps.runAppCommand,
    requestToolApproval: (toolName, toolInput, toolUseId, appSessionId, reason) => deps.toolApprovals.request(toolName, toolInput, toolUseId, appSessionId, reason),
    cancelInteractions: appSessionId => {
      deps.toolApprovals.cancel(appSessionId)
      deps.cancelChoicePrompts(appSessionId)
    },
    prepareAgentStop: deps.agentStop ? companyId => deps.agentStop!.prepareTurn(companyId) : undefined,
    oneShotAiAllowed: deps.agentStop ? () => deps.agentStop!.oneShotAiAllowed() : undefined,
    onToolEvent: event => deps.agentEvents.record(event),
    toolEventPaths: () => deps.agentEvents.paths(),
    onSkillUsed: deps.skillUses ? sighting => deps.skillUses?.observe(sighting) : undefined,
}
}
