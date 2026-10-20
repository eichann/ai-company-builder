import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConversationRows } from '../src/lib/conversationRows'
import type { ChatSession } from '../shared/chat-history'
const session = (id: string, extra: Partial<ChatSession> = {}): ChatSession => ({ id, companyId: 'company', title: id, messages: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra })
test('open conversations appear once, ahead of pinned and closed history', () => {
  const sessions = [session('open'), session('pinned', { pinned: true }), session('closed')]
  const rows = buildConversationRows(sessions, [{ id: 'tab', title: 'old title', sessionId: 'open' }], '')
  assert.deepEqual(rows.map(row => row.session?.id), ['open', 'pinned', 'closed'])
  assert.equal(rows[0].title, 'open')
})
test('search includes old message contents and unsent drafts with width and case normalization', () => {
  const sessions = [session('body', { messages: [{ id: 'msg', role: 'user', content: 'ＡＰＩの接続', timestamp: '2026-01-01' }] }), session('draft', { draftInput: '未送信の計画' }), session('name', { title: '月次レポート' })]
  assert.deepEqual(buildConversationRows(sessions, [], ' api ').map(r => r.session?.id), ['body'])
  assert.deepEqual(buildConversationRows(sessions, [], '未送信').map(r => r.session?.id), ['draft'])
  assert.deepEqual(buildConversationRows(sessions, [], '月次').map(r => r.session?.id), ['name'])
  assert.equal(buildConversationRows(sessions, [], '該当なし').length, 0)
})
test('blank tabs remain accessible and a closed tab returns to history without losing data', () => {
  const sessions = [session('saved')]
  assert.equal(buildConversationRows(sessions, [{ id: 'blank', title: '新しい相談', sessionId: null }], '').length, 2)
  const rows = buildConversationRows(sessions, [], '')
  assert.equal(rows[0].tab, undefined)
  assert.equal(rows[0].session?.id, 'saved')
})
