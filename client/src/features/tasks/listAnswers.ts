// Which of the task list's read answers the screen takes (`useTaskList`). Reads overlap (a records
// signal every 250 ms, a press, the 2-minute look) and answer in any order: an answer is taken when
// it is newer than the one shown — never one older than it (a task just completed must not come
// back), and never "only the newest read" (under a stream of signals every answer would already be
// outdated when it lands, and the list would freeze).
import type { TaskListData, TaskListResult } from '../../../shared/tasks'

export interface TaskListState {
  companyId: string | undefined
  data: TaskListData | null
  error: string | null
  /** The ticket of the read whose data is shown (0: none yet). */
  shown: number
}

/** `ticket`: the read's number, counted up as reads begin (one count for every company, so a late answer of the company left behind is older too). */
export function nextListState(state: TaskListState, companyId: string, ticket: number, answer: TaskListResult): TaskListState {
  const sameCompany = state.companyId === companyId
  // An answer older than what is shown never replaces it (nor its error: the shown data is newer) —
  // also one of the company shown before (it would hide this company's list).
  if (ticket <= state.shown) return state
  if (answer.success) return { companyId, data: answer.data, error: null, shown: ticket }
  // A failed read keeps the last good list; a later-arriving older success may still replace it.
  return { companyId, data: sameCompany ? state.data : null, error: answer.error, shown: state.shown }
}
