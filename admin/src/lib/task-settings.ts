/**
 * Words and small helpers of the task settings page (やることの一覧の設定).
 * The rules themselves (validation, defaults, the reply 目安) are
 * shared/core/task-settings.ts; this file only says them in plain Japanese.
 */
import { dayOfWeek } from '../../../shared/core/business-days'
import { TASK_SETTINGS_LIMITS, type TaskSettings } from '../../../shared/core/task-settings'

export { TASK_SETTINGS_LIMITS }
export { isCalendarDate, japaneseHolidayName } from '../../../shared/core/business-days'
export { isCutoff, parseTaskSettings, replyTarget } from '../../../shared/core/task-settings'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const

/** `2026-11-04` → `11月4日（水）`. */
export function formatDay(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${m}月${d}日（${WEEKDAYS[dayOfWeek(date)]}）`
}

/** A copy that can be edited without touching the saved one. */
export function cloneSettings(s: TaskSettings): TaskSettings {
  return {
    taskListDepartmentIds: s.taskListDepartmentIds ? [...s.taskListDepartmentIds] : null,
    reply: { ...s.reply },
    autoRun: { ...s.autoRun },
    readIncoming: { ...s.readIncoming },
    acceptance: { ...s.acceptance },
    companyHolidays: s.companyHolidays.map((h) => ({ ...h })),
    bundleName: s.bundleName,
  }
}

/** Same settings (holidays compared as sorted by date, department order ignored). */
export function sameSettings(a: TaskSettings, b: TaskSettings): boolean {
  const norm = (s: TaskSettings) => ({
    ...s,
    taskListDepartmentIds: s.taskListDepartmentIds ? [...s.taskListDepartmentIds].sort() : null,
    companyHolidays: [...s.companyHolidays].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)),
  })
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}
