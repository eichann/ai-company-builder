import type { UIMessage } from 'ai'
import { STEER_PART_TYPE } from '../../../shared/steer'

// Messages the member sends while the AI works (shared/steer.ts): pushed into
// the running turn when the agent can take them, otherwise they wait above the
// input until the turn ends. Pure rules; the hook is useSteering.

/** A message that waits for the running turn to end. */
export interface QueuedSend {
  text: string
  files?: File[]
  filePaths?: string[]
  /** Its `data-steer` part, when the agent took it but did not read it in time. */
  steerPartId?: string
}

/** The part id the chat server gave a steered instruction (`data-steer`). */
export const steerPartId = (steerId: string) => `steer-${steerId}`

/** Steered instructions the agent never read: their bubbles leave the reply (they are sent again). */
export function unreadSteerParts(queue: readonly QueuedSend[]): Set<string> {
  return new Set(queue.flatMap(item => item.steerPartId ? [item.steerPartId] : []))
}

/** The messages without those parts (assistant messages only); the same array when there are none. */
export function withoutSteerParts(messages: UIMessage[], ids: ReadonlySet<string>): UIMessage[] {
  if (!ids.size) return messages
  return messages.map(m => m.role !== 'assistant' ? m : { ...m, parts: m.parts.filter(p => !(p.type === STEER_PART_TYPE && ids.has((p as { id?: string }).id ?? ''))) })
}

/** All waiting messages as one: one more turn, not a race of several. */
export function mergeQueuedSends(queue: readonly QueuedSend[]): { text: string; files?: File[]; filePaths?: string[] } {
  const files = queue.flatMap(item => item.files ?? [])
  const filePaths = [...new Set(queue.flatMap(item => item.filePaths ?? []))]
  return {
    text: queue.map(item => item.text).join('\n\n'),
    files: files.length ? files : undefined,
    filePaths: filePaths.length ? filePaths : undefined,
  }
}

/** The input after waiting texts go back into it (after a stop or an error, or 取り消す). */
export function draftWith(draft: string, texts: readonly string[]): string {
  return [draft, ...texts].filter(text => text.trim()).join('\n\n')
}
