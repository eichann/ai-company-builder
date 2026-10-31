import type { AgentSession, AuthMode } from '../../../shared/agent'
import type { ChatRequestOptions } from '../../../shared/chat-server-api'

type Ref<T> = { current: T }

/** Where each `/api/chat` body field comes from: refs, read when the request is made. */
export interface ChatRequestSources {
  authMode: Ref<AuthMode>
  agentSession: Ref<AgentSession | null | undefined>
  workingDirectory: Ref<string | undefined>
  companyId: Ref<string | undefined>
  companyRootPath: Ref<string | undefined>
  activeDepartment: Ref<{ name: string; folder: string } | undefined>
  modelId: Ref<string | undefined>
  effort: Ref<string>
  /** Settings → 入力候補; off → the CLI is not asked for a suggestion. */
  promptSuggestions: () => boolean
  appSessionId: Ref<string | null>
  claudeSessionId: Ref<string | null>
  /** Consumed by the request that carries them. */
  pendingImages: Ref<Array<{ mediaType: string; data: string }>>
  pendingFilePaths: Ref<string[]>
  /** Which conversation the hand-off memo of this turn belongs to (read in onFinish). */
  handoffRequest: Ref<{ companyId: string; sessionId: string; provider: AuthMode } | null>
}

/**
 * The body DefaultChatTransport sends next to `messages`. Side effects, in
 * this order and exactly once per request: creates the app session id if
 * there is none yet, consumes the pending images and reference files, and
 * records which conversation the turn's hand-off belongs to.
 */
export function buildChatRequestBody(s: ChatRequestSources): ChatRequestOptions {
  const body: ChatRequestOptions = {
    authMode: s.authMode.current,
    agentSession: s.agentSession.current,
    workingDirectory: s.workingDirectory.current,
    companyId: s.companyId.current,
    companyRootPath: s.companyRootPath.current,
    activeDepartment: s.activeDepartment.current || undefined,
    modelId: s.modelId.current,
    effort: s.effort.current,
    promptSuggestions: s.promptSuggestions(),
  }
  // Ensure app session ID exists (eagerly create on first request)
  if (!s.appSessionId.current) {
    s.appSessionId.current = crypto.randomUUID()
  }
  body.appSessionId = s.appSessionId.current
  // Include persisted Claude CLI session ID for resume after restart
  if (s.claudeSessionId.current) {
    body.claudeSessionId = s.claudeSessionId.current
  }
  if (s.pendingImages.current.length > 0) {
    body.images = s.pendingImages.current
    s.pendingImages.current = []
  }
  if (s.pendingFilePaths.current.length > 0) {
    body.referenceFiles = s.pendingFilePaths.current
    s.pendingFilePaths.current = []
  }
  s.handoffRequest.current = s.companyId.current && s.appSessionId.current ? { companyId: s.companyId.current, sessionId: s.appSessionId.current, provider: s.authMode.current } : null
  return body
}
