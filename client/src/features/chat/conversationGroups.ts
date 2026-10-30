import { CONVERSATION_GROUPS, type ConversationGroupKey } from '../../lib/consultationStatus'

// Which groups of the 「AIへの相談」 list the member folded, remembered per company
// in localStorage. A convenience only: anything unreadable means "all open".

export const COLLAPSED_GROUPS_KEY_PREFIX = 'chatCollapsedGroups:'

/** 「あなたの番」 never folds: the AI is waiting for the member there. */
export function canCollapse(key: ConversationGroupKey): boolean {
  return key !== 'needs-you'
}

/** The stored value, keeping only groups that exist and may fold; anything else → none folded. */
export function parseCollapsedGroups(raw: string | null): ReadonlySet<ConversationGroupKey> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(value)) return new Set()
    const known = new Set<string>(CONVERSATION_GROUPS.map(group => group.key))
    return new Set(value.filter((key): key is ConversationGroupKey => typeof key === 'string' && known.has(key) && canCollapse(key as ConversationGroupKey)))
  } catch {
    return new Set()
  }
}

/** Folded groups as shown: while searching every group is open, so a match is never hidden. */
export function shownCollapsedGroups(collapsed: ReadonlySet<ConversationGroupKey>, query: string): ReadonlySet<ConversationGroupKey> {
  return query.trim() ? new Set() : collapsed
}
