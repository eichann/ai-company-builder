import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatHistoryStore } from '../electron/chat-history-store'
import { HandoffStore, fingerprint } from '../electron/handoff/store'
import { HandoffService, handoffChunk } from '../electron/handoff/service'
import { HANDOFF_HEADINGS, type HandoffRequest, type HandoffMetrics } from '../electron/handoff/contract'
import type { ChatSession } from '../shared/chat-history'
const memo = HANDOFF_HEADINGS.map(h => `## ${h}\n- 未確認`).join('\n\n')
const metrics: HandoffMetrics = { provider: 'codex', model: 'test', setupMs: 0, saveMs: 1, totalMs: 2, inputTokens: 100, outputTokens: 20, toolCalls: 1 }
const tick = () => new Promise(resolve => setTimeout(resolve, 25))
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-handoff-service-'))
  const history = new ChatHistoryStore(path.join(dir, 'history'))
  const store = new HandoffStore(path.join(dir, 'memos'), history)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const add = (id: string, n: number, text = `回答${n}`) => {
    const session: ChatSession = history.get('company', id) || { companyId: 'company', id, title: id, messages: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    session.messages.push({ id: `u${n}`, role: 'user', content: `質問${n}`, timestamp: '2026-01-01' }, { id: `a${n}`, role: 'assistant', content: text, timestamp: '2026-01-01' })
    history.save('company', session)
    return { messageId: `a${n}`, content: text, provider: 'codex' as const }
  }
  return { dir, history, store, add }
}
test('saved completion receipts schedule exactly once; drafts and mismatched saves do not', async t => {
  const f = fixture(t); let calls = 0
  const service = new HandoffService(f.history, f.store, async (_, r) => { calls++; r.save(memo); return metrics }, () => {}, { idleMs: 1, turns: 2 })
  t.after(() => service.dispose())
  const first = f.add('chat', 1)
  service.touch('company', 'chat'); await tick(); assert.equal(calls, 0)
  assert.throws(() => service.complete('company', 'chat', { ...first, content: 'not saved' }), /保存/)
  service.complete('company', 'chat', first); service.complete('company', 'chat', first)
  const draft = f.history.get('company', 'chat')!; draft.draftInput = '書きかけ'; f.history.save('company', draft)
  await tick(); assert.equal(calls, 0); assert.equal(f.store.read('company', 'chat').turns, 1)
  service.complete('company', 'chat', f.add('chat', 2)); await tick()
  assert.equal(calls, 1); assert.equal(service.view('company', 'chat').markdown, memo)
})
test('deletion during generation removes backup, aborts and rejects a late save even across restart', async t => {
  const f = fixture(t)
  let request: Pick<HandoffRequest, 'input' | 'signal' | 'save'> | undefined
  let finish: (() => void) | undefined
  const service = new HandoffService(f.history, f.store, async (_, r) => { request = r; await new Promise<void>(resolve => { finish = resolve }); r.save(memo); return metrics }, () => {}, { idleMs: 1, turns: 1 })
  t.after(() => service.dispose())
  service.complete('company', 'chat', f.add('chat', 1)); await tick()
  assert.ok(request)
  f.history.delete('company', 'chat'); service.invalidate('company', 'chat')
  assert.equal(request.signal.aborted, true)
  finish!(); await tick()
  assert.equal(fs.existsSync(f.store.file('company', 'chat')), false)
  assert.equal(fs.existsSync(f.store.file('company', 'chat') + '.bak'), false)
  assert.equal(f.history.get('company', 'chat'), null)
  assert.equal(f.store.read('company', 'chat').memo, undefined)
  fs.writeFileSync(f.store.file('company', 'chat') + '.bak', '{}')
  new HandoffStore(f.store.directory, f.history).cleanupDeleted()
  assert.equal(fs.existsSync(f.store.file('company', 'chat') + '.bak'), false)
})
test('edits reject a pending memo, pin/title changes preserve a valid old memo', async t => {
  const f = fixture(t); let finish: (() => void) | undefined
  const service = new HandoffService(f.history, f.store, async (_, r) => { await new Promise<void>(resolve => { finish = resolve }); r.save(memo); return metrics }, () => {}, { idleMs: 1, turns: 1 })
  t.after(() => service.dispose())
  service.complete('company', 'chat', f.add('chat', 1)); await tick()
  const edited = f.history.get('company', 'chat')!; edited.messages[0].content = 'edited'; f.history.save('company', edited)
  finish!(); await tick(); assert.equal(f.store.read('company', 'chat').memo, undefined)
  const cursor = { index: edited.messages.length, offset: 0 }
  f.store.write('company', 'chat', { version: 1, turns: 1, memo: { cursor, hash: fingerprint(edited.messages, cursor), markdown: memo, updatedAt: '2000-01-01', provider: 'codex', turns: 1, metrics } })
  f.history.patch('company', 'chat', { pinned: true, title: 'new title' })
  assert.equal(f.store.read('company', 'chat').memo?.markdown, memo)
})
test('normal chat pauses generation; failed model completion cannot publish staged tool data', async t => {
  const f = fixture(t); let calls = 0
  const service = new HandoffService(f.history, f.store, async (_, r) => { calls++; r.save(memo); throw new Error('failed after tool') }, () => {}, { idleMs: 1, turns: 1 })
  t.after(() => service.dispose())
  service.setBusy('chat', true); service.complete('company', 'chat', f.add('chat', 1)); await tick(); assert.equal(calls, 0)
  service.setBusy('chat', false); await tick(); assert.equal(calls, 1)
  assert.equal(service.view('company', 'chat').status, 'error'); assert.equal(service.view('company', 'chat').markdown, undefined)
  await tick(); assert.equal(calls, 1)
})
test('global limit persists after restart; API mode does not fall back to another provider', async t => {
  const f = fixture(t); let calls = 0
  const writer = async (_: 'claude-code' | 'codex', r: Pick<HandoffRequest, 'input' | 'signal' | 'save'>) => { calls++; r.save(memo); return metrics }
  const options = { idleMs: 1, turns: 1, jobsPerHour: 1, now: () => 1_000_000 }
  const first = new HandoffService(f.history, f.store, writer, () => {}, options)
  first.complete('company', 'a', f.add('a', 1)); await tick(); first.dispose(); assert.equal(calls, 1)
  const next = new HandoffService(f.history, f.store, writer, () => {}, options); t.after(() => next.dispose())
  next.complete('company', 'b', f.add('b', 1)); await tick(); assert.equal(calls, 1)
  next.complete('company', 'api', { ...f.add('api', 1), provider: 'api-key' }); await tick()
  assert.equal(calls, 1); assert.equal(next.view('company', 'api').status, 'unsupported')
})
test('large messages are chunked continuously without cutting emoji or losing content', t => {
  const f = fixture(t); const text = 'あ😀'.repeat(20000); f.add('chat', 1, text)
  const session = f.history.get('company', 'chat')!; const end = { index: session.messages.length, offset: 0 }
  const checkpoint = { cursor: end, hash: fingerprint(session.messages, end), provider: 'codex' as const, messageId: 'a1' }
  let state = { version: 1 as const, turns: 1, checkpoint, memo: undefined as ReturnType<HandoffStore['read']>['memo'] }
  let recovered = ''; let count = 0
  while (!state.memo || state.memo.cursor.index < end.index) {
    const chunk = handoffChunk(session, state)
    assert.ok(chunk.input.messages.every(m => !/[\uD800-\uDBFF]$/u.test(m.content)))
    recovered += chunk.input.messages.filter(m => m.role === 'assistant').map(m => m.content).join('')
    state = { ...state, memo: { markdown: memo, cursor: chunk.cursor, hash: fingerprint(session.messages, chunk.cursor), updatedAt: '2026-01-01', provider: 'codex', turns: 0, metrics } }
    assert.ok(++count < 100)
  }
  assert.equal(recovered, text)
})
test('closing the service and reopening retains memo and draft; deletion rejects stale autosave', async t => {
  const f = fixture(t)
  const service = new HandoffService(f.history, f.store, async (_, r) => { r.save(memo); return metrics }, () => {}, { idleMs: 1, turns: 1 })
  service.complete('company', 'chat', f.add('chat', 1)); await tick()
  const old = f.history.get('company', 'chat')!; old.draftInput = '書きかけ'; f.history.save('company', old)
  service.dispose()
  const reopened = new HandoffStore(f.store.directory, f.history)
  reopened.cleanupDeleted()
  assert.equal(reopened.read('company', 'chat').memo?.markdown, memo)
  assert.equal(f.history.get('company', 'chat')?.draftInput, '書きかけ')
  f.history.delete('company', 'chat'); service.invalidate('company', 'chat')
  assert.equal(f.history.save('company', old).status, 'deleted')
  assert.equal(reopened.read('company', 'chat').memo, undefined)
})
test('old conversations can manually create a memo even when the native session is already gone', async t => {
  const f = fixture(t); f.add('chat', 1)
  f.history.patch('company', 'chat', { agentSession: { providerId: 'codex', id: 'missing' } })
  const service = new HandoffService(f.history, f.store, async (_, r) => { r.save(memo); return metrics }, () => {}, { idleMs: 1 })
  t.after(() => service.dispose())
  assert.equal(service.view('company', 'chat').canUpdate, true)
  service.requestUpdate('company', 'chat'); await tick()
  assert.equal(service.view('company', 'chat').markdown, memo)
})
