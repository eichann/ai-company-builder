// 「やることにつなぐ…」 (records.md "Linking files later"):
//   tasks:open      the member's open tasks to choose from
//   tasks:linkFile  link a company file to the chosen task
// Everything goes with the member's session, which stays in main.

import type { IpcRegistrar } from '../../ipc/registrar'
import type { TaskLinks } from './links'

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1000
const invalid = { success: false, error: '入力が正しくありません。' } as const

export function registerTasksIpc(ipc: IpcRegistrar, tasks: TaskLinks): void {
  ipc.handle('tasks:open', (_event, companyId) => (str(companyId) ? tasks.openTasks(companyId) : invalid))
  ipc.handle('tasks:linkFile', (_event, companyId, taskId, companyPath, seenVersion) =>
    str(companyId) && str(taskId) && str(companyPath) && typeof seenVersion === 'number'
      ? tasks.linkFile(companyId, taskId, companyPath, seenVersion) : invalid)
}
