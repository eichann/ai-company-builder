// The chat asking the member: choice prompts (agent-interactions.ts, cards
// above the composer) and tool approvals (the D5 / dangerous-command banner).
//   agent-interaction:list, agent-interaction:respond, tool-approval-response

import type { AgentInteractionResponse } from '../../../shared/agent-interaction'
import type { ToolApprovalRequest } from '../../../shared/ipc-contract'
import type { AgentInteractions } from '../../agent-interactions'
import type { IpcRegistrar } from '../../ipc/registrar'

/** Pending tool approvals: the chat server asks, the renderer answers (60 s, then denied). */
export interface ToolApprovals {
  request(toolName: string, toolInput: Record<string, unknown>, toolUseId: string, appSessionId?: string, reason?: string): Promise<{ approved: boolean }>
  respond(toolUseId: string, approved: boolean): void
}

/** `notify` shows the request in the window (tool-approval-request). */
export function createToolApprovals(notify: (request: ToolApprovalRequest) => void): ToolApprovals {
  // Tool approval IPC (chat-server → renderer → response)
  const pendingApprovals = new Map<string, { resolve: (result: { approved: boolean }) => void }>()
  return {
    request(toolName, toolInput, toolUseId, appSessionId, reason) {
      return new Promise((resolve) => {
        pendingApprovals.set(toolUseId, { resolve })
        notify({
          toolUseId, toolName, toolInput, appSessionId, ...(reason ? { reason } : {}),
        })
        // 60s timeout → auto-deny
        setTimeout(() => {
          if (pendingApprovals.has(toolUseId)) {
            pendingApprovals.delete(toolUseId)
            resolve({ approved: false })
          }
        }, 60_000)
      })
    },
    respond(toolUseId, approved) {
      const pending = pendingApprovals.get(toolUseId)
      if (pending) {
        pending.resolve({ approved })
        pendingApprovals.delete(toolUseId)
      }
    },
  }
}

export interface AgentInteractionsDeps {
  interactions: AgentInteractions
  approvals: ToolApprovals
}

export function registerAgentInteractionsIpc(ipc: IpcRegistrar, { interactions, approvals }: AgentInteractionsDeps): void {
  ipc.handle('agent-interaction:list', event => interactions.list(event.sender.id))
  ipc.handle('agent-interaction:respond', (event, id: string, response: AgentInteractionResponse) => interactions.respond(event.sender.id, id, response))

  ipc.handle('tool-approval-response', (_, toolUseId: string, approved: boolean) => {
    approvals.respond(toolUseId, approved)
    return true
  })
}
