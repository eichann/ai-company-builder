// The core app's end of a plugin screen's bridge (plugin-frame.md): the frame is handed one port,
// once; only messages on that port are read; unknown ops never reach main; ui.open stays in the
// core screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridgeHost, type FrameTarget } from './bridge-host'

const REC = 'program_plan-abc123'

function frame() {
  const posts: Array<{ message: unknown; origin: string; ports: MessagePort[] }> = []
  const target: FrameTarget = { postMessage: (message, origin, transfer) => { posts.push({ message, origin, ports: transfer as MessagePort[] }) } }
  return { target, posts }
}

/** The frame's side: send a call on its port and wait for the answer. */
function ask(port: MessagePort, data: unknown): Promise<unknown> {
  return new Promise(resolve => {
    port.onmessage = (event: MessageEvent) => resolve(event.data)
    port.postMessage(data)
  })
}

test('the port is handed once, with the hello and nothing else', () => {
  const host = createBridgeHost({ call: async () => ({ ok: true, data: null }), open: () => ({ ok: true, data: null }) })
  const f = frame()
  assert.equal(host.handOver(f.target), true)
  assert.equal(host.handOver(f.target), false)
  assert.equal(host.handOver(frame().target), false)
  assert.equal(f.posts.length, 1)
  assert.deepEqual(f.posts[0].message, { type: 'acb-bridge', bridge: 1 })
  assert.equal(f.posts[0].ports.length, 1)
  f.posts[0].ports[0].close()
  host.close()
})

test('a slot\'s frame gets only its place in the hello: the record id, or the chosen company path (A6)', () => {
  for (const context of [{ slot: 'record_section' as const, recordId: REC }, { slot: 'file_action' as const, path: '企画/台本.pdf', isFolder: false }]) {
    const host = createBridgeHost({ call: async () => ({ ok: true, data: null }), open: () => ({ ok: true, data: null }), context })
    const f = frame()
    host.handOver(f.target)
    assert.deepEqual(f.posts[0].message, { type: 'acb-bridge', bridge: 1, context })
    f.posts[0].ports[0].close()
    host.close()
  }
})

test('a known server op goes to main; an unknown op or bad args are answered without reaching it; ui.open stays in the app', async () => {
  const calls: Array<[string, unknown]> = []
  const opened: unknown[] = []
  const host = createBridgeHost({
    call: async (op, args) => { calls.push([op, args]); return { ok: true, data: { total: 0 } } },
    open: target => { opened.push(target); return { ok: true, data: null } },
  })
  const f = frame()
  host.handOver(f.target)
  const port = f.posts[0].ports[0]

  assert.deepEqual(await ask(port, { id: 1, op: 'records.query', args: { type: 'program_plan' } }), { id: 1, ok: true, data: { total: 0 } })
  assert.deepEqual(await ask(port, { id: 2, op: 'approvals.approve', args: {} }), { id: 2, ok: false, error: { code: 'UNKNOWN_OP', message: 'unknown op' } })
  const bad = await ask(port, { id: 3, op: 'records.get', args: { recordId: REC, token: 'x' } }) as { ok: boolean; error: { code: string } }
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'BAD_REQUEST')
  assert.deepEqual(await ask(port, { id: 4, op: 'ui.open', args: { target: 'record', recordId: REC } }), { id: 4, ok: true, data: null })

  assert.deepEqual(calls, [['records.query', { type: 'program_plan' }]])
  assert.deepEqual(opened, [{ target: 'record', recordId: REC }])
  port.close()
  host.close()
})
