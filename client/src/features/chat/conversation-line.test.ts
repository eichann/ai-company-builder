// The consultation list's second line is accurate (owner 2026-11-23): an invitation to start is
// shown only for a consultation the member has not written in yet, never for one already had.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationLine } from './conversationRows'
import { sessionPreview } from '../../../shared/chat-history-summary'
import type { ChatSessionSummary } from '../../../shared/chat-history'

const session = (id: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary =>
  ({ id, companyId: 'company', title: id, messageCount: 0, preview: '', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra })

test('nothing sent yet: 「（まだ何も書いていません）」; a draft is shown as the draft', () => {
  assert.equal(conversationLine(undefined), '（まだ何も書いていません）')
  assert.equal(conversationLine(session('blank', { sent: false })), '（まだ何も書いていません）')
  assert.equal(conversationLine(session('draft', { sent: false, draftInput: ' 見積の\n件 ' })), '下書き：見積の 件')
})

test('a consultation already had shows its last words, or no line at all when it has none to show', () => {
  assert.equal(conversationLine(session('had', { sent: true, messageCount: 3, preview: 'A社の見積を作りました。[Tool: Write]' })), 'A社の見積を作りました。')
  // Started by the app (a task's consultation), or only tool work so far.
  assert.equal(conversationLine(session('started', { sent: true, messageCount: 2, preview: '' })), undefined)
  assert.equal(conversationLine(session('older', { messageCount: 2, preview: '' })), undefined, 'a summary without `sent` counts as sent')
})

test('the preview skips a reply that was only tool work and takes the words before it', () => {
  const at = '2026-11-23T00:00:00.000Z'
  const messages = [
    { id: 'u1', role: 'user' as const, content: '先月の売上をまとめて', timestamp: at },
    { id: 'a1', role: 'assistant' as const, content: '\n[Tool: Read]\n[Tool: Grep]', timestamp: at },
  ]
  assert.equal(sessionPreview({ messages }), '先月の売上をまとめて')
})
