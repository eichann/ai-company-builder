import type { ReferenceTools } from '../consultations/tools'
import type { CompanyFileTools } from '../company-files/tools'
import type { AgentInteraction, AgentInteractionResponse } from '../../shared/agent-interaction'
import type { LanguageModel } from 'ai'
import type { WriteGuard } from '../write-guard'
import type { PrivateReadContext, PrivateReadState } from '../private-read-guard'
import type { ChoiceQuestion, ChoiceResult } from '../../shared/choice-prompt'
import type { RateLimitSnapshot } from '../../shared/rate-limits'
import type { AgentProgressEvent } from '../../shared/agent-progress'
import type { AgentToolEvent } from '../../shared/agent-events'

/**
 * Side information an agent reports while a turn runs (not part of the
 * transcript): plan usage limits for the header meter, and subagent progress
 * lines. `update` merges the agent's payload into the last known snapshot.
 */
export type AgentEvent =
  | { type: 'rate-limits'; update: (previous: RateLimitSnapshot | undefined) => RateLimitSnapshot | undefined }
  | { type: 'agent-progress'; progress: AgentProgressEvent }
import type { TurnSteering } from './steering'

/**
 * Ask the member a choice prompt in this conversation (choice-prompt.ts) and
 * wait for the answer. Resolves `{ cancelled }` on cancel, timeout, a stopped
 * turn, or when the conversation cannot show it. The chat server also records
 * the outcome in the transcript.
 */
export type AskUser = (questions: ChoiceQuestion[], toolCallId: string | undefined, signal: AbortSignal) => Promise<ChoiceResult>

/** The Vercel model interface remains the streaming boundary; no second agent loop. */
export interface AgentConnection {
  readonly id: string
  readonly ownsConversation: boolean
  isMissingSession?(error: unknown, sessionId: string): boolean
  authenticationError(): string | undefined
  createChatModel(request: {
    workingDirectory?: string
    appSessionId?: string
    modelId?: string
    effort?: string
    references?: ReferenceTools
    /** Read-only company files from the server, incl. folders not downloaded (company-files/tools.ts). */
    companyFiles?: CompanyFileTools
    resumeId?: string
    /** Refuse edits to read-only folders before they happen (write-guard.ts). */
    writeGuard?: WriteGuard
    /** What this conversation read from private folders, and where they are (private-read-guard.ts). */
    privateReads?: { context: PrivateReadContext; state: PrivateReadState }
    /** Choice prompts for this turn; absent → the agent is told to ask in plain text. */
    askUser?: AskUser
    /** Usage limits and subagent progress while the turn runs. */
    onEvent?: (event: AgentEvent) => void
    /** Extra instructions while this turn runs (steering.ts); the connection attaches its target. */
    steering?: TurnSteering
    /**
     * The agent's predicted next prompt after this turn (Claude Code's
     * `promptSuggestions`), or null once the turn ended without one.
     */
    onPromptSuggestion?: (suggestion: string | null) => void
    /**
     * What this turn's tool events carry besides what the agent knows
     * (shared/agent-events.ts). The events go to the host's `onToolEvent`.
     */
    toolEventContext?: ToolEventContextInput
  }): LanguageModel
  createTitleModel(request?: { modelId?: string }): LanguageModel
  readMetadata(metadata: Record<string, unknown> | undefined): {
    sessionId?: string
  }
}

/** The per-turn part of an AI action log event the chat server knows (company, turn). */
export interface ToolEventContextInput {
  companyId?: string
  companyRoot?: string
  turnId?: string
}

export interface AgentHostConfig {
  /**
   * The AI action log (monitoring M1): every agent reports each tool call
   * here, through a per-turn `createToolEventTracker` (shared/agent-events.ts).
   * Must not throw or block; the agents also guard every call.
   */
  onToolEvent?: (event: AgentToolEvent) => void
  /** Folders whose paths an event marks as secret places (home, the app's userData). */
  toolEventPaths?: () => { home?: string; appDataDirs?: string[] }
  requestInteraction?: (request: AgentInteraction, appSessionId: string, signal: AbortSignal) => Promise<AgentInteractionResponse>
  getShellEnv: () => Record<string, string>
  requestToolApproval?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    appSessionId?: string,
    /** Why the app asks (shown to the member), when it is not the tool's own risk. */
    reason?: string,
  ) => Promise<{ approved: boolean }>
}
