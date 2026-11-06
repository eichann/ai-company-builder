// The title bar's 「あなたの番」 and bell's access to the main process (src/shared/ipc/electron-api.ts):
// small ports, each function taking its port last (default window.electronAPI).
// Main asks the company server with the member's session.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import { NO_NOTICES, type NoticesState } from '../../../shared/notifications-app'

/** Following a company's turn and notices: main checks with the server (start, every 5 minutes, signals). */
export type NoticesReads = ElectronPort<'watchNotifications' | 'getNotificationsState' | 'onNotificationsChanged' | 'getNotificationSettings'>
/** A Mac notification that opens the task list was clicked (the morning's 「今日のあなたの番」). */
export type NoticesClicks = ElectronPort<'onNotificationsOpenTasks'>

/** `listener` hears when this company's task list should be shown (a clicked Mac notification). */
export function subscribeOpenTasks(companyId: string, listener: () => void, clicks: NoticesClicks = window.electronAPI): () => void {
  const stop = clicks.onNotificationsOpenTasks(e => { if (e.companyId === companyId) listener() })
  return () => { stop?.() }
}

/** The member's own read state and kind switches (kept on the server, shared by their PCs). */
export type NoticesWrites = ElectronPort<'markNotificationsRead' | 'setNotificationSetting'>

/**
 * Follow one company: main starts checking it, and `listener` hears that its
 * state may have changed (also once at the start). Unsubscribing stops it.
 */
export function subscribeNotices(companyId: string, listener: () => void, reads: NoticesReads = window.electronAPI): () => void {
  let active = true
  const stop = reads.onNotificationsChanged(change => { if (active && change.companyId === companyId) listener() })
  void Promise.resolve(reads.watchNotifications(companyId)).catch(() => {}).then(() => { if (active) listener() })
  return () => {
    active = false
    stop?.()
    void Promise.resolve(reads.watchNotifications(null)).catch(() => {})
  }
}

export async function getNoticesState(companyId: string, reads: NoticesReads = window.electronAPI): Promise<NoticesState> {
  return (await reads.getNotificationsState(companyId)) ?? NO_NOTICES
}

export function markNoticesRead(companyId: string, ids: string[] | 'all', writes: NoticesWrites = window.electronAPI) {
  return writes.markNotificationsRead(companyId, ids)
}

export function getNoticeSettings(companyId: string, reads: NoticesReads = window.electronAPI) {
  return reads.getNotificationSettings(companyId)
}

/**
 * ［元に戻す］ on a notice that offers it (`UNDOABLE_NOTIFICATION_KINDS`: `replied_done` — the AI completed
 * a task their reply finished; `mail_left_inbox` / `mail_archived` — the inbox closed a mail archived in
 * Gmail, or archived it there; inbox.md): the undo of exactly that entry, at its version — the server
 * refuses when something changed since.
 */
export type NoticeUndo = ElectronPort<'undoTaskAction'>
export function undoNoticedChange(companyId: string, recordId: string, version: number, writes: NoticeUndo = window.electronAPI) {
  return writes.undoTaskAction(companyId, recordId, version, version)
}

/**
 * ［元に戻す］ on 「AI が変えました」 (`ai_changed`): the AI's plugin operation written back through the
 * member's session (`pluginOperations:undo`, 「変更前の値を書き戻す」 / 「作ったものを取り消す」); the server
 * re-checks everything (the assignee, HubSpot unchanged since, the field still automatic).
 */
export type NoticeOperationUndo = ElectronPort<'undoPluginOperation'>
export async function undoNoticedAiChange(companyId: string, pluginId: string, operationId: string, writes: NoticeOperationUndo = window.electronAPI): Promise<{ success: true } | { success: false; error: string }> {
  const r = await writes.undoPluginOperation(companyId, pluginId, operationId)
  if (r?.success && r.operation.state === 'applied') return { success: true }
  if (r?.success) return { success: false, error: '元に戻せたか分かりません。HubSpot で確かめてください。' }
  return { success: false, error: r?.error ?? '元に戻せませんでした。そのあとに変わったかもしれません。' }
}

export function setNoticeSetting(companyId: string, kind: string, on: boolean, writes: NoticesWrites = window.electronAPI) {
  return writes.setNotificationSetting(companyId, kind, on)
}
