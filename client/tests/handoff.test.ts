import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HandoffTrialStore } from '../electron/handoff/trial-store'
import { HANDOFF_HEADINGS, validateHandoff, handoffInputText, saveHandoffArguments } from '../electron/handoff/contract'
import { writeCodexHandoff } from '../electron/handoff/codex'
import type { CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'
const memo = HANDOFF_HEADINGS.map(h => `## ${h}\n- 未確認`).join('\n\n')

test('delete removes memo, backup, cancels active jobs and rejects late writes after restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-handoff-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new HandoffTrialStore(directory)
  const first = store.begin(); first.save(memo); first.close()
  const second = store.begin(); second.save(memo); second.close()
  assert.ok(fs.existsSync(path.join(directory, 'handoff.backup.json')))
  const late = store.begin()
  store.delete()
  assert.equal(late.signal.aborted, true)
  assert.throws(() => late.save(memo), /削除/)
  assert.deepEqual(fs.readdirSync(directory), ['deleted.json'])
  const restarted = new HandoffTrialStore(directory)
  assert.equal(restarted.read(), undefined)
  assert.throws(() => restarted.begin(), /削除/)
  // Crash after tombstone, before cleanup: constructor completes the deletion.
  fs.writeFileSync(path.join(directory, 'handoff.backup.json'), JSON.stringify({ markdown: memo }))
  new HandoffTrialStore(directory)
  assert.equal(fs.existsSync(path.join(directory, 'handoff.backup.json')), false)
})
test('invalid, duplicate, closed and oversized saves cannot overwrite the last good memo', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-handoff-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new HandoffTrialStore(directory)
  const first = store.begin(); first.save(memo)
  assert.throws(() => first.save(memo), /二重/)
  first.close()
  assert.throws(() => first.save(memo), /中止/)
  const next = store.begin()
  assert.throws(() => next.save(memo + 'あ'.repeat(3000)), /8 KiB/)
  assert.throws(() => saveHandoffArguments({ markdown: memo, path: '/somewhere' }, next.save), /markdownだけ/)
  assert.equal(store.read(), memo)
  next.close()
  assert.throws(() => validateHandoff('## 違う見出し'), /見出し/)
  assert.throws(() => handoffInputText({ messages: [{ role: 'user', content: 'あ'.repeat(12000) }] }), /上限/)
})

class FakeRpc implements CodexTransport {
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  replies: RpcMessage[] = []
  closed = false
  experimental = false
  async initialize(experimental = false) { this.experimental = experimental }
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'turn/start') this.onMessage({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } })
    return ({
      'account/read': { account: { type: 'chatgpt' } },
      'model/list': { data: [{ model: 'gpt-5.6-luna', displayName: 'Luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] },
      'config/read': { config: { mcp_servers: { existing: {} } } },
      'thread/start': { thread: { id: 'thread-a' } }, 'turn/start': { turn: { id: 'turn-a' } },
    } as Record<string, unknown>)[method] as T
  }
  send(message: RpcMessage) { this.replies.push(message) }
  close() { this.closed = true }
  save(markdown = memo) { this.onMessage({ id: 100, method: 'item/tool/call', params: { threadId: 'thread-a', turnId: 'turn-a', tool: 'save_handoff', arguments: { markdown } } }) }
  complete() { this.onMessage({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { status: 'completed' } } }) }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const request = (save: (text: string) => void = () => {}) => ({ input: { messages: [] }, cwd: '/tmp/isolated', env: {}, signal: new AbortController().signal, save })
test('Codex uses only explicit dynamic save tool and cumulative usage, no original native session', async () => {
  const rpc = new FakeRpc()
  let saved = ''
  const pending = writeCodexHandoff(request(text => { saved = text }), () => rpc)
  await tick()
  assert.equal(rpc.experimental, true)
  const start = rpc.calls.find(c => c.method === 'thread/start')!.params
  assert.equal(start.ephemeral, true)
  assert.equal(start.approvalPolicy, 'never')
  assert.deepEqual(start.config, { mcp_servers: { existing: { enabled: false } } })
  assert.equal(rpc.calls.some(c => c.method === 'thread/resume'), false)
  rpc.save()
  rpc.onMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-a', tokenUsage: { last: { inputTokens: 20 }, total: { inputTokens: 500, outputTokens: 100, cachedInputTokens: 30 } } } })
  rpc.complete()
  const result = await pending
  assert.equal(saved, memo)
  assert.equal(result.inputTokens, 500)
  assert.equal(result.toolCalls, 1)
  assert.equal(rpc.closed, true)
})
test('plain text is not a substitute for a save; duplicate and unrelated tool calls fail closed', async () => {
  for (const mode of ['no-save', 'duplicate', 'other-tool']) {
    const rpc = new FakeRpc()
    let saves = 0
    const pending = writeCodexHandoff(request(() => { saves++ }), () => rpc)
    await tick()
    if (mode === 'duplicate') { rpc.save(); rpc.save() }
    if (mode === 'other-tool') rpc.onMessage({ id: 101, method: 'item/commandExecution/requestApproval', params: {} })
    rpc.complete()
    await assert.rejects(pending)
    assert.equal(saves, mode === 'duplicate' ? 1 : 0)
    assert.equal(rpc.closed, true)
  }
})
test('abort closes transport and refuses delayed callbacks; wrong thread/turn cannot save', async () => {
  for (const mode of ['abort', 'thread', 'turn']) {
    const rpc = new FakeRpc()
    const controller = new AbortController()
    let saves = 0
    const pending = writeCodexHandoff({ ...request(() => { saves++ }), signal: controller.signal }, () => rpc)
    await tick()
    if (mode === 'abort') { controller.abort(); rpc.save() }
    else rpc.onMessage({ id: 102, method: 'item/tool/call', params: { threadId: mode === 'thread' ? 'other' : 'thread-a', turnId: mode === 'turn' ? 'other' : 'turn-a', tool: 'save_handoff', arguments: { markdown: memo } } })
    await assert.rejects(pending)
    assert.equal(saves, 0)
  }
})


test('old local memo remains readable after restart without any native session', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-handoff-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'handoff.json'), JSON.stringify({ schemaVersion: 1, updatedAt: '2000-01-01T00:00:00Z', markdown: memo }))
  assert.equal(new HandoffTrialStore(directory).read(), memo)
})
