import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VoiceInputSession, type RecognitionEvent } from '../electron/voice-session'
import type { VoiceEvent } from '../shared/voice-input'
function harness(polish: (text: string, signal: AbortSignal) => Promise<string> = async text => `整文:${text}`) {
  const events: VoiceEvent[] = []
  let receive: (event: RecognitionEvent) => void = () => {}
  let stops = 0, cancels = 0
  const session = new VoiceInputSession({
    capabilities: async () => ({ available: true }),
    start: callback => { receive = callback; return { stop: () => { stops++ }, cancel: () => { cancels++ } } },
  }, async () => true, polish, event => events.push(event))
  return { session, events, receive: (event: RecognitionEvent) => receive(event), counts: () => ({ stops, cancels }) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
test('stop finalizes only once, duplicate recognition results produce one insertion', async () => {
  const h = harness(); await h.session.start('a')
  h.receive({ type: 'listening' }); h.session.stop('a'); h.session.stop('a')
  h.receive({ type: 'result', text: '会議です' }); h.receive({ type: 'result', text: '会議です' }); await tick()
  assert.equal(h.counts().stops, 1)
  assert.equal(h.events.filter(e => e.type === 'result').length, 1)
  assert.equal(h.session.busy, false)
})
test('cancelled polishing cannot insert into a new session', async () => {
  let finish!: (text: string) => void
  let signal!: AbortSignal
  const h = harness((_text, s) => { signal = s; return new Promise(resolve => { finish = resolve }) })
  await h.session.start('old'); h.receive({ type: 'result', text: 'old' }); h.session.cancel('old')
  assert.equal(signal.aborted, true)
  await h.session.start('new'); finish('遅い結果'); await tick()
  assert.equal(h.events.some(e => e.type === 'result'), false)
  h.session.cancel()
})
test('failure retains raw text; empty recognition never invokes AI', async () => {
  let calls = 0
  const h = harness(async () => { calls++; throw new Error('offline') })
  await h.session.start('a'); h.receive({ type: 'result', text: '原文' }); await tick()
  assert.deepEqual(h.events.at(-1), { requestId: 'a', type: 'error', message: 'offline', rawText: '原文' })
  await h.session.start('b'); h.receive({ type: 'result', text: '  ' }); await tick()
  assert.equal(calls, 1)
  assert.equal(h.session.busy, false)
})
test('cancel while awaiting permission never starts a microphone', async () => {
  let grant!: (allowed: boolean) => void
  let started = false
  const session = new VoiceInputSession({ capabilities: async () => ({ available: true }), start: () => { started = true; return { stop() {}, cancel() {} } } }, () => new Promise(resolve => { grant = resolve }), async text => text, () => {})
  const pending = session.start('a'); await tick(); session.cancel(); grant(true); await pending
  assert.equal(started, false)
})
test('stale cancel/stop does not affect current recording', async () => {
  const h = harness(); await h.session.start('new'); h.receive({ type: 'listening' })
  h.session.stop('old'); h.session.cancel('old')
  assert.equal(h.session.busy, true); assert.equal(h.counts().stops, 0)
  h.session.cancel()
})
