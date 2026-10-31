import { useMemo, useRef } from 'react'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { DefaultChatTransport } from 'ai'
import type { AuthMode } from '../../../../shared/agent'
import type { ChatServerClient } from '../chatServerClient'
import { buildChatRequestBody, type ChatRequestSources } from '../chatRequestBody'

export interface ChatRequestContextValues {
  authMode: AuthMode
  workingDirectory: string | undefined
  activeDepartment: { name: string; folder: string } | undefined
  companyId: string | undefined
  /** The company checkout root: the chat's write guard judges paths relative to it. */
  companyRootPath: string | undefined
  modelId: string | undefined
  effort: string
}

/**
 * The values each `/api/chat` request carries, as refs the transport reads
 * when it builds a request. Refs because the transport is created once
 * (useChat keeps its first one); updating them re-renders nothing.
 *
 * All are current from the render on, before any effect or handler of
 * that commit sends.
 */
export function useChatRequestContext(v: ChatRequestContextValues) {
  const authModeRef = useLatestRef(v.authMode)
  const workingDirRef = useLatestRef(v.workingDirectory)
  const activeDepartmentRef = useLatestRef(v.activeDepartment)
  const modelIdRef = useLatestRef(v.modelId)
  const effortRef = useLatestRef(v.effort)
  const companyIdRef = useLatestRef(v.companyId)
  const companyRootRef = useLatestRef(v.companyRootPath)

  return { authModeRef, workingDirRef, activeDepartmentRef, modelIdRef, effortRef, companyIdRef, companyRootRef }
}

/** useChat's transport: posts to the chat server with the body built from refs at request time. */
export function useChatTransport(chatServer: ChatServerClient, sources: ChatRequestSources) {
  // Every source is a ref (or a stable getter), so the first render's object
  // stays valid; the transport is recreated only for another chat server.
  const sourcesRef = useRef(sources)
  return useMemo(() => new DefaultChatTransport({
    api: chatServer.chatUrl,
    headers: chatServer.headers,
    body: () => buildChatRequestBody(sourcesRef.current),
  }), [chatServer])
}
