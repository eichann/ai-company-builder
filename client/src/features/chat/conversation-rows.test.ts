import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConversationRows, focusConversationRows, markMatches, paginateConversationRows, paletteConsultations } from './conversationRows'
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
test('narrowed to the record open in the middle: only consultations whose topic is that record itself, and the one on screen', () => {
  const sessions = [session('deal', { topicRecordId: 'deal-01', updatedAt: '2026-01-03' }), session('task-of-deal', { topicRecordId: 'task-01' }), session('plain'), session('shown', { updatedAt: '2026-01-02' })]
  const rows = buildConversationRows(sessions, [{ id: 'tab-shown', title: 'shown', sessionId: 'shown' }], '')
  assert.deepEqual(focusConversationRows(rows, 'deal-01', 'tab-shown').map(r => r.session?.id).sort(), ['deal', 'shown'])
  assert.deepEqual(focusConversationRows(rows, 'deal-01', 'other-tab').map(r => r.session?.id), ['deal'])
})
test('探す ⌘K lists the consultations the list keeps (blank leftovers never), pinned first, then newest', () => {
  const sessions = [
    session('old', { sent: true, updatedAt: '2026-01-01' }), session('new', { sent: true, updatedAt: '2026-01-03' }),
    session('pin', { sent: true, pinned: true, updatedAt: '2025-12-01' }), session('blank', { sent: false, updatedAt: '2026-01-04' }),
    session('draft', { sent: false, draftInput: '下書き', updatedAt: '2026-01-02' }),
  ]
  assert.deepEqual(paletteConsultations(sessions).map(c => c.id), ['pin', 'new', 'draft', 'old'])
})

const look = (id: string, title: string, thing: 'task' | 'bundle') => ({ id, title, thing, typeLabel: thing === 'bundle' ? '案件' : null, kindName: thing === 'bundle' ? '案件' : 'やること' })
test('search finds a consultation by the title of its やること, else its 案件, never by a record the member cannot read', () => {
  const topics = new Map([
    ['task-0000aa', { own: look('task-0000aa', '見積書を作り直す', 'task'), bundle: look('deal-0000bb', '株式会社サンプル', 'bundle') }],
    ['deal-0000bb', { own: null, bundle: look('deal-0000bb', '株式会社サンプル', 'bundle') }],
    ['task-0000cc', null],
  ])
  const sessions = [
    session('about-task', { title: '値引きなしで収める案', topicRecordId: 'task-0000aa', updatedAt: '2026-01-03' }),
    session('about-deal', { title: '定例で聞くこと', topicRecordId: 'deal-0000bb', updatedAt: '2026-01-02' }),
    session('hidden', { title: '別の相談', topicRecordId: 'task-0000cc', updatedAt: '2026-01-01' }),
    session('plain', { title: '見積書の書き方', updatedAt: '2025-12-01' }),
  ]
  const search = (query: string) => buildConversationRows(sessions, [], query, undefined, topics).map(r => r.session?.id)
  assert.deepEqual(search('見積書'), ['about-task', 'plain'])
  // A task consultation is not found by its task's 案件; a 案件 consultation is.
  assert.deepEqual(search('サンプル'), ['about-deal'])
  assert.deepEqual(search('別の'), ['hidden'])
  const rows = buildConversationRows(sessions, [], '', undefined, topics)
  assert.deepEqual(rows.map(r => r.linked?.id ?? null), ['task-0000aa', 'deal-0000bb', null, null])
  // Before the server answers nothing is linked, and the list is the same.
  const before = buildConversationRows(sessions, [], '')
  assert.deepEqual(before.map(r => r.session?.id), rows.map(r => r.session?.id))
  assert.ok(before.every(r => r.linked === null))
})

test('the matched part is marked the way the search matches it (width and case folded)', () => {
  const marked = (text: string, query: string) => markMatches(text, query).map(p => (p.hit ? `[${p.text}]` : p.text)).join('')
  assert.equal(marked('見積書を作り直す', '見積'), '[見積]書を作り直す')
  assert.equal(marked('ＭＴＧの準備とmtg', 'mtg'), '[ＭＴＧ]の準備と[mtg]')
  assert.equal(marked('㍻の資料', '平'), '[㍻]の資料')
  assert.equal(marked('見積書', 'なし'), '見積書')
  assert.equal(marked('見積書', '  '), '見積書')
})
