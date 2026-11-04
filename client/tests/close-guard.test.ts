// Closing the main window lets the renderer save every open tab first
// (electron/services/close-guard.ts): the close is held until the renderer
// answers, a renderer that never answers cannot keep the window open, and a
// quit that was held still quits once the renderer is done.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gitMayBeRunningElsewhere } from '../electron/services/sync-activity'
import { CLOSE_DURING_SYNC_CHOICES, CLOSE_DURING_SYNC_QUESTION, createCloseGuard, type CloseDuringSyncChoice } from '../electron/services/close-guard'

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

/** A guard with a sync that runs until `finishSync`; the member gives `choices` in order. */
function syncWorld(...choices: CloseDuringSyncChoice[]) {
  const events: string[] = []
  const timers: Array<() => void> = []
  let running = true
  const waiting: Array<() => void> = []
  const guard = createCloseGuard({
    ask: () => events.push('ask'),
    close: () => events.push('close'),
    quit: () => events.push('quit'),
    setTimer: fn => { timers.push(fn); return timers.length - 1 },
    clearTimer: id => { timers[id as number] = () => {} },
    sync: {
      running: () => running,
      confirm: async () => { events.push('question'); return choices.shift() ?? 'stay' },
      done: () => new Promise<void>(resolve => { if (running) waiting.push(resolve); else resolve() }),
      resume: () => events.push('resume'),
    },
  })
  return {
    guard, events,
    fireTimers: () => timers.splice(0).forEach(fn => fn()),
    finishSync: () => { running = false; waiting.splice(0).forEach(resolve => resolve()) },
    stopRunning: () => { running = false },
  }
}

const settled = () => new Promise(resolve => setImmediate(resolve))

test('quitting during a sync asks, the app stays until it has ended, and what was typed meanwhile is saved', async () => {
  const { guard, events, finishSync } = syncWorld('wait')
  guard.onQuitRequested()
  guard.onClose()
  guard.answer('close')
  await settled()
  assert.deepEqual(events, ['ask', 'question'], 'not closed while the sync runs')
  finishSync()
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'ask'], 'the renderer saves again before closing')
  guard.answer('ack')
  guard.answer('close')
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'ask', 'quit'])
})

test('after the wait the renderer can still say stay (a tab that cannot be saved): automatic runs go on', async () => {
  const { guard, events, finishSync } = syncWorld('wait')
  guard.onClose()
  guard.answer('close')
  await settled()
  finishSync()
  await settled()
  guard.answer('stay')
  assert.deepEqual(events, ['ask', 'question', 'ask', 'resume'])
  assert.equal(guard.onClose(), false)
})

test('another close during the wait asks again, so a hung sync cannot trap the member', async () => {
  const { guard, events } = syncWorld('wait', 'quit-now')
  guard.onClose()
  guard.answer('close')
  await settled()
  assert.equal(guard.onClose(), false)
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'question', 'ask'], 'what was typed during the wait is saved first')
  guard.answer('close')
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'question', 'ask', 'quit'], 'and the running sync is not asked about again')
})

test('choosing to wait again keeps waiting; the sync ending during the question is not missed', async () => {
  const { guard, events, finishSync } = syncWorld('wait', 'wait')
  guard.onClose()
  guard.answer('close')
  await settled()
  guard.onClose()
  finishSync()
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'question', 'ask'])
})

test('waiting twice saves once when the sync ends', async () => {
  const { guard, events, finishSync } = syncWorld('wait', 'wait')
  guard.onClose()
  guard.answer('close')
  await settled()
  guard.onClose()
  await settled()
  finishSync()
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'question', 'ask'])
})

test('閉じない during the wait stops waiting: the end of the sync closes nothing', async () => {
  const { guard, events, finishSync } = syncWorld('wait', 'stay')
  guard.onClose()
  guard.answer('close')
  await settled()
  guard.onClose()
  await settled()
  finishSync()
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'question', 'resume'])
})

test('a hung renderer skips neither the question nor the wait, and cannot hold the close afterwards', async () => {
  const { guard, events, fireTimers, finishSync } = syncWorld('wait')
  guard.onClose()
  fireTimers()
  await settled()
  assert.deepEqual(events, ['ask', 'question'])
  finishSync()
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'ask'])
  fireTimers()
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'ask', 'close'])
})

test('閉じない keeps the app open and the quit is forgotten', async () => {
  const stay = syncWorld('stay')
  stay.guard.onQuitRequested()
  stay.guard.onClose()
  stay.guard.answer('close')
  await settled()
  assert.deepEqual(stay.events, ['ask', 'question'])
  stay.stopRunning()
  stay.guard.onClose()
  stay.guard.answer('close')
  await settled()
  assert.deepEqual(stay.events, ['ask', 'question', 'ask', 'close'], 'closes the window, does not quit')
})

test('すぐに終了する really quits, also from closing the window alone (macOS would leave the sync running without a window)', async () => {
  const { guard, events, fireTimers } = syncWorld('quit-now')
  guard.onClose()
  guard.answer('close')
  await settled()
  fireTimers() // a renderer gone silent cannot hold the quit either
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'ask', 'quit'])
  assert.equal(guard.onClose(), true, 'the close that quitting causes passes')
})

test('a tab that cannot be saved stops すぐに終了する too, and the next close asks from the start', async () => {
  const { guard, events } = syncWorld('quit-now', 'stay')
  guard.onClose()
  guard.answer('close')
  await settled()
  guard.answer('stay')
  guard.onClose()
  guard.answer('close')
  await settled()
  assert.deepEqual(events, ['ask', 'question', 'ask', 'ask', 'question'])
})

test('no sync running: nothing is asked', async () => {
  const { guard, events, stopRunning } = syncWorld('wait')
  stopRunning()
  guard.onClose()
  guard.answer('close')
  await settled()
  assert.deepEqual(events, ['ask', 'close'])
})

test('the question offers waiting first, and escape means staying', () => {
  assert.equal(CLOSE_DURING_SYNC_QUESTION.buttons.length, CLOSE_DURING_SYNC_CHOICES.length)
  assert.equal(CLOSE_DURING_SYNC_CHOICES[CLOSE_DURING_SYNC_QUESTION.defaultId], 'wait')
  assert.equal(CLOSE_DURING_SYNC_CHOICES[CLOSE_DURING_SYNC_QUESTION.cancelId], 'stay')
})

test('the AI counts as git the app cannot see: a lock may be its', () => {
  const none = { current: () => null }
  assert.equal(gitMayBeRunningElsewhere(none, () => false), false)
  assert.equal(gitMayBeRunningElsewhere(none, () => true), true)
  assert.equal(gitMayBeRunningElsewhere({ current: () => 'download-choices' as const }, () => false), true)
  // Called from inside that change: its own mark does not count, the AI still does.
  assert.equal(gitMayBeRunningElsewhere({ current: () => 'download-choices' as const }, () => false, { ownActivity: true }), false)
  assert.equal(gitMayBeRunningElsewhere({ current: () => 'download-choices' as const }, () => true, { ownActivity: true }), true)
})
