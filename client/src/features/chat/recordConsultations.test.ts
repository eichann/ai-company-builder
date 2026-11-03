import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consultationsByRecord } from './recordConsultationsStore'
import type { ChatSessionSummary } from '../../../shared/chat-history'

const session = (id: string, updatedAt: string, topicRecordId?: string): ChatSessionSummary =>
  ({ id, companyId: 'c', title: id, messageCount: 2, preview: '', createdAt: updatedAt, updatedAt, ...(topicRecordId ? { topicRecordId } : {}) })

test('a record lists only the consultations whose main topic is that record, newest first', () => {
  const map = consultationsByRecord([session('old', '2026-11-01', 'deal-1'), session('none', '2026-11-04'), session('new', '2026-11-03', 'deal-1'), session('task', '2026-11-02', 'task-1')])
  assert.deepEqual(map.get('deal-1')?.map(c => c.sessionId), ['new', 'old'])
  assert.deepEqual(map.get('task-1')?.map(c => c.sessionId), ['task'])
  assert.equal(map.size, 2)
})
