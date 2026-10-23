import type { ChatSessionSummary } from '../../shared/chat-history'
import { normalizeSearchText } from '../../shared/chat-history-summary'

export interface ConversationTab { id: string; title: string; sessionId: string | null }

/**
 * Rows of the conversation list. Sessions are summaries (no message bodies);
 * a search over message bodies runs in the main process
 * (`searchChatSessions`) and arrives as `contentMatches`. Titles and drafts
 * are matched here, so a blank tab or a just-renamed one is found at once.
 */
export function buildConversationRows(sessions: ChatSessionSummary[], tabs: ConversationTab[], query: string, contentMatches?: ReadonlySet<string>) {
    const byId = new Map(sessions.map(s => [s.id, s]))
    const openIds = new Set(tabs.map(t => t.sessionId))
    const open = tabs.map(tab => ({ key: tab.id, tab, session: byId.get(tab.sessionId ?? ''), title: byId.get(tab.sessionId ?? '')?.title ?? tab.title }))
    const past = sessions.filter(s => !openIds.has(s.id)).map(session => ({ key: session.id, tab: undefined, session, title: session.title }))
    const needle = normalizeSearchText(query.trim())
    return [...open, ...past].filter(row => !needle || (row.session && contentMatches?.has(row.session.id)) ||
      [row.title, row.session?.draftInput ?? ''].some(text => normalizeSearchText(text).includes(needle)))
      .sort((a, b) => Number(!!b.tab) - Number(!!a.tab) || Number(!!b.session?.pinned) - Number(!!a.session?.pinned) ||
        (b.session?.updatedAt ?? '').localeCompare(a.session?.updatedAt ?? ''))
}

// Search runs over all sessions before pagination. Open and pinned chats always
// remain visible; the limit only controls ordinary history rows in the sidebar.
export function paginateConversationRows(rows: ReturnType<typeof buildConversationRows>, historyLimit: number) {
  let historyCount = 0
  const visibleRows = rows.filter(row => row.tab || row.session?.pinned || ++historyCount <= historyLimit)
  return { visibleRows, remaining: Math.max(0, historyCount - historyLimit) }
}
