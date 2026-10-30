import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatSessionSummary } from '../../../shared/chat-history'
import type { ChatWindowStatus } from '../../../shared/chat-windows'
import { buildConversationRows } from '../../lib/conversationRows'
import { groupConversationRows, type ConsultationStatus } from '../../lib/consultationStatus'
import { canMoveToWindow, statusOfTab, windowTabs } from './chatWindows'

const summary = (id: string, title: string): ChatSessionSummary => ({
  id, companyId: 'acme', title, messageCount: 2, sent: true, preview: '…', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T01:00:00Z',
} as ChatSessionSummary)

function groupsWith(windows: Map<string, ChatWindowStatus>) {
  const sessions = [summary('here', 'ここの相談'), summary('there', '別ウィンドウの相談'), summary('old', '終わった相談')]
  const tabs = [{ id: 'tab-1', title: 'ここの相談', sessionId: 'here' }]
  const local = new Map<string, ConsultationStatus>([['tab-1', { state: 'idle', line: '' }]])
  const rows = buildConversationRows(sessions, [...tabs, ...windowTabs(windows, tabs)], '')
  return Object.fromEntries(groupConversationRows(rows, id => statusOfTab(id, local, windows)).map(g => [g.key, g.rows.map(r => r.session?.id)]))
}

test('a consultation in another window counts in the main list with that window\'s status (あなたの番 / AIが作業中), never as 終わったもの', () => {
  assert.deepEqual(groupsWith(new Map([['there', { state: 'needs-you', kind: 'question', line: '選んでください' }]])),
    { 'needs-you': ['there'], open: ['here'], done: ['old'] })
  assert.deepEqual(groupsWith(new Map([['there', { state: 'working', line: '調べています' }]])),
    { working: ['there'], open: ['here'], done: ['old'] })
  assert.deepEqual(groupsWith(new Map([['there', { state: 'idle', line: '' }]])),
    { open: ['here', 'there'], done: ['old'] })
})

test('a consultation never moves to its own window while its AI works or waits for an answer (the turn would stop)', () => {
  assert.equal(canMoveToWindow({ state: 'working', line: '' }), false)
  assert.equal(canMoveToWindow({ state: 'needs-you', kind: 'approve', line: '' }), false)
  assert.equal(canMoveToWindow({ state: 'needs-you', kind: 'question', line: '' }), false)
  assert.equal(canMoveToWindow({ state: 'needs-you', kind: 'review', line: '' }), true)
  assert.equal(canMoveToWindow({ state: 'unseen', line: '' }), true)
  assert.equal(canMoveToWindow(undefined), true)
})
