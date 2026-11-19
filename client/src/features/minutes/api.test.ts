// The banner's and the meeting card's re-read signal (minutes.md "In the app"). Guards: one change of
// records re-reads the meetings once — `records:changed` (main sends it once per burst of signals, and
// when its received-minutes look found a change no signal had told) — not again for the
// `minutes:changed` / `notifications:changed` the same change causes (one signal used to re-read
// the arrivals three times); another company's change does not; leaving stops the subscription.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onMeetingsMayHaveChanged, type MeetingReads } from './api'

test('a records change re-reads the meetings once; the minutes and notices events the same change causes do not, nor another company', () => {
  type Listener = (c: { companyId: string }) => void
  const listeners = { records: new Set<Listener>(), minutes: new Set<Listener>(), notifications: new Set<Listener>() }
  const on = (kind: keyof typeof listeners) => (cb: Listener) => { listeners[kind].add(cb); return () => { listeners[kind].delete(cb) } }
  const reads = {
    onRecordsChanged: on('records'), onMinutesChanged: on('minutes'), onNotificationsChanged: on('notifications'),
  } as unknown as MeetingReads
  const emit = (kind: keyof typeof listeners, companyId: string) => { for (const cb of listeners[kind]) cb({ companyId }) }
  let count = 0
  const stop = onMeetingsMayHaveChanged('co-a', () => { count++ }, reads)
  emit('records', 'co-a')
  emit('minutes', 'co-a')
  emit('notifications', 'co-a')
  assert.equal(count, 1)
  emit('records', 'co-b')
  assert.equal(count, 1)
  stop()
  assert.equal(listeners.records.size + listeners.minutes.size + listeners.notifications.size, 0)
})
