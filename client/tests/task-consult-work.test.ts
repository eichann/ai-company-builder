// 「この作業をする」 (4b-4 PR6, owner memo 「4b-4 挟む部分」 F-6 / U9 / W1): a consultation that starts the work of a やること a
// scheduled job made, fixed to when it was made — a Friday やること pressed on Monday still does Friday's week — and to the
// meeting it links; it names the task by id, never pastes its contents, and never lets the AI send on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskConsultFirstMessage, taskConsultPurposeTitle, weekOfMaking } from '../shared/task-consult'

const TASK = { id: 'task-' + 'a'.repeat(32), title: '今週の定例レポートを作る', madeAt: '2026-11-27T00:05:00.000Z' }

test('the week is the one the やること was made in (company time), not the week it is pressed in', () => {
  // 2026-11-27 09:05 in Tokyo is a Friday: its week is 11/23 (Mon) – 11/29 (Sun).
  assert.deepEqual(weekOfMaking(TASK.madeAt), { from: '2026-11-23', to: '2026-11-29', madeOn: '2026-11-27' })
  // Late Sunday evening UTC is already Monday in Tokyo: the next week.
  assert.deepEqual(weekOfMaking('2026-11-29T16:00:00.000Z'), { from: '2026-11-30', to: '2026-12-06', madeOn: '2026-11-30' })
  assert.equal(weekOfMaking('not a time'), null)
  const message = taskConsultFirstMessage(TASK, true, 'work')
  assert.match(message, /11月23日（月）〜11月29日（日）の週/)
  assert.match(message, /今日の週ではありません/)
})

test('it starts the work, names the task by id only, keeps to the linked meeting and never sends on its own', () => {
  const message = taskConsultFirstMessage(TASK, true, 'work')
  assert.match(message, /作業を、今から始めてください/)
  assert.match(message, new RegExp(`records_get で ${TASK.id}`))
  assert.match(message, /その会議だけが対象/)
  assert.match(message, /メールを送る・ファイルを消す・ほかの人に見せることは、私に確かめてから/)
  assert.equal(taskConsultPurposeTitle(TASK.title, 'work'), '今週の定例レポートを作る の作業')
  // Without a known time it still says the week is fixed, never "this week".
  assert.match(taskConsultFirstMessage({ id: TASK.id, title: TASK.title }, false, 'work'), /作られた日で決まっています/)
})
