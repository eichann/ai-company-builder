import type { ChatSession } from '../../shared/chat-history'

export interface ConversationTab { id: string; title: string; sessionId: string | null }

export function buildConversationRows(sessions: ChatSession[], tabs: ConversationTab[], query: string) {
    const byId = new Map(sessions.map(s => [s.id, s]))
    const openIds = new Set(tabs.map(t => t.sessionId))
    const open = tabs.map(tab => ({ key: tab.id, tab, session: byId.get(tab.sessionId ?? ''), title: byId.get(tab.sessionId ?? '')?.title ?? tab.title }))
    const past = sessions.filter(s => !openIds.has(s.id)).map(session => ({ key: session.id, tab: undefined, session, title: session.title }))
    const needle = query.trim().normalize('NFKC').toLocaleLowerCase()
    return [...open, ...past].filter(row => !needle || [row.title, row.session?.draftInput ?? '', ...(row.session?.messages.map(m => m.content) ?? [])]
      .some(text => text.normalize('NFKC').toLocaleLowerCase().includes(needle)))
      .sort((a, b) => Number(!!b.tab) - Number(!!a.tab) || Number(!!b.session?.pinned) - Number(!!a.session?.pinned) ||
        (b.session?.updatedAt ?? '').localeCompare(a.session?.updatedAt ?? ''))
}
