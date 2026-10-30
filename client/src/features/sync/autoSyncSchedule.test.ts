import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_AUTO_SYNC_STATE,
  RETRY_AFTER_SKIP_MS,
  afterSync,
  dueAt,
  needsMemberAfter,
  nextSlotAfter,
  recordRun,
  runDueNow,
  type AutoSyncState,
} from './autoSyncSchedule'
import { DEFAULT_AUTO_SYNC_SETTINGS, normalizeAutoSyncSettings, type AutoSyncSettings } from '../../shared/lib/autoSyncSettings'

const MIN = 60_000
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()
const settings = (patch: { receive?: Partial<AutoSyncSettings['receive']>; send?: Partial<AutoSyncSettings['send']> } = {}): AutoSyncSettings => ({
  receive: { ...DEFAULT_AUTO_SYNC_SETTINGS.receive, ...patch.receive },
  send: { ...DEFAULT_AUTO_SYNC_SETTINGS.send, ...patch.send },
})
const state = (patch: Partial<AutoSyncState> = {}): AutoSyncState => ({ ...EMPTY_AUTO_SYNC_STATE, ...patch })

test('the owner-approved defaults: receive on every 15 minutes, send off (12:00 and 18:00 when turned on)', () => {
  const d = normalizeAutoSyncSettings(null)
  assert.deepEqual(d.receive, { enabled: true, intervalMinutes: 15 })
  assert.equal(d.send.enabled, false)
  assert.deepEqual(d.send.times, ['12:00', '18:00'])
  assert.deepEqual(normalizeAutoSyncSettings({ receive: { intervalMinutes: 7 }, send: { times: ['25:00', 'x'] } }), d, 'unknown values fall back to the defaults')
})

test('receiving runs at the start, then every interval after its last run', () => {
  const s = settings()
  const open = at(30, 9)
  assert.equal(runDueNow(s, state(), open, open), 'receive')
  const after = recordRun(state(), 'receive', 'ran', open)
  assert.equal(runDueNow(s, after, open + 14 * MIN, open), null)
  assert.equal(runDueNow(s, after, open + 15 * MIN, open), 'receive')
})

test('turned off means never', () => {
  const s = settings({ receive: { enabled: false } })
  assert.equal(runDueNow(s, state(), at(30, 12), at(30, 9)), null)
  assert.equal(dueAt('send', s, state(), at(30, 9)), null)
})

test('runs missed while the app was closed come due once, never one per missed slot or interval', () => {
  const s = settings({ send: { enabled: true, mode: 'times', enabledAt: at(27, 8) } })
  let st = state({ send: { lastRunAt: at(27, 18), lastSkipAt: null }, receive: { lastRunAt: at(27, 18), lastSkipAt: null } })
  const open = at(30, 13) // three days and five 12:00 / 18:00 slots later
  assert.equal(runDueNow(s, st, open, open), 'send')
  st = recordRun(st, 'send', 'ran', open)
  assert.equal(runDueNow(s, st, open + MIN, open), null, 'no burst after the catch-up')
  assert.equal(dueAt('send', s, st, open), at(30, 18), 'the next run is the next slot')
})

test('sending at times never catches up on slots before it was turned on', () => {
  const s = settings({ send: { enabled: true, mode: 'times', enabledAt: at(30, 13) } })
  assert.equal(dueAt('send', s, state(), at(30, 13)), at(30, 18))
  assert.equal(runDueNow(settings({ receive: { enabled: false }, send: { enabled: true, enabledAt: at(30, 13) } }), state(), at(30, 13, 30), at(30, 13)), null)
})

test('sending every N minutes counts from its last run (or from when it was turned on)', () => {
  const s = settings({ send: { enabled: true, mode: 'interval', intervalMinutes: 30, enabledAt: at(30, 9) } })
  assert.equal(dueAt('send', s, state(), at(30, 9)), at(30, 9, 30))
  assert.equal(dueAt('send', s, state({ send: { lastRunAt: at(30, 10), lastSkipAt: null } }), at(30, 9)), at(30, 10, 30))
})

test('time slots: the next one after a moment, across midnight', () => {
  assert.equal(nextSlotAfter(['12:00', '18:00'], at(30, 12)), at(30, 18), 'strictly after')
  assert.equal(nextSlotAfter(['12:00', '18:00'], at(30, 19)), at(31, 12))
  assert.equal(nextSlotAfter([], at(30, 19)), null)
})

test('a skipped run waits before trying again, then runs; a send also counts as a receive', () => {
  const s = settings()
  const open = at(30, 9)
  const skipped = recordRun(state(), 'receive', 'skipped', open)
  assert.equal(runDueNow(s, skipped, open + RETRY_AFTER_SKIP_MS - 1, open), null)
  assert.equal(runDueNow(s, skipped, open + RETRY_AFTER_SKIP_MS, open), 'receive')
  const sent = recordRun(state(), 'send', 'ran', open)
  assert.equal(runDueNow(s, sent, open + MIN, open), null, 'no receive right after a send')
})

test('sending goes first when both are due (it also brings teammates\' changes)', () => {
  const s = settings({ send: { enabled: true, mode: 'interval', intervalMinutes: 30, enabledAt: at(30, 8) } })
  assert.equal(runDueNow(s, state(), at(30, 9), at(30, 9)), 'send')
})

test('only failures the member must resolve stop automatic sync; network trouble retries', () => {
  for (const errorType of ['conflict', 'needs_member', 'protected_config', 'write_denied', 'personal_path', 'local_only_path', 'reserved_path']) {
    assert.equal(needsMemberAfter({ success: false, errorType }), true, errorType)
  }
  assert.equal(needsMemberAfter({ success: false, secretDetected: true }), true)
  assert.equal(needsMemberAfter({ success: false, error: '同期がキャンセルされました' }), true)
  for (const errorType of ['network', 'auth', 'locked', 'push_failed', 'unknown']) {
    assert.equal(needsMemberAfter({ success: false, errorType }), false, errorType)
  }
})

test('an automatic failure is shown once per kind until a sync succeeds; a manual press always shows its own', () => {
  let st = state()
  const failure = { success: false, errorType: 'network', error: 'つながりません' }
  let r = afterSync(st, failure, { manual: false })
  assert.equal(r.showFailure, true)
  st = r.state
  r = afterSync(st, failure, { manual: false })
  assert.equal(r.showFailure, false, 'no repeat of the same notice')
  assert.equal(afterSync(st, { success: false, errorType: 'auth' }, { manual: false }).showFailure, true, 'another kind is new')
  assert.equal(afterSync(st, failure, { manual: true }).showFailure, true)
  st = afterSync(st, { success: true }, { manual: false }).state
  assert.equal(afterSync(st, failure, { manual: false }).showFailure, true, 'shown again after it was resolved')
})

test('a stop for the member lasts until a sync succeeds', () => {
  let st = afterSync(state(), { success: false, errorType: 'needs_member' }, { manual: false }).state
  assert.equal(st.needsMember, true)
  st = afterSync(st, { success: false, errorType: 'network' }, { manual: true }).state
  assert.equal(st.needsMember, true, 'an unrelated failure does not lift it')
  st = afterSync(st, { success: true }, { manual: true }).state
  assert.equal(st.needsMember, false)
})
