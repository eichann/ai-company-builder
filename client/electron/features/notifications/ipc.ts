// The title bar's 「あなたの番 N」 and the bell (知らせ, .claude/rules/notifications.md "The app"):
//   notifications:watch       the company on screen (starts the 5-minute check)
//   notifications:state       its turn and notices, as main last read them (no session, ever)
//   notifications:markRead    notices read (their ids, or 'all')
//   notifications:settings    the kinds the member turned on / off
//   notifications:setSetting  turn one kind on or off
// Everything goes with the member's session, which stays in main.

import type { IpcRegistrar } from '../../ipc/registrar'
import type { NotificationsWatcher } from './watcher'

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const invalid = { success: false, error: '入力が正しくありません。' } as const

export function registerNotificationsIpc(ipc: IpcRegistrar, watcher: NotificationsWatcher): void {
  ipc.handle('notifications:watch', async (_event, companyId) => {
    if (companyId !== null && !str(companyId)) return
    await watcher.watch(companyId)
  })
  ipc.handle('notifications:state', (_event, companyId) => watcher.state(str(companyId) ? companyId : ''))
  ipc.handle('notifications:markRead', (_event, companyId, ids) => (str(companyId) ? watcher.markRead(companyId, ids) : invalid))
  ipc.handle('notifications:settings', (_event, companyId) => (str(companyId) ? watcher.settings(companyId) : invalid))
  ipc.handle('notifications:setSetting', (_event, companyId, kind, on) =>
    (str(companyId) && str(kind) ? watcher.setSetting(companyId, kind, on) : invalid))
}
