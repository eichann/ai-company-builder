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

test('selected microphone is forwarded unchanged and meter events keep the session listening', async () => {
  const events: VoiceEvent[] = []
  let receive!: (event: RecognitionEvent) => void
  let selected: string | undefined
  const session = new VoiceInputSession({ capabilities: async () => ({ available: true }), start: (callback, deviceId) => {
    selected = deviceId; receive = callback; return { stop() {}, cancel() {} }
  } }, async () => true, async text => text, event => events.push(event))
  await session.start('a', 'usb:device with spaces')
  assert.equal(selected, 'usb:device with spaces')
  receive({ type: 'level', level: 0.7 }); assert.equal(events.length, 0)
  receive({ type: 'listening', deviceName: 'USB microphone' })
  receive({ type: 'level', level: 0.6, clipping: false })
  receive({ type: 'level', level: NaN })
  assert.deepEqual(events.at(-1), { requestId: 'a', type: 'level', level: 0.6, clipping: false })
  receive({ type: 'level', level: 2, clipping: true })
  assert.deepEqual(events.at(-1), { requestId: 'a', type: 'level', level: 1, clipping: true })
  session.stop('a')
  receive({ type: 'level', level: 0.5 })
  assert.equal(events.at(-1)?.type, 'finalizing')
  session.cancel()
  const count = events.length
  receive({ type: 'level', level: 0.9 })
  assert.equal(events.length, count)
})

test('microphone disconnection ends recording without polishing or switching devices', async () => {
  let polished = false
  const h = harness(async text => { polished = true; return text })
  await h.session.start('a', 'usb')
  h.receive({ type: 'listening' })
  h.receive({ type: 'error', message: 'マイクが切断されました' })
  h.receive({ type: 'result', text: 'late' })
  await tick()
  assert.equal(h.session.busy, false)
  assert.equal(h.counts().cancels, 1)
  assert.equal(polished, false)
  assert.equal(h.events.at(-1)?.type, 'error')
})
