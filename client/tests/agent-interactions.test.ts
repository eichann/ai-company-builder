import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentInteractions } from '../electron/agent-interactions'
import { describePermissions, readQuestions } from '../electron/agents/codex-interactions'
import type { AgentInteractionRequest } from '../shared/agent-interaction'
const questions = readQuestions([{ id: 'format', header: '形式', question: '保存形式は？', options: [{ label: 'Markdown', description: '編集可能' }], isOther: true, isSecret: false }])
test('requests are scoped by renderer and conversation, validate answers, close once', async () => {
  const events: string[] = []
  const broker = new AgentInteractions((_owner, event) => events.push(event))
  const p = broker.request(1, 'chat-a', { kind: 'questions', questions }, new AbortController().signal)
  const request = broker.list(1)[0]
  assert.equal(broker.list(2).length, 0); assert.equal(request.appSessionId, 'chat-a')
  assert.equal(broker.respond(2, request.id, { answers: { format: 'Markdown' } }), false)
  assert.equal(broker.respond(1, request.id, { answers: {} }), false)
  assert.equal(broker.respond(1, request.id, { answers: { format: '独自形式' } }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(await p)), { answers: { format: '独自形式' } })
  assert.equal(broker.respond(1, request.id, { cancelled: true }), false)
  assert.deepEqual(events, ['request', 'closed'])
})
test('abort, renderer closure and timeout settle pending requests and remove cards', async () => {
  const broker = new AgentInteractions(() => {}, 10)
  const abort = new AbortController()
  const p = broker.request(1, 'a', { kind: 'questions', questions }, abort.signal)
  abort.abort(); assert.deepEqual(await p, { cancelled: true, reason: 'aborted' })
  const q = broker.request(1, 'b', { kind: 'questions', questions }, new AbortController().signal)
  broker.closeOwner(1); assert.deepEqual(await q, { cancelled: true, reason: 'aborted' })
  assert.deepEqual(await broker.request(1, 'c', { kind: 'questions', questions }, new AbortController().signal), { cancelled: true, reason: 'timeout' })
  assert.deepEqual(broker.list(1), [])
})
test('permission UI only enables known, completely displayed grants', async () => {
  const description = describePermissions({ network: { enabled: true }, fileSystem: { read: ['/tmp/a'], write: ['/tmp/b'], entries: [{ path: { type: 'path', path: '/tmp/c' }, access: 'write' }] } }, '出力を保存', '/tmp')
  assert.equal(description.supported, true); assert.equal(description.entries.length, 3); assert.equal(description.network, true)
  for (const permissions of [{ fileSystem: { entries: [{ path: { type: 'special', value: 'root' }, access: 'write' }] } }, { network: { enabled: true, extra: 'unknown' } }, { fileSystem: { write: ['relative'] } }, { futurePermission: true }]) {
    const d = describePermissions(permissions, '', '')
    assert.equal(d.supported, false)
    let request!: AgentInteractionRequest
    const broker = new AgentInteractions((_owner, event, r) => { if (event === 'request') request = r })
    const p = broker.request(1, 'a', d, new AbortController().signal)
    assert.equal(broker.respond(1, request.id, { approved: true }), false)
    broker.respond(1, request.id, { approved: false }); assert.deepEqual(await p, { approved: false })
  }
})
test('invalid/duplicate questions fail explicitly instead of silently sending empty answers', () => {
  assert.throws(() => readQuestions([]))
  assert.throws(() => readQuestions([{ ...questions[0], id: '__proto__' }]))
  assert.throws(() => readQuestions([questions[0], questions[0]]))
})
