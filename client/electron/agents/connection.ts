import type { ReferenceTools } from '../consultations/tools'
import type { CompanyFileTools } from '../company-files/tools'
import type { AgentInteraction, AgentInteractionResponse } from '../../shared/agent-interaction'
import type { LanguageModel } from 'ai'
import type { WriteGuard } from '../write-guard'
import type { PrivateReadContext, PrivateReadState } from '../private-read-guard'
import type { ChoiceQuestion, ChoiceResult } from '../../shared/choice-prompt'

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
  }): LanguageModel
  createTitleModel(request?: { modelId?: string }): LanguageModel
  readMetadata(metadata: Record<string, unknown> | undefined): {
    sessionId?: string
    contextUsage?: { inputTokens: number; outputTokens: number; contextWindow?: number }
  }
}

export interface AgentHostConfig {
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
