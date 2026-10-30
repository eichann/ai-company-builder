// What the member is told after 「サーバーと同期」, from what sync reported.
import type { syncCompany } from './api'

export type SyncResult = Awaited<ReturnType<typeof syncCompany>>

export interface SyncNotice {
  type: 'success' | 'warning' | 'error'
  message: string
  /** Where sync kept the member's version (offered as 「フォルダを開く」 / 「履歴を見る」). */
  backupPath?: string
}

/** The notice for a finished sync; the first thing sync had to set aside wins. */
export function syncNoticeFor(result: SyncResult): SyncNotice {
  if (!result.success) {
    return { type: 'error', message: result.error || '同期に失敗しました' }
  }
  if (result.restoredProtectedFiles && result.restoredProtectedFiles.length > 0) {
    // Protected agent config was put back to the server's version
    return {
      type: 'warning',
      message: result.message || `管理者だけが変更できるファイルをサーバーの状態に戻しました: ${result.restoredProtectedFiles.join(', ')}`,
      backupPath: result.protectedBackupPath || result.backupPath
    }
  }
  if (result.restoredWriteDeniedFiles && result.restoredWriteDeniedFiles.length > 0) {
    // Files in a folder the member may not edit were put back to the server's version
    return {
      type: 'warning',
      message: result.message || `編集する権限がないフォルダのファイルを元に戻しました: ${result.restoredWriteDeniedFiles.join(', ')}`,
      backupPath: result.writeDeniedBackupPath || result.backupPath
    }
  }
  if (result.untrackedPersonalFiles && result.untrackedPersonalFiles.length > 0) {
    // .personal/ files are never shared; sync untracked them (kept on disk)
    return {
      type: 'warning',
      message: result.message || `個人用フォルダ（.personal）のファイルを共有対象から外しました: ${result.untrackedPersonalFiles.join(', ')}`,
      backupPath: result.backupPath
    }
  }
  if (result.outsideCheckoutFiles && result.outsideCheckoutFiles.length > 0) {
    // Files created in a folder this computer has not downloaded were set aside, not shared
    return {
      type: 'warning',
      message: result.message || `ダウンロードしていないフォルダに作られたファイルを .backups に保存しました: ${result.outsideCheckoutFiles.join(', ')}`,
      backupPath: result.outsideCheckoutBackupPath || result.backupPath
    }
  }
  if (result.hadConflicts) {
    return {
      type: 'warning',
      message: result.message || `${result.conflictFiles?.length || 0}ファイルが競合しました。サーバー版で上書きしました。`,
      backupPath: result.backupPath
    }
  }
  if (result.restoredFolders && result.restoredFolders.length > 0) {
    return {
      type: 'warning',
      message: `部署フォルダを復元しました: ${result.restoredFolders.join(', ')}`
    }
  }
  if (result.ignoredLargeFiles && result.ignoredLargeFiles.length > 0) {
    return {
      type: 'warning',
      message: `${result.ignoredLargeFiles.length}個の大容量ファイル（100MB以上）を同期対象外にしました: ${result.ignoredLargeFiles.slice(0, 3).join(', ')}${result.ignoredLargeFiles.length > 3 ? '...' : ''}`
    }
  }
  if (result.excludedNestedRepos && result.excludedNestedRepos.length > 0) {
    return {
      type: 'warning',
      message: `別の場所から取り込んだフォルダを、共有せずこのPCだけに置きました（${result.excludedNestedRepos.length}件）: ${result.excludedNestedRepos.slice(0, 3).join(', ')}${result.excludedNestedRepos.length > 3 ? '...' : ''}`
    }
  }
  return {
    type: 'success',
    message: result.message || '同期が完了しました'
  }
}

/** A clean success hides itself after 3 s; anything sync set aside stays until dismissed. */
export function syncNoticeHidesItself(result: SyncResult): boolean {
  const hasWarnings = result.hadConflicts ||
    (result.restoredProtectedFiles && result.restoredProtectedFiles.length > 0) ||
    (result.restoredWriteDeniedFiles && result.restoredWriteDeniedFiles.length > 0) ||
    (result.untrackedPersonalFiles && result.untrackedPersonalFiles.length > 0) ||
    (result.outsideCheckoutFiles && result.outsideCheckoutFiles.length > 0) ||
    (result.nestedRepoBackupFiles && result.nestedRepoBackupFiles.length > 0) ||
    (result.restoredFolders && result.restoredFolders.length > 0) ||
    (result.ignoredLargeFiles && result.ignoredLargeFiles.length > 0) ||
    (result.excludedNestedRepos && result.excludedNestedRepos.length > 0)
  return !!result.success && !hasWarnings
}
