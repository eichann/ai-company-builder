// Why a backup folder exists: the `reason` the app writes into each backup's
// `_metadata.json` (`.backups/` and the private folders' backups), and the
// plain words the backup history shows for it (BackupHistorySlideOver).
// Every writer types its reason as `BackupReason`, so a new kind of backup
// cannot be written without a label here (the record below is total).
// tests/backup-reasons.test.ts checks the labels are the member's words.

export const BACKUP_REASONS = [
  'conflict',
  'protected_config',
  'write_denied',
  'editor_overwrite',
  'editor_edits',
  'editor_left_unsaved',
  'before_restore',
  'before_revert',
  'before_recovery',
  'nested_repo_overwrite',
  'large_file_overwrite',
  'reserved_path',
  'outside_checkout',
  'made_public',
  'private_folder_existing',
  'private_folder_excluded',
  'skill_edit',
  'skill_outputs',
  /** backup:list's answer for a backup without metadata (an older app's, or one cut off). */
  'unknown',
] as const

export type BackupReason = typeof BACKUP_REASONS[number]

const LABELS: Record<BackupReason, string> = {
  conflict: 'ほかの人も同じところを変えていたため、サーバーの版を残したときのあなたの版',
  protected_config: '管理者だけが変更できるファイルを戻す前の、あなたの版',
  write_denied: '編集する権限がないフォルダのファイルを戻す前の、あなたの版',
  editor_overwrite: '上書き保存の前の内容',
  editor_edits: '届いた版を採用する前の、あなたの編集',
  editor_left_unsaved: '保存できないまま進んだときの、あなたの編集',
  before_restore: '復元の前の内容',
  before_revert: '「元に戻す」の前の内容',
  before_recovery: '同期が途中で止まっていた間の内容',
  nested_repo_overwrite: '共有していないフォルダに、ほかの人が同じ名前のファイルを共有したときのこのPCの版',
  large_file_overwrite: 'このPCだけに置いていた大きなファイル（ほかの人が同じ場所に共有したため）',
  reserved_path: '使えない名前のフォルダにあったファイル',
  outside_checkout: 'ダウンロードしていないフォルダに作られていたファイル',
  made_public: '非公開でなくなったフォルダの、まだ共有していなかった変更',
  private_folder_existing: '非公開フォルダの場所に前からあったファイル',
  private_folder_excluded: 'ダウンロードしないにした非公開フォルダの、同期しないファイル',
  skill_edit: '「会社の版に戻す」の前の Skill',
  skill_outputs: 'Skill から外した成果物',
  unknown: 'その他のバックアップ',
}

/** The backup history's words for a reason; one this app does not know (a newer app's) reads as 「その他」, never the code. */
export function backupReasonLabel(reason: string): string {
  return (LABELS as Record<string, string | undefined>)[reason] ?? LABELS.unknown
}
