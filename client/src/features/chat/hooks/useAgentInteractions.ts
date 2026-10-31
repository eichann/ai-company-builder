import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import type { AgentInteractionRequest, AgentInteractionResponse } from '../../../../shared/agent-interaction'
import type { ToolApprovalRequest } from '../../../../shared/ipc-contract'
import { getAgentInteractions, onAgentInteraction, onAgentInteractionClosed, onToolApprovalRequest, respondAgentInteraction, respondToolApproval } from '../api'

/**
 * Questions the agent asks the member (choice prompts, Codex approvals;
 * shared/agent-interaction.ts). Every conversation's questions are kept, and
 * only the one of the conversation on screen is shown — a question asked while
 * this tab shows another conversation is still there when the member comes
 * back. Questions of this tab's conversation are cancelled when the tab closes.
 *
 * `currentInteraction` is looked up during render from `appSessionIdRef`
 * (the conversation can change without a re-render of its own).
 */
export function useAgentInteractions(appSessionIdRef: MutableRefObject<string | null>) {
  const [interactions, setInteractions] = useState<AgentInteractionRequest[]>([])
  const currentInteraction = interactions.find(item => item.appSessionId === appSessionIdRef.current)
  useEffect(() => {
    let active = true
    const closed = new Set<string>()
    // Kept for every conversation (shown only for the one on screen), so a
    // question asked while this tab shows another conversation is still
    // there when the member comes back to it.
    const add = (request: AgentInteractionRequest) => {
      if (!active || closed.has(request.id)) return
      setInteractions(queue => queue.some(item => item.id === request.id) ? queue : [...queue, request])
    }
    const unsubscribe = onAgentInteraction(add)
    const unsubscribeClosed = onAgentInteractionClosed(request => {
      closed.add(request.id)
      setInteractions(queue => queue.filter(item => item.id !== request.id))
    })
    void getAgentInteractions().then(requests => requests.forEach(add)).catch(() => {})
    return () => {
      active = false; unsubscribe(); unsubscribeClosed()
      // The conversation shown when the tab closes (not the one at mount): read at clean-up on purpose.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const sessionId = appSessionIdRef.current
      void getAgentInteractions().then(requests => Promise.all(requests
        .filter(item => item.appSessionId === sessionId)
        .map(item => respondAgentInteraction(item.id, { cancelled: true })))).catch(() => {})
    }
  }, [appSessionIdRef])

  /** Answer a question; it leaves the queue once main accepted the answer. */
  const respondToInteraction = useCallback(async (id: string, response: AgentInteractionResponse) => {
    const accepted = await respondAgentInteraction(id, response)
    if (accepted) setInteractions(queue => queue.filter(item => item.id !== id))
    return accepted
  }, [])

  return { currentInteraction, respondToInteraction }
}

/**
 * Tool approvals the app asks for (dangerous commands, private content going
 * public): only this tab's conversation's, first come first shown; all of
 * them are dropped when the turn ends.
 */
export function useToolApprovals(appSessionIdRef: MutableRefObject<string | null>, status: string) {
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([])
  const pendingApproval = pendingApprovals[0]

  useEffect(() => {
    const unsub = onToolApprovalRequest((data) => {
      // Only accept approval requests for this tab's session
      if (data.appSessionId && data.appSessionId !== appSessionIdRef.current) {
        return // Not for this tab
      }
      setPendingApprovals(queue => queue.some(p => p.toolUseId === data.toolUseId) ? queue : [...queue, data])
    })
    return unsub
  }, [appSessionIdRef])

  const respondToApproval = useCallback((toolUseId: string, approved: boolean) => {
    respondToolApproval(toolUseId, approved)
    setPendingApprovals(queue => queue.filter(p => p.toolUseId !== toolUseId))
  }, [])

  useEffect(() => {
    if (status === 'ready' || status === 'error') setPendingApprovals([])
  }, [status])

  return { pendingApproval, respondToApproval }
}
