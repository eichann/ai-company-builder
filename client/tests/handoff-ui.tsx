import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatSidebar } from '../src/components/chat/ChatSidebar'
import { HandoffControl } from '../src/components/chat/HandoffControl'
import '../src/index.css'
import type { ChatSession } from '../shared/chat-history'
import type { HandoffView } from '../shared/handoff'
const companyId = 'ui-fixture'
const sessions: ChatSession[] = [{ companyId, id: 'example', title: '予約フォームの引き継ぎ', messages: [{ id: 'u1', role: 'user', content: '既存のJSON保存を維持して、公開前には私に確認してください。', timestamp: '2026-10-20' }], draftInput: 'テストログを確認したら…', createdAt: '2026-10-20', updatedAt: '2026-10-20' }]
const historyListeners = new Set<(scope: { companyId: string; deletedSessionId?: string }) => void>()
const memoListeners = new Set<(scope: { companyId: string; sessionId: string }) => void>()
const markdown = '## 目的\n- デスクトップ版の予約フォームを作成。\n\n## 決定事項・制約\n- JSON保存を維持する。配布に影響を出さないため。\n- 公開前の確認者はユーザー。\n\n## 現在の状態\n- AI報告・未検証：試作品を作成。\n\n## 未解決事項\n- テストログの確認。\n\n## 次に行うこと\n1. ログを確認する。\n2. ユーザーに画面を見せる。\n\n## 参照先\n- なし'
let view: HandoffView = { status: 'saved', markdown, updatedAt: '2026-10-20T10:00:00Z', provider: 'codex', message: 'メモを保存しています。自動復旧への接続は次の段階です。', canUpdate: true, pendingTurns: 1, metrics: { totalMs: 7400, inputTokens: 6500, outputTokens: 630 } }
Object.assign(window, { electronAPI: {
  getChatSessions: async () => [...sessions],
  getHandoff: async () => ({ ...view }),
  updateHandoff: async () => { view = { ...view, status: 'queued', message: '会話が落ち着いてから更新します。', canUpdate: false }; for (const fn of memoListeners) fn({ companyId, sessionId: 'example' }) },
  patchChatSession: async (_company: string, id: string, changes: object) => { Object.assign(sessions.find(s => s.id === id)!, changes); for (const fn of historyListeners) fn({ companyId }) },
  deleteChatSession: async (_company: string, id: string) => { sessions.splice(sessions.findIndex(s => s.id === id), 1); for (const fn of historyListeners) fn({ companyId, deletedSessionId: id }) },
  onChatHistoryChanged: (fn: (scope: { companyId: string }) => void) => { historyListeners.add(fn); return () => historyListeners.delete(fn) },
  onHandoffChanged: (fn: (scope: { companyId: string; sessionId: string }) => void) => { memoListeners.add(fn); return () => memoListeners.delete(fn) },
} })
export function Preview() {
  const [tab, setTab] = useState(true)
  return <main className="h-screen bg-white text-gray-900"><div className="px-4 py-2 text-xs bg-amber-50 text-amber-900">表示確認用の人工データです。本番の履歴やAIには接続しません。</div><div className="flex h-[calc(100%-32px)]">
    <ChatSidebar companyId={companyId} tabs={tab ? [{ id: 'tab', title: '予約フォーム', sessionId: 'example' }] : []} activeTabId="tab" onSelectTab={() => {}} onOpenSession={() => setTab(true)} onCloseTab={() => setTab(false)} onNew={() => {}} onHide={() => {}} />
    <section className="flex-1"><header className="border-b px-4 py-3 text-sm font-medium">相談 · Codex</header><HandoffControl companyId={companyId} sessionId="example" /><p className="p-8 text-sm">予約フォームの相談を続けます。<br /><br />メモの閲覧、更新待ち、相談を閉じた後のメモ保持を操作できます。</p></section>
  </div></main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
