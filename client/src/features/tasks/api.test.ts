// The task list's re-read signal (tasks-ui.md "Renderer"). Guards: a record the member's own AI
// wrote (`records:changed`, sent by main at once) re-reads the list without waiting for the
// 2-minute look; another company's signal does not; leaving stops both subscriptions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onTasksMayHaveChanged, type TaskReads } from './api'

function channels() {
  const listeners = { notifications: new Set<(c: { companyId: string }) => void>(), records: new Set<(c: { companyId: string }) => void>() }
  const reads = {
    getTaskList: async () => ({ success: false, error: 'x' }),
    onNotificationsChanged: (cb: (c: { companyId: string }) => void) => { listeners.notifications.add(cb); return () => { listeners.notifications.delete(cb) } },
    onRecordsChanged: (cb: (c: { companyId: string }) => void) => { listeners.records.add(cb); return () => { listeners.records.delete(cb) } },
  } as unknown as TaskReads
  const emit = (kind: keyof typeof listeners, companyId: string) => { for (const cb of listeners[kind]) cb({ companyId }) }
  return { reads, emit, listeners }
}

test('the list re-reads when a record of its company changed (the member\'s own AI, or a push signal) and on notices; never for another company', () => {
  const { reads, emit, listeners } = channels()
  let count = 0
  const stop = onTasksMayHaveChanged('co-a', () => { count++ }, reads)
  emit('records', 'co-a')
  assert.equal(count, 1)
  emit('notifications', 'co-a')
  assert.equal(count, 2)
  emit('records', 'co-b')
  assert.equal(count, 2)
  stop()
  assert.equal(listeners.records.size + listeners.notifications.size, 0)
})
