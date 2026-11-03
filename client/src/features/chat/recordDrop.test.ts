import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composerDragOf, dropFrameText, switchTopicQuestion, topicOnDrop, withPendingRecord } from './recordDrop'
import { FILE_PATHS_DRAG_TYPE, startRecordDrag } from '../../shared/lib/dragTypes'

/** A DataTransfer as the browser shows it while dragging: types lower-cased, data unreadable. */
function dragging(put: (d: DataTransfer) => void): Pick<DataTransfer, 'types'> {
  const types: string[] = []
  put({ setData: (k: string) => { types.push(k) }, effectAllowed: 'uninitialized' } as unknown as DataTransfer)
  return { types: types.map(t => t.toLowerCase()) } as unknown as Pick<DataTransfer, 'types'>
}

// The frame must say what the drop will do: a file is read by the AI (unchanged), a record makes
// the consultation about it — in the record's own word, which is only readable from the drag types.
test('the drop frame says what happens, per kind of thing dragged', () => {
  const file = composerDragOf(dragging(d => d.setData(FILE_PATHS_DRAG_TYPE, '[]')))
  assert.deepEqual(file, { kind: 'file' })
  assert.equal(dropFrameText(file!), 'ここに落とすと、AI が読みます')
  assert.equal(dropFrameText(composerDragOf({ types: ['Files'] } as unknown as DataTransfer)!), 'ここに落とすと、AI が読みます')

  const task = composerDragOf(dragging(d => startRecordDrag(d, { id: 'task-0001ab', title: '見積を直す' })))
  assert.equal(dropFrameText(task!), 'ここに落とすと、このやることの相談になります')
  const deal = composerDragOf(dragging(d => startRecordDrag(d, { id: 'deal-0001ab', title: 'A社', word: '案件' })))
  assert.equal(dropFrameText(deal!), 'ここに落とすと、この案件の相談になります')
  const meeting = composerDragOf(dragging(d => startRecordDrag(d, { id: 'meeting-0001ab', title: '定例' })))
  assert.equal(dropFrameText(meeting!), 'ここに落とすと、この会議の記録の相談になります')

  assert.equal(composerDragOf({ types: ['text/plain'] } as unknown as DataTransfer), null)
})

// Dropping never silently replaces what a consultation is about: a different topic is asked first.
test('a record dropped sets the topic when there is none, keeps the same one, and asks before switching', () => {
  assert.equal(topicOnDrop(null, 'task-0001ab'), 'set')
  assert.equal(topicOnDrop('task-0001ab', 'task-0001ab'), 'same')
  assert.equal(topicOnDrop('task-0001ab', 'deal-0001ab'), 'ask')
  assert.equal(switchTopicQuestion('見積を直す', 'A社'), '『見積を直す』の相談を『A社』の相談に切り替えますか？')
})

// The same record dropped twice is read once; main reads at most five per message.
test('dropped records wait once each, at most five', () => {
  const r = (n: number) => ({ id: `task-00000${n}`, title: `t${n}`, word: 'やること' })
  let list = withPendingRecord([], r(1))
  list = withPendingRecord(list, r(1))
  assert.deepEqual(list.map(x => x.id), ['task-000001'])
  for (let n = 2; n <= 7; n++) list = withPendingRecord(list, r(n))
  assert.deepEqual(list.map(x => x.id), ['task-000003', 'task-000004', 'task-000005', 'task-000006', 'task-000007'])
})
