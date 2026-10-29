import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UIMessage } from 'ai'
import { deriveConsultationStatus, groupConversationRows, runningSubagentId, shortPath, toolActivity, type ConsultationStatus } from '../src/lib/consultationStatus'
import { buildConversationRows, isEmptyConversation } from '../src/lib/conversationRows'
import type { ChatSessionSummary } from '../shared/chat-history'

const ROOT = '/Users/demo/会社'
const assistant = (parts: unknown[]): UIMessage => ({ id: 'a', role: 'assistant', parts: parts as UIMessage['parts'] })
const tool = (name: string, state: string, input: unknown, toolCallId = `call-${name}`) => ({ type: 'dynamic-tool', toolName: name, toolCallId, state, input })
const derive = (extra: Partial<Parameters<typeof deriveConsultationStatus>[0]>) => deriveConsultationStatus({ status: 'ready', unseen: false, rootPath: ROOT, ...extra })

test('working: the running tool call in plain Japanese, paths relative to the company folder', () => {
  const read = derive({ status: 'streaming', lastMessage: assistant([tool('Read', 'input-available', { file_path: `${ROOT}/営業部/提案書/A社.md` })]) })
  assert.deepEqual(read, { state: 'working', line: 'ファイルを読んでいます：営業部/提案書/A社.md' })
  assert.equal(toolActivity('Edit', { file_path: `${ROOT}/総務/備品.md` }, ROOT), 'ファイルを書いています：総務/備品.md')
  assert.equal(toolActivity('Bash', { command: 'rm -rf secret' }), 'コマンドを実行しています', 'never the command text')
  assert.equal(toolActivity('mcp__acb_web__web_research', { question: 'q', urls: ['https://example.com/a'] }), 'Webで調べています：example.com')
  assert.equal(toolActivity('Write', JSON.stringify({ type: 'fileChange' })), 'ファイルを書いています', 'Codex items arrive as JSON strings')
  assert.equal(toolActivity('Agent', { description: '部署ごとの集計' }), '手分けして作業しています：部署ごとの集計')
  assert.equal(shortPath('/elsewhere/a/b/c.md'), 'b/c.md')
})

test('working without a running tool: thinking, or writing the reply; a subagent progress line wins', () => {
  assert.equal(derive({ status: 'submitted' }).line, '考えています')
  assert.equal(derive({ status: 'streaming', lastMessage: assistant([tool('Read', 'output-available', {}), { type: 'text', text: 'はい', state: 'streaming' }]) }).line, '返事を書いています')
  assert.equal(derive({ status: 'streaming', lastMessage: assistant([tool('Read', 'output-available', {})]) }).line, '考えています')
  const message = assistant([tool('Agent', 'input-available', { description: 'x' }, 'sub-1'), tool('Read', 'input-available', { file_path: 'a' }, 'inner')])
  assert.equal(runningSubagentId(message), 'sub-1')
  assert.equal(derive({ status: 'streaming', lastMessage: message, progressLine: '3件目を集計しています' }).line, '3件目を集計しています')
})

test('the member\'s turn comes before anything else: a permission or a question', () => {
  const approval = { toolName: 'Write', toolInput: { file_path: `${ROOT}/営業部/一覧.csv` } }
  assert.deepEqual(derive({ status: 'streaming', approval }), { state: 'needs-you', kind: 'approve', line: '許可を待っています：営業部/一覧.csv' })
  const choices = { kind: 'choices' as const, agent: 'claude-code' as const, questions: [{ question: '形式はどれにしますか？', header: '形式', options: [], multiSelect: false }] }
  assert.deepEqual(derive({ status: 'streaming', approval, interaction: choices }), { state: 'needs-you', kind: 'question', line: '形式はどれにしますか？' })
  const permissions = { kind: 'permissions' as const, reason: 'ネットワーク', cwd: ROOT, entries: [{ label: 'example.com への接続', access: 'network' }], network: true, supported: true }
  assert.deepEqual(derive({ interaction: permissions }), { state: 'needs-you', kind: 'approve', line: '許可を待っています：example.com への接続' })
})

test('after a turn: failed, unseen (finished while away) or idle', () => {
  assert.equal(derive({ status: 'error' }).state, 'failed')
  assert.deepEqual(derive({ unseen: true }), { state: 'unseen', line: '返事が届いています' })
  assert.deepEqual(derive({}), { state: 'idle', line: '' })
})

const session = (id: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary => ({ id, companyId: 'c', title: id, messageCount: 3, preview: '', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra })

test('groups: あなたの番 › ピン留め › 止まっています › 作業中 › 開いている相談 (unread first) › 終わったもの; pinned keeps its place unless it is the member\'s turn', () => {
  const sessions = [session('ask', { pinned: true }), session('pin', { pinned: true }), session('result'), session('broken'), session('busy'), session('idle'), session('old')]
  const tabs = ['ask', 'pin', 'result', 'broken', 'busy', 'idle'].map(id => ({ id: `tab-${id}`, title: id, sessionId: id }))
  const status: Record<string, ConsultationStatus> = {
    'tab-ask': { state: 'needs-you', kind: 'question', line: '?' },
    'tab-pin': { state: 'working', line: '考えています' },
    'tab-result': { state: 'unseen', line: '' },
    'tab-broken': { state: 'failed', line: '' },
    'tab-busy': { state: 'working', line: '' },
    'tab-idle': { state: 'idle', line: '' },
  }
  const groups = groupConversationRows(buildConversationRows(sessions, tabs, ''), id => status[id])
  assert.deepEqual(groups.map(g => [g.label, g.rows.map(r => r.key)]), [
    ['あなたの番', ['tab-ask']],
    ['ピン留め', ['tab-pin']],
    ['止まっています', ['tab-broken']],
    ['AIが作業中', ['tab-busy']],
    ['開いている相談', ['tab-result', 'tab-idle']],
    ['終わったもの', ['old']],
  ])
})

test('new and read conversations stay 開いている相談 until closed; an empty closed one leaves no history row', () => {
  const sessions = [session('draft', { messageCount: 1, sent: false, draftInput: '見積の' }), session('empty', { messageCount: 1, sent: false }), session('sent', { sent: true })]
  const tabs = [{ id: 'tab-blank', title: '新しい会話', sessionId: null }, { id: 'tab-draft', title: 'draft', sessionId: 'draft' }]
  const groups = groupConversationRows(buildConversationRows(sessions, tabs, ''), () => undefined)
  assert.deepEqual(groups.map(g => [g.label, g.rows.map(r => r.key)]), [
    ['開いている相談', ['tab-blank', 'tab-draft']],
    ['終わったもの', ['sent']],
  ])
  assert.equal(isEmptyConversation(undefined), true)
  assert.equal(isEmptyConversation(sessions[0]), false)
  assert.equal(isEmptyConversation(sessions[1]), true)
  assert.equal(isEmptyConversation(sessions[2]), false)
})
