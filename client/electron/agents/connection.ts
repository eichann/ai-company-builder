import type { ReferenceTools } from '../consultations/tools'
import type { CompanyFileTools } from '../company-files/tools'
import type { AgentInteraction, AgentInteractionResponse } from '../../shared/agent-interaction'
import type { LanguageModel } from 'ai'
import type { WriteGuard } from '../write-guard'

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
  ) => Promise<{ approved: boolean }>
}
