import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONSULTATION_DRAG_TYPE, draggedConsultation, draggedRecord, dropEffectAllowed, FILE_TREE_EFFECT_ALLOWED, isLinkableDrag, RECORD_DRAG_TYPE, startConsultationDrag, startRecordDrag } from './dragTypes'

// A file dragged from the tree onto a record card's 「つながっているもの」 (dropEffect `link`) was
// silently refused when the tree allowed `move` only: the browser fires no drop event.
test('a file tree drag can be dropped to link and to move', () => {
  assert.equal(dropEffectAllowed(FILE_TREE_EFFECT_ALLOWED, 'link'), true)
  assert.equal(dropEffectAllowed(FILE_TREE_EFFECT_ALLOWED, 'move'), true)
})

/** A DataTransfer stand-in: what one source puts on, the other reads off. */
function transfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    effectAllowed: 'uninitialized',
    setData: (k: string, v: string) => { data.set(k, v) },
    getData: (k: string) => data.get(k) ?? '',
    get types() { return [...data.keys()] },
  } as unknown as DataTransfer
}

// A record or consultation dragged onto a record links it; a malformed id must never be sent on.
test('a record or consultation drag is read back as what was put on it, and only links', () => {
  const r = transfer()
  startRecordDrag(r, { id: 'task-0001ab', title: '見積を直す' })
  assert.deepEqual(draggedRecord(r), { id: 'task-0001ab', title: '見積を直す' })
  assert.equal(draggedConsultation(r), null)
  assert.equal(r.effectAllowed, 'link')
  assert.equal(isLinkableDrag(r), true)
  const c = transfer()
  startConsultationDrag(c, { sessionId: 'chat-1', title: '相談', topicRecordId: 'task-0001ab' })
  assert.deepEqual(draggedConsultation(c), { sessionId: 'chat-1', title: '相談', topicRecordId: 'task-0001ab' })
  assert.equal(draggedRecord(c), null)
})

test('a malformed record id, session id or topic is not a drag', () => {
  const r = transfer()
  r.setData(RECORD_DRAG_TYPE, JSON.stringify({ id: '../task-0001ab', title: 'x' }))
  assert.equal(draggedRecord(r), null)
  r.setData(CONSULTATION_DRAG_TYPE, JSON.stringify({ sessionId: 'a/b', title: 'x' }))
  assert.equal(draggedConsultation(r), null)
  r.setData(CONSULTATION_DRAG_TYPE, JSON.stringify({ sessionId: 'chat-1', title: 'x', topicRecordId: '../x' }))
  assert.deepEqual(draggedConsultation(r), { sessionId: 'chat-1', title: 'x' })
  r.setData(RECORD_DRAG_TYPE, '{not json')
  assert.equal(draggedRecord(r), null)
  assert.equal(isLinkableDrag(transfer()), false)
})

test('dropEffectAllowed follows the browser rule', () => {
  assert.equal(dropEffectAllowed('move', 'link'), false)
  assert.equal(dropEffectAllowed('copyLink', 'link'), true)
  assert.equal(dropEffectAllowed('all', 'copy'), true)
})
