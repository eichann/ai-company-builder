import type { ChatServerInfo } from '../../../shared/ipc-contract'
import {
  CHAT_SERVER_PATHS,
  type GenerateTitleRequest,
  type GenerateTitleResponse,
  type PromptSuggestionResponse,
  type RateLimitsResponse,
  type SessionInfoResponse,
  type SteerRequest,
} from '../../../shared/chat-server-api'
import type { SteerResponse } from '../../../shared/steer'

/**
 * The renderer's one client for the chat server (electron/chat-server.ts):
 * the only place that builds its URLs and the `Authorization` header.
 * Contract types: shared/chat-server-api.ts.
 *
 * Error behaviour is per call and deliberately the one each caller had:
 * `steer` and `forgetSession` never throw; the others reject on a network or
 * parse error and the caller decides (most keep what they have).
 */
export interface ChatServerClient {
  /** Where DefaultChatTransport posts a turn, and the header it sends. */
  readonly chatUrl: string
  readonly headers: Readonly<Record<string, string>>
  /** An extra instruction for the conversation's running turn; any failure is `unavailable`. */
  steer(appSessionId: string, text: string): Promise<SteerResponse>
  /** The latest turn's next-prompt suggestion; null when the server answers with an error status. */
  promptSuggestion(appSessionId: string): Promise<Partial<PromptSuggestionResponse> | null>
  /** The conversation's current native session (to persist for resume). */
  sessionInfo(appSessionId: string): Promise<Partial<SessionInfoResponse>>
  /** Forget the conversation's native session on the server (new chat, tab closed). Fire and forget. */
  forgetSession(appSessionId: string): void
  /** The last known plan usage of an agent (header meter). */
  rateLimits(provider: string): Promise<Partial<RateLimitsResponse>>
  /** A short title for a conversation; null when the server answers with an error status. */
  generateTitle(request: GenerateTitleRequest): Promise<GenerateTitleResponse | null>
}

/**
 * `fetch` is looked up at call time, not captured here: the preview pages
 * replace `window.fetch` with a fake chat server after the modules load.
 */
export function createChatServerClient(info: ChatServerInfo, fetchImpl: () => typeof fetch = () => fetch): ChatServerClient {
  const base = `http://127.0.0.1:${info.port}`
  const auth = { Authorization: `Bearer ${info.authToken}` }
  const json = { ...auth, 'Content-Type': 'application/json' }
  const call = (path: string, init?: RequestInit) => fetchImpl()(`${base}${path}`, { headers: auth, ...init })

  return {
    chatUrl: `${base}${CHAT_SERVER_PATHS.chat}`,
    headers: auth,

    async steer(appSessionId, text) {
      try {
        const body: SteerRequest = { appSessionId, text }
        const res = await call(CHAT_SERVER_PATHS.steer, { method: 'POST', headers: json, body: JSON.stringify(body) })
        const data = res.ok ? await res.json() as Partial<SteerResponse> : null
        return data?.status === 'delivered' || data?.status === 'not-delivered' ? { status: data.status, id: data.id } : { status: 'unavailable' }
      } catch {
        return { status: 'unavailable' }
      }
    },

    async promptSuggestion(appSessionId) {
      const res = await call(CHAT_SERVER_PATHS.promptSuggestion(appSessionId))
      return res.ok ? await res.json() as Partial<PromptSuggestionResponse> : null
    },

    async sessionInfo(appSessionId) {
      const res = await call(CHAT_SERVER_PATHS.session(appSessionId))
      return await res.json() as Partial<SessionInfoResponse>
    },

    forgetSession(appSessionId) {
      call(CHAT_SERVER_PATHS.session(appSessionId), { method: 'DELETE' }).catch(() => {})
    },

    async rateLimits(provider) {
      const res = await call(CHAT_SERVER_PATHS.rateLimits(provider))
      return await res.json() as Partial<RateLimitsResponse>
    },

    async generateTitle(request) {
      const res = await call(CHAT_SERVER_PATHS.generateTitle, { method: 'POST', headers: json, body: JSON.stringify(request) })
      if (!res.ok) return null
      return await res.json() as GenerateTitleResponse
    },
  }
}
