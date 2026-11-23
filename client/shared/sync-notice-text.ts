// What sync tells the member when it could not reach the server or kept the
// server's version of a file: plain Japanese, no Git words (members have no Git
// vocabulary: CLAUDE.md). Main writes these into the sync result (sync/git-sync.ts);
// the renderer's notice uses the same ones as fallbacks (features/sync/model.ts).
// tests/sync-notice-text.test.ts reads every export of this file for Git words.

/** The title bar button that shows what sync kept (BackupHistorySlideOver). */
export const BACKUP_HISTORY_BUTTON = '［バックアップ履歴］'

/** Where the member finds their own version of a file the server's version replaced. */
export const YOUR_VERSION_IN_BACKUP_HISTORY = `あなたが変えていた版は、タイトルバーの${BACKUP_HISTORY_BUTTON}に保存してあります。`

/**
 * The member's work is committed on this computer but did not reach the server
 * (offline, the server down, a teammate's push in between): the next sync sends it.
 */
export const PUSH_FAILED_MESSAGE = 'このPCには保存しましたが、サーバーに届けられませんでした。インターネットにつながっているか確かめて、もう一度［サーバーと同期］を押してください。'

/** Refused files were put back, then the rest did not reach the server. */
export function refusedThenPushFailedMessage(refusedWhat: string, toServerVersion: boolean): string {
  return `${refusedWhat}ファイルを${toServerVersion ? 'サーバーの状態に戻しました' : '元に戻しました'}。${PUSH_FAILED_MESSAGE}`
}

/**
 * Nothing to send, and neither the fetch nor the pull reached the server: the
 * member must not read 「同期が完了しました」 when nothing was checked.
 */
export const SERVER_UNREACHABLE_MESSAGE = 'サーバーにつながらなかったため、同期できませんでした。このPCの内容はそのまま残っています。インターネットにつながっているか確かめて、もう一度［サーバーと同期］を押してください。'

/**
 * Files someone else changed at the same place: the server's version was kept
 * (`kept`), or the server had deleted it and the deletion was followed (`deleted`).
 */
export function sameFileChangedMessage(kept: number, deleted: number): string {
  const parts: string[] = []
  if (kept > 0) parts.push(`${kept}件のファイルは、ほかの人も同じところを変えていたため、サーバーの版を残しました。`)
  if (deleted > 0) parts.push(`${deleted}件のファイルは、あなたが変えている間にほかの人が削除していたため、削除しました。`)
  parts.push(YOUR_VERSION_IN_BACKUP_HISTORY)
  return parts.join('')
}

/** Sync could not put the server's version in place: everything was undone, the work stays here. */
export const SAME_FILE_UNRESOLVED_MESSAGE = `ほかの人も同じところを変えていたファイルを、自動でそろえられませんでした。あなたの変更はこのPCに残っています。あなたが変えていた版は、タイトルバーの${BACKUP_HISTORY_BUTTON}にも保存してあります。`
