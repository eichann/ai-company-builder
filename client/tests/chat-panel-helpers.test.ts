// Pure parts of the chat panel, taken out of ChatPanel.tsx in R6: message ↔
// history conversion, the /api/chat body, the remembered tabs, and the rules
// for messages sent while the AI works. Their behaviour is the one ChatPanel
// had; these tests pin it so the hooks built on them can move freely.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UIMessage } from 'ai'
import {
  greetingMessages, messageText, sessionMessageFor, sessionMessageToUIMessage, titleTranscript, uiMessageToSessionMessage,
} from '../src/features/chat/chatSessionMessages'
import { buildChatRequestBody, type ChatRequestSources } from '../src/features/chat/chatRequestBody'
import { persistedChatTabs, restoreChatTabs, safeReadChatTabs, safeWriteChatTabs, CHAT_TABS_KEY_PREFIX } from '../src/features/chat/chatTabsStorage'
import { draftWith, mergeQueuedSends, steerPartId, unreadSteerParts, withoutSteerParts } from '../src/features/chat/queuedSends'
import { STEER_PART_TYPE } from '../shared/steer'
import { CHOICE_PART_TYPE } from '../shared/choice-prompt'
import { agentInputMessages } from '../electron/agents/session'

const T = new Date('2026-10-24T01:02:03.000Z')

