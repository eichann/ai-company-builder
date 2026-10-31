import { useEffect, useState } from 'react'
import type { UIMessage } from 'ai'
import type { AgentInteraction } from '../../../../shared/agent-interaction'
import { deriveConsultationStatus, runningSubagentId } from '../consultationStatus'
import { useAgentProgress } from '../agentStatusStore'
import { clearConsultationStatus, publishConsultationStatus } from '../consultationStatusStore'

/**
 * Publishes this tab's status for the 「AIへの相談」 list. A turn that ends
 * while the member looks at another conversation is 「結果が届いています」
 * (unseen); it stays so while the member reads it and becomes done once they
 * move on to another conversation.
 */
export function useConsultationStatus({ tabId, isShown, status, approval, interaction, messages, rootPath }: {
  tabId: string
  isShown: boolean
  status: string
  approval?: { toolName: string; toolInput?: Record<string, unknown> }
  interaction?: AgentInteraction
  messages: UIMessage[]
  rootPath?: string
}) {
  const running = status === 'submitted' || status === 'streaming'
  const [unseen, setUnseen] = useState(false)
  // Compared with the previous render while rendering (no effect): a turn that
  // ends while the tab is not shown is unseen; leaving the tab clears it.
  const [previous, setPrevious] = useState({ running, isShown })
  if (previous.running !== running || previous.isShown !== isShown) {
    setPrevious({ running, isShown })
    let next = unseen
    if (running !== previous.running) next = running ? false : (!isShown || next)
    if (previous.isShown && !isShown) next = false
    if (next !== unseen) setUnseen(next)
  }

  const lastMessage = messages[messages.length - 1]
  const progressLine = useAgentProgress(runningSubagentId(lastMessage) ?? '')
  const derived = deriveConsultationStatus({ status, approval, interaction, lastMessage, progressLine, unseen, rootPath })
  const { state, kind, line } = derived
  useEffect(() => {
    publishConsultationStatus(tabId, { state, kind, line })
  }, [tabId, state, kind, line])
  // The list forgets the tab when it closes.
  useEffect(() => () => clearConsultationStatus(tabId), [tabId])
}
