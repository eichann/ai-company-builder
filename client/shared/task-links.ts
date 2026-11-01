/**
 * 「やることにつなぐ…」 (records.md "Linking files later"): the file tree's
 * right-click item that links a company file to one of the member's open
 * tasks. Pure: main (features/tasks, with the session) and the renderer use it.
 */

/** One open task the member may choose (they request it, do it, review it, or it is their turn). */
export interface TaskChoice {
  id: string
  title: string
  state: string | null
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, or null. */
  due: string | null
  version: number
}

export type OpenTasksResult =
  | { success: true; tasks: TaskChoice[] }
  | { success: false; error: string }

export type LinkFileResult =
  | { success: true; message: string }
  | { success: false; error: string }

export const TASKS_OFFLINE_TEXT = 'サーバーに接続できないため、いまはやることを読み込めません（オフラインの可能性があります）。'
export const TASKS_OFF_TEXT = 'この会社では、やること（タスク）の記録がまだ使われていません。'

/** The person fields that make a task the member's own (whoever reads it may link, but these are what they work on). */
export const TASK_PEOPLE_FIELDS = ['assignee', 'requested_by', 'reviewer', 'next_actor'] as const

/** Tasks whose title holds `query` (NFC, A–Z case-insensitive), soonest due first, undated last. */
export function filterTaskChoices(tasks: TaskChoice[], query: string): TaskChoice[] {
  const fold = (s: string) => s.normalize('NFC').replace(/[A-Z]/g, c => c.toLowerCase())
  const q = fold(query.trim())
  const hits = q === '' ? tasks : tasks.filter(t => fold(t.title).includes(q))
  return [...hits].sort((a, b) => (a.due ?? '￿').localeCompare(b.due ?? '￿') || a.title.localeCompare(b.title, 'ja'))
}

/** 「11/5」 or 「11/5 15:00」 of a due value ('' when none). */
export function dueLabel(due: string | null): string {
  const m = due ? /^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(due) : null
  if (!m) return ''
  return `${Number(m[1])}/${Number(m[2])}${m[3] ? ` ${m[3]}` : ''}`
}

/** The result line: 「見積.md」を「提案書を作る」につなぎました. */
export function linkedMessage(path: string, taskTitle: string, already: boolean): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return already ? `「${name}」はもう「${taskTitle}」につながっています。` : `「${name}」を「${taskTitle}」につなぎました。`
}
