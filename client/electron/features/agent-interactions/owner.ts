import type { AgentInteraction, AgentInteractionResponse } from '../../../shared/agent-interaction'
import type { AgentInteractions } from '../../agent-interactions'

type OwnerEvent = 'destroyed' | 'did-start-navigation'

/** The window that shows a conversation (in the app, its webContents). */
export interface InteractionOwner {
  readonly id: number
  isDestroyed(): boolean
  once(event: OwnerEvent, listener: () => void): unknown
  removeListener(event: OwnerEvent, listener: () => void): unknown
}

/**
 * Asks the member in the window showing the conversation. Its questions are
 * cancelled when that window goes away or reloads; no window → cancelled.
 */
export function requestFromOwner(
  interactions: Pick<AgentInteractions, 'request' | 'closeOwner'>,
  owner: InteractionOwner | undefined,
  request: AgentInteraction,
  appSessionId: string,
  signal: AbortSignal,
): Promise<AgentInteractionResponse> {
  if (!owner || owner.isDestroyed()) return Promise.resolve({ cancelled: true })
  const ownerId = owner.id
  const close = () => interactions.closeOwner(ownerId)
  owner.once('destroyed', close)
  owner.once('did-start-navigation', close)
  return interactions.request(ownerId, appSessionId, request, signal).finally(() => {
    owner.removeListener('destroyed', close)
    owner.removeListener('did-start-navigation', close)
  })
}
