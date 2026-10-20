import type { LanguageModel } from 'ai'

/** The Vercel model interface remains the streaming boundary; no second agent loop. */
export interface AgentConnection {
  readonly id: string
  readonly ownsConversation: boolean
  authenticationError(): string | undefined
  createChatModel(request: {
    workingDirectory?: string
    appSessionId?: string
    modelId?: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    resumeId?: string
  }): LanguageModel
  createTitleModel(): LanguageModel
  readMetadata(metadata: Record<string, unknown> | undefined): {
    sessionId?: string
    contextUsage?: { inputTokens: number; outputTokens: number; contextWindow?: number }
  }
}
