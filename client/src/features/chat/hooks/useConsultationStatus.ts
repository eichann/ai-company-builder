import { useEffect, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import type { AgentInteraction } from '../../../../shared/agent-interaction'
import { deriveConsultationStatus, runningSubagentId } from '../../../lib/consultationStatus'
import { useAgentProgress } from '../agentStatusStore'
import { clearConsultationStatus, publishConsultationStatus } from '../consultationStatusStore'

/**
 * Publishes this tab's status for the 「AIへの相談」 list. A turn that ends
 * while the member looks at another conversation is 「結果が届いています」
 * (unseen); it stays so while the member reads it and becomes done once they
 * move on to another conversation.
 */
export function useConsultationStatus({ tabId, isActive, status, approval, interaction, messages, rootPath }: {
  tabId: string
  isActive: boolean
  status: string
  approval?: { toolName: string; toolInput?: Record<string, unknown> }
  interaction?: AgentInteraction
  messages: UIMessage[]
  rootPath?: string
}) {
  const running = status === 'submitted' || status === 'streaming'
  const [unseen, setUnseen] = useState(false)
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const wasRunning = useRef(running)
  useEffect(() => {
    if (running) setUnseen(false)
    else if (wasRunning.current && !isActiveRef.current) setUnseen(true)
    wasRunning.current = running
  }, [running])
  const wasActive = useRef(isActive)
  useEffect(() => {
    if (wasActive.current && !isActive) setUnseen(false)
    wasActive.current = isActive
  }, [isActive])

  const lastMessage = messages[messages.length - 1]
  const progressLine = useAgentProgress(runningSubagentId(lastMessage) ?? '')
  const derived = deriveConsultationStatus({ status, approval, interaction, lastMessage, progressLine, unseen, rootPath })
  const { state, kind, line } = derived
  useEffect(() => { publishConsultationStatus(tabId, { state, kind, line }) }, [tabId, state, kind, line])
  useEffect(() => () => clearConsultationStatus(tabId), [tabId])
}
