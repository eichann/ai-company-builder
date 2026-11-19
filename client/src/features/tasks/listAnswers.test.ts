// Which task-list answers the screen takes (useTaskList → nextListState). Guards: an answer older
// than the one shown never replaces it (a completed task does not come back); under a stream of
// overlapping reads every newer answer is still taken (the list never freezes); a failed newest
// read does not cost an older good answer; another company's answer starts over.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextListState, type TaskListState } from './listAnswers'
import type { TaskListData, TaskListResult } from '../../../shared/tasks'

const list = (name: string): TaskListResult => ({ success: true, data: { available: true, listDepartmentIds: null, items: [], me: name } as TaskListData })
const empty: TaskListState = { companyId: 'co', data: null, error: null, shown: 0 }
const shownOf = (s: TaskListState) => s.data?.me ?? null

test('an older read answering after a newer one never puts the older list back', () => {
  let s = nextListState(empty, 'co', 2, list('after the press'))
  s = nextListState(s, 'co', 1, list('before the press'))
  assert.equal(shownOf(s), 'after the press')
})

test('a stream of overlapping reads (each begun before the previous answered): every newer answer is taken, the list keeps moving', () => {
  let s = empty
  // Reads begin 250 ms apart and each takes longer than that: each answer lands while a newer read is on its way.
  for (let ticket = 1; ticket <= 5; ticket++) {
    s = nextListState(s, 'co', ticket, list(`read ${ticket}`))
    assert.equal(shownOf(s), `read ${ticket}`)
  }
})

test('the newest read failing does not cost an older good answer that lands after it', () => {
  let s = nextListState(empty, 'co', 1, list('first'))
  s = nextListState(s, 'co', 3, { success: false, offline: true, error: 'つながりません' })
  assert.equal(shownOf(s), 'first')
  s = nextListState(s, 'co', 2, list('second'))
  assert.equal(shownOf(s), 'second')
  assert.equal(s.error, null)
})

test('another company\'s answer replaces the list whatever its number (its own reads start over)', () => {
  let s = nextListState(empty, 'co', 5, list('A'))
  s = nextListState(s, 'co-b', 4, list('B'))
  assert.equal(s.companyId, 'co-b')
  assert.equal(shownOf(s), 'B')
})