test('a reply becomes one history message: text, thinking, tool markers, choice and steer positions', () => {
  const msg = {
    id: 'a1', role: 'assistant', parts: [
      { type: 'reasoning', text: '考え中' },
      { type: 'text', text: '確認します。' },
      { type: 'dynamic-tool', toolName: 'Read', toolCallId: 'r1', state: 'output-available', input: {}, output: 'ok' },
      { type: STEER_PART_TYPE, id: 'steer-s1', data: { id: 's1', text: '10月版で' } },
      { type: 'text', text: '続けます。' },
      { type: CHOICE_PART_TYPE, id: 'choice-c1', data: { id: 'c1', questions: [{ question: 'Q?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }], answers: [{ selected: ['A'] }] } },
      { type: 'text', text: '完了。' },
    ],
  } as unknown as UIMessage
  const stored = uiMessageToSessionMessage(msg, T)
  assert.equal(stored.content, '確認します。\n[Tool: Read]続けます。完了。')
  assert.equal(stored.thinking, '考え中')
  assert.equal(stored.timestamp, T.toISOString())
  assert.equal(stored.steerInstructions?.[0].at, '確認します。\n[Tool: Read]'.length)
  assert.equal(stored.choicePrompts?.[0].at, '確認します。\n[Tool: Read]続けます。'.length)
  // And back: the instruction and the answered prompt return where they were.
  const restored = sessionMessageToUIMessage(stored)
  assert.deepEqual(restored.parts.map(p => p.type), ['reasoning', 'text', STEER_PART_TYPE, 'text', CHOICE_PART_TYPE, 'text'])
})

test('a question and an instruction at the same offset come back in the order they happened (old history keeps its order)', () => {
  const steer = { type: STEER_PART_TYPE, id: 'steer-s1', data: { id: 's1', text: '10月版で' } }
  const choice = { type: CHOICE_PART_TYPE, id: 'choice-c1', data: { id: 'c1', questions: [{ question: 'Q?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }], answers: [{ selected: ['A'] }] } }
  const live = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '確認します。' }, steer, choice, { type: 'text', text: '完了。' }] } as unknown as UIMessage
  // Through a history file (JSON), as when a conversation is reopened.
  const stored = JSON.parse(JSON.stringify(uiMessageToSessionMessage(live, T))) as ReturnType<typeof uiMessageToSessionMessage>
  assert.equal(stored.steerInstructions?.[0].at, stored.choicePrompts?.[0].at)
  const order = (m: UIMessage) => m.parts.map(p => (p as { id?: string }).id ?? p.type)
  const restored = sessionMessageToUIMessage(stored)
  assert.deepEqual(order(restored), ['text', 'steer-s1', 'choice-c1', 'text'])
  // Another agent reads the restored conversation in the same order as the live one.
  const texts = (m: UIMessage) => agentInputMessages([m])[0].parts.map(p => (p as { text: string }).text)
  assert.deepEqual(texts(restored), texts(live))
  // Saved again unchanged (fingerprints stay stable).
  assert.equal(JSON.stringify(uiMessageToSessionMessage(restored, T)), JSON.stringify(stored))

  // Records written before `seq` existed: the order they were stored in, as before.
  const withoutSeq = <T extends { seq?: number }>(records: T[] | undefined) => records?.map(r => { const copy = { ...r }; delete copy.seq; return copy })
  const old = { ...stored, choicePrompts: withoutSeq(stored.choicePrompts), steerInstructions: withoutSeq(stored.steerInstructions) }
  assert.deepEqual(order(sessionMessageToUIMessage(old)), ['text', 'choice-c1', 'steer-s1', 'text'])
})

test('sessionMessageFor reuses the conversion for the same message object, timestamp and attachments', () => {
  const msg: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }
  const images = ['data:image/png;base64,AAA']
  const first = sessionMessageFor(msg, T, images)
  assert.equal(sessionMessageFor(msg, T, images), first)
  assert.notEqual(sessionMessageFor(msg, new Date(T.getTime() + 1), images), first)
  assert.notEqual(sessionMessageFor(msg, T, [...images]), first)
  assert.deepEqual(sessionMessageFor(msg, T, images, ['営業部/a.md']).referenceFiles, ['営業部/a.md'])
  assert.equal(first.images, images)
})

test('title transcript: greeting skipped, next six messages, empty ones dropped; greeting shape', () => {
  const greeting = greetingMessages('こんにちは')
  assert.deepEqual(greeting, [{ id: '1', role: 'assistant', parts: [{ type: 'text', text: 'こんにちは' }] }])
  const messages: UIMessage[] = [...greeting]
  for (let i = 0; i < 8; i++) messages.push({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: i === 2 ? '  ' : `t${i}` }] })
  assert.deepEqual(titleTranscript(messages), [
    { role: 'user', content: 't0' }, { role: 'assistant', content: 't1' }, { role: 'assistant', content: 't3' },
    { role: 'user', content: 't4' }, { role: 'assistant', content: 't5' },
  ])
  assert.equal(messageText({ id: 'x', role: 'assistant', parts: [{ type: 'reasoning', text: 'no' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab')
})

function sources(overrides: Partial<{ [K in keyof ChatRequestSources]: ChatRequestSources[K] }> = {}): ChatRequestSources {
  return {
    authMode: { current: 'claude-code' },
    agentSession: { current: undefined },
    workingDirectory: { current: '/c/営業部' },
    companyId: { current: 'co' },
    companyRootPath: { current: '/c' },
    activeDepartment: { current: { name: '営業部', folder: '営業部' } },
    modelId: { current: 'opus-5-5' },
    effort: { current: 'medium' },
    promptSuggestions: () => true,
    appSessionId: { current: 'app-1' },
    claudeSessionId: { current: null },
    pendingImages: { current: [] },
    pendingFilePaths: { current: [] },
    handoffRequest: { current: null },
    ...overrides,
  }
}

test('chat request body: pending attachments go with one send only, and the hand-off receipt is recorded', () => {
  const s = sources({ claudeSessionId: { current: 'cli-1' }, pendingImages: { current: [{ mediaType: 'image/png', data: 'AAA' }] }, pendingFilePaths: { current: ['営業部/a.md'] } })
  const body = buildChatRequestBody(s)
  assert.deepEqual(body.images, [{ mediaType: 'image/png', data: 'AAA' }])
  assert.deepEqual(body.referenceFiles, ['営業部/a.md'])
  assert.deepEqual(s.handoffRequest.current, { companyId: 'co', sessionId: 'app-1', provider: 'claude-code' })
  const next = buildChatRequestBody(s)
  assert.equal(next.images, undefined)
  assert.equal(next.referenceFiles, undefined)
})

test('chat request body: creates the app session id when missing; no company → no hand-off receipt; no department → undefined', () => {
  const s = sources({ appSessionId: { current: null }, companyId: { current: undefined }, activeDepartment: { current: undefined }, promptSuggestions: () => false })
  const body = buildChatRequestBody(s)
  assert.match(body.appSessionId!, /^[0-9a-f-]{36}$/)
  assert.equal(s.appSessionId.current, body.appSessionId)
  assert.equal(s.handoffRequest.current, null)
  assert.equal(body.activeDepartment, undefined)
  assert.equal(body.promptSuggestions, false)
  assert.equal('claudeSessionId' in body, false)
})

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, data }
}

test('remembered tabs: duplicates of a conversation dropped, active tab follows its conversation, junk ignored', () => {
  const key = `${CHAT_TABS_KEY_PREFIX}co`
  const storage = memoryStorage({ [key]: JSON.stringify({ tabs: [{ title: 'A', sessionId: 's1' }, { title: 'A again', sessionId: 's1' }, { title: 7, sessionId: null }, null, { title: 'B', sessionId: 's2' }], activeIndex: 3 }) })
  assert.deepEqual(safeReadChatTabs('co', storage), { tabs: [{ title: 'A', sessionId: 's1' }, { title: '', sessionId: null }, { title: 'B', sessionId: 's2' }], activeIndex: 2 })
  assert.equal(safeReadChatTabs('co', memoryStorage({ [key]: '{bad' })), null)
  assert.equal(safeReadChatTabs('co', memoryStorage({ [key]: JSON.stringify({ tabs: [] }) })), null)
  assert.equal(safeReadChatTabs('other', storage), null)
  // An out-of-range index opens the first tab.
  assert.equal(safeReadChatTabs('co', memoryStorage({ [key]: JSON.stringify({ tabs: [{ title: 'A', sessionId: null }], activeIndex: 3 }) }))?.activeIndex, 0)
  // Writes never throw.
  safeWriteChatTabs('co', { tabs: [], activeIndex: 0 }, { setItem: () => { throw new Error('quota') } })
})

test('restoring tabs: remembered ones get fresh ids and the new-chat title when untitled; nothing remembered → one new chat', () => {
  const restored = restoreChatTabs({ tabs: [{ title: '', sessionId: 's1' }, { title: 'B', sessionId: null }], activeIndex: 1 }, '新しい会話')
  assert.deepEqual(restored.tabs.map(t => [t.title, t.sessionId]), [['新しい会話', 's1'], ['B', null]])
  assert.equal(restored.activeTabId, restored.tabs[1].id)
  const fresh = restoreChatTabs(null, '新しい会話')
  assert.equal(fresh.tabs.length, 1)
  assert.equal(fresh.activeTabId, fresh.tabs[0].id)
  assert.deepEqual(persistedChatTabs(restored.tabs, restored.tabs[1].id), { tabs: [{ title: '新しい会話', sessionId: 's1' }, { title: 'B', sessionId: null }], activeIndex: 1 })
  assert.equal(persistedChatTabs(restored.tabs, 'gone').activeIndex, 0)
})

test('waiting messages: merged into one send (texts joined, files kept, paths de-duplicated); unread steer bubbles removed', () => {
  const file = { name: 'a.png' } as File
  assert.deepEqual(mergeQueuedSends([{ text: '一つ目', filePaths: ['a.md'] }, { text: '二つ目', files: [file], filePaths: ['a.md', 'b.md'] }]), { text: '一つ目\n\n二つ目', files: [file], filePaths: ['a.md', 'b.md'] })
  assert.deepEqual(mergeQueuedSends([{ text: 'x' }]), { text: 'x', files: undefined, filePaths: undefined })
  assert.equal(steerPartId('s1'), 'steer-s1')
  const unread = unreadSteerParts([{ text: 'a', steerPartId: 'steer-s1' }, { text: 'b' }])
  assert.deepEqual([...unread], ['steer-s1'])
  const messages: UIMessage[] = [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'q' }] },
    { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'r' }, { type: STEER_PART_TYPE, id: 'steer-s1', data: {} }, { type: STEER_PART_TYPE, id: 'steer-s2', data: {} }] as UIMessage['parts'] },
  ]
  const cleaned = withoutSteerParts(messages, unread)
  assert.equal(cleaned[0], messages[0])
  assert.deepEqual(cleaned[1].parts.map(p => (p as { id?: string }).id ?? p.type), ['text', 'steer-s2'])
  assert.equal(withoutSteerParts(messages, new Set()), messages)
  assert.equal(draftWith('下書き', ['一つ目', '  ', '二つ目']), '下書き\n\n一つ目\n\n二つ目')
  assert.equal(draftWith('', ['一つ目']), '一つ目')
})
