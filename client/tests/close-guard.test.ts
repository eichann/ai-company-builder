// Closing the main window lets the renderer save every open tab first
// (electron/services/close-guard.ts): the close is held until the renderer
// answers, a renderer that never answers cannot keep the window open, and a
// quit that was held still quits once the renderer is done.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCloseGuard } from '../electron/services/close-guard'

function world() {
  const events: string[] = []
  const timers: Array<() => void> = []
  const guard = createCloseGuard({
    ask: () => events.push('ask'),
    close: () => events.push('close'),
    quit: () => events.push('quit'),
    setTimer: fn => { timers.push(fn); return timers.length - 1 },
    clearTimer: id => { timers[id as number] = () => {} },
  })
  return { guard, events, fireTimers: () => timers.splice(0).forEach(fn => fn()) }
}

test('the window is held until the renderer has saved, and closes when it answers close', () => {
  const { guard, events, fireTimers } = world()
  assert.equal(guard.onClose(), false)
  assert.equal(guard.onClose(), false) // a second click while saving asks nothing more
  guard.answer('ack')
  fireTimers() // acknowledged: the timeout no longer closes it
  assert.deepEqual(events, ['ask'])
  guard.answer('close')
  assert.deepEqual(events, ['ask', 'close'])
  assert.equal(guard.onClose(), true) // the close it triggered passes
})

test('stay keeps the window open; the next close asks again', () => {
  const { guard, events } = world()
  guard.onClose()
  guard.answer('ack')
  guard.answer('stay')
  assert.deepEqual(events, ['ask'])
  assert.equal(guard.onClose(), false)
  assert.deepEqual(events, ['ask', 'ask'])
})

test('a renderer that never acknowledges (still loading, hung) cannot keep the window open', () => {
  const { guard, events, fireTimers } = world()
  guard.onClose()
  fireTimers()
  assert.deepEqual(events, ['ask', 'close'])
})

test('a held quit quits once the renderer says close; stay also cancels the quit', () => {
  const a = world()
  a.guard.onQuitRequested()
  a.guard.onClose()
  a.guard.answer('ack')
  a.guard.answer('close')
  assert.deepEqual(a.events, ['ask', 'quit'])

  const b = world()
  b.guard.onQuitRequested()
  b.guard.onClose()
  b.guard.answer('ack')
  b.guard.answer('stay')
  b.guard.onClose()
  b.guard.answer('close')
  assert.deepEqual(b.events, ['ask', 'ask', 'close'])
})
