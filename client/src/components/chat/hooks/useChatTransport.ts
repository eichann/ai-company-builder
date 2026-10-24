import { useEffect, useMemo, useRef } from 'react'
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
 * Timing kept from the original panel: agent and company are current from
 * the render on; folder, department, model and effort follow after the
 * commit (effects), and the effects that send run after these.
 */
export function useChatRequestContext(v: ChatRequestContextValues) {
  const authModeRef = useRef(v.authMode)
  authModeRef.current = v.authMode
  const workingDirRef = useRef(v.workingDirectory)
  const activeDepartmentRef = useRef(v.activeDepartment)
  const modelIdRef = useRef<string | undefined>(v.modelId)
  const effortRef = useRef<string>(v.effort)
  const companyIdRef = useRef(v.companyId)
  companyIdRef.current = v.companyId
  const companyRootRef = useRef(v.companyRootPath)
  companyRootRef.current = v.companyRootPath

  useEffect(() => {
    workingDirRef.current = v.workingDirectory
  }, [v.workingDirectory])

  useEffect(() => {
    activeDepartmentRef.current = v.activeDepartment
  }, [v.activeDepartment])

  useEffect(() => {
    modelIdRef.current = v.modelId
  }, [v.modelId])

  useEffect(() => {
    effortRef.current = v.effort
  }, [v.effort])

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
