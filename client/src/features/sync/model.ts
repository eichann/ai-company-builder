// What the member is told after 「サーバーと同期」, from what sync reported.
import type { GitResult } from '../../../shared/ipc-contract'

export interface SyncNotice {
  type: 'success' | 'warning' | 'error'
  message: string
  /** Where sync kept the member's version (offered as 「フォルダを開く」 / 「履歴を見る」). */
  backupPath?: string
  /** About work that stopped being where it was: no later notice replaces it unseen (lastingNotice.ts). */
  mustSee?: boolean
}

const some = (list: readonly unknown[] | undefined) => !!list && list.length > 0

/** Where the member's files went, or what they lost, in ways the plain sync message would hide. */
function movedSomething(result: GitResult): boolean {
  return some(result.recoveredFiles) ||
    some(result.lostPrivateFolders) ||
    some(result.reservedPathFiles) ||
    !!result.madePublicBackupPath ||
    some(result.movedAsideFolders) ||
    some(result.nestedRepoBackupFiles) ||
    some(result.largeFileBackupFiles) ||
    !!result.privateFolders?.some(folder => folder.setAside)
}

function movedTo(result: GitResult): string | undefined {
  return result.recoveryBackupPath ||
    result.reservedPathBackupPath ||
    result.madePublicBackupPath ||
    result.movedAsideBackupPath ||
    result.nestedRepoBackupPath ||
    result.largeFileBackupPath ||
    result.privateFolders?.find(folder => folder.setAside && folder.backupPath)?.backupPath ||
    result.backupPath
}

/** The notice for a finished sync; a restored department is said whichever notice it is. */
export function syncNoticeFor(result: GitResult): SyncNotice {
  const notice = { ...noticeFor(result), ...(some(result.recoveredFiles) ? { mustSee: true } : {}) }
  const restored = result.restoredFolders ?? []
  if (!result.success || restored.length === 0 || notice.message.includes('部署フォルダを復元しました')) return notice
  return { ...notice, type: 'warning', message: `${notice.message}\n部署フォルダを復元しました: ${restored.join(', ')}` }
}

/** The first thing sync had to set aside wins. */
function noticeFor(result: GitResult): SyncNotice {
  if (!result.success) {
    const backupPath = movedTo(result)
    return { type: 'error', message: result.error || '同期に失敗しました', ...(backupPath ? { backupPath } : {}) }
  }
  if (movedSomething(result)) {
    // Every one of these writes its sentence into the message (git-sync.ts withNotes).
    return { type: 'warning', message: result.message || '同期しましたが、移動したファイルがあります。バックアップの履歴を確認してください。', backupPath: movedTo(result) }
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

/** Sync did something to the member's files that they have to hear about. */
function setSomethingAside(result: GitResult): boolean {
  return !!result.hadConflicts ||
    movedSomething(result) ||
    some(result.restoredProtectedFiles) ||
    some(result.restoredWriteDeniedFiles) ||
    some(result.untrackedPersonalFiles) ||
    some(result.outsideCheckoutFiles) ||
    some(result.restoredFolders) ||
    some(result.ignoredLargeFiles) ||
    some(result.excludedNestedRepos)
}

/** A clean success hides itself after 3 s; anything sync set aside stays until dismissed. */
export function syncNoticeHidesItself(result: GitResult): boolean {
  return !!result.success && !setSomethingAside(result)
}

/**
 * What an automatic send shows: a plain success nothing, a failure once per
 * kind (`showFailure`), and whatever sync set aside always, also on a failed
 * run: nobody pressed anything, so this notice is the only way to hear of it.
 */
export function autoSyncNoticeFor(result: GitResult, showFailure: boolean): SyncNotice | null {
  return setSomethingAside(result) || (!result.success && showFailure) ? syncNoticeFor(result) : null
}
