import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConversationRows, paginateConversationRows } from './conversationRows'
import type { ChatSessionSummary } from '../../../shared/chat-history'
const session = (id: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary => ({ id, companyId: 'company', title: id, messageCount: 0, preview: '', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra })
test('open conversations appear once, ahead of pinned and closed history', () => {
  const sessions = [session('open'), session('pinned', { pinned: true }), session('closed')]
  const rows = buildConversationRows(sessions, [{ id: 'tab', title: 'old title', sessionId: 'open' }], '')
  assert.deepEqual(rows.map(row => row.session?.id), ['open', 'pinned', 'closed'])
  assert.equal(rows[0].title, 'open')
})
test('search finds a conversation by its title or unsent draft before the body search answers, and adds body matches when they arrive', () => {
  const sessions = [session('body'), session('draft', { draftInput: '未送信のＡＰＩ計画' }), session('name', { title: '月次レポート' })]
  const search = (query: string, contentMatches?: ReadonlySet<string>) => buildConversationRows(sessions, [], query, contentMatches).map(r => r.session?.id)
  assert.deepEqual(search(' api '), ['draft'])
  assert.deepEqual(search('月次'), ['name'])
  assert.deepEqual(search('api', new Set(['body'])).sort(), ['body', 'draft'])
  assert.deepEqual(search('該当なし', new Set()), [])
})
test('blank tabs remain accessible and a closed tab returns to history without losing data', () => {
  const sessions = [session('saved')]
  assert.equal(buildConversationRows(sessions, [{ id: 'blank', title: '新しい相談', sessionId: null }], '').length, 2)
  const rows = buildConversationRows(sessions, [], '')
  assert.equal(rows[0].tab, undefined)
  assert.equal(rows[0].session?.id, 'saved')
})

test('history expands by page while open/pinned rows stay visible and search covers hidden history', () => {
  const sessions = [session('open'), session('pinned', {pinned:true}), ...Array.from({length:45}, (_,i)=>session(`history-${i}`))]
  const tabs = [{id:'tab',title:'open',sessionId:'open'}]
  const rows = buildConversationRows(sessions,tabs,'')
  const first = paginateConversationRows(rows,20)
  assert.equal(first.visibleRows.length,22)
  assert.equal(first.remaining,25)
  assert.deepEqual(first.visibleRows.slice(0,2).map(r=>r.session?.id),['open','pinned'])
  assert.equal(paginateConversationRows(rows,40).remaining,5)
  assert.equal(paginateConversationRows(rows,60).visibleRows.length,47)
  assert.equal(paginateConversationRows(rows,60).remaining,0)
  const searched = paginateConversationRows(buildConversationRows(sessions,tabs,'history-44'),20)
  assert.equal(searched.visibleRows[0].session?.id,'history-44')
  assert.equal(searched.remaining,0)
})
