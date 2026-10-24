/**
 * The chat server's HTTP contract (electron/chat-server.ts, 127.0.0.1 only,
 * `Authorization: Bearer <token>` on every /api route). Pure types and paths:
 * the server parses requests with these shapes, and the renderer's one client
 * (src/components/chat/chatServerClient.ts) builds every URL and request from
 * them. Not IPC: the address and token come over IPC (`chat-server:getInfo` /
 * `chat-server:info`, `ChatServerInfo` in ipc-contract.ts).
 */
import type { AgentSession, AuthMode } from './agent'
import type { RateLimitSnapshot } from './rate-limits'

export const CHAT_SERVER_PATHS = {
  /** POST: one turn, answered as an AI SDK UI message stream. */
  chat: '/api/chat',
  /** POST {@link SteerRequest} → {@link SteerResponse} (shared/steer.ts). */
  steer: '/api/steer',
  /** GET → {@link PromptSuggestionResponse}; waits (bounded) for the CLI's suggestion. */
  promptSuggestion: (appSessionId: string) => `/api/prompt-suggestion/${encodeURIComponent(appSessionId)}`,
  /** GET → {@link SessionInfoResponse}; DELETE forgets the conversation's native session. */
  session: (appSessionId: string) => `/api/session/${encodeURIComponent(appSessionId)}`,
  /** GET → {@link RateLimitsResponse}. */
  rateLimits: (provider: string) => `/api/rate-limits?provider=${encodeURIComponent(provider)}`,
  /** POST {@link GenerateTitleRequest} → {@link GenerateTitleResponse}. */
  generateTitle: '/api/generate-title',
} as const

/**
 * What the renderer sends with every `/api/chat` request next to `messages`
 * (DefaultChatTransport's `body`). Optional fields are left out when unset.
 */
export interface ChatRequestOptions {
  authMode?: AuthMode
  /** The conversation's current native session (provider-tagged); null = start fresh. */
  agentSession?: AgentSession | null
  workingDirectory?: string
  companyId?: string
  /** The company checkout root: the chat's write guard judges paths relative to it. */
  companyRootPath?: string
  activeDepartment?: { name: string; folder: string }
  modelId?: string
  effort?: string
  /** The member's setting (Settings → 入力候補); absent = on. */
  promptSuggestions?: boolean
  appSessionId?: string
  /** Persisted Claude CLI session id (resume after a restart; older histories). */
  claudeSessionId?: string
  /** Images attached to this message (base64, no data: prefix). */
  images?: Array<{ mediaType: string; data: string }>
  /** Files dropped from the file tree, read by the agent before answering. */
  referenceFiles?: string[]
}

export interface SteerRequest { appSessionId: string; text: string }

export interface PromptSuggestionResponse { suggestion: string | null }

export interface SessionInfoResponse {
  /** The Claude CLI session id when the native session is Claude Code's. */
  claudeSessionId: string | null
  agentSession: AgentSession | null
}

export interface RateLimitsResponse { rateLimits: RateLimitSnapshot | null }

export interface GenerateTitleRequest {
  /** The start of the conversation, greeting left out (the server reads up to 6). */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  authMode?: AuthMode
  modelId?: string
}

export interface GenerateTitleResponse { title?: string; error?: string }
